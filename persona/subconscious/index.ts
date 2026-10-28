/** Serial dream work merges waiting handoffs and resumes unconfirmed materials. */
import type { ToolSpec } from 'cortico/core/types.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, withoutPastReasoning } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { CoreApi, Logger, TimerEntry, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import type { BotConfig } from '../../index.ts';
import { nowIso } from 'cortico/core/util.ts';
import { closeDanglingCalls } from 'cortico/core/truncate.ts';
import { cleanSnapshot } from '../context-material.ts';
import { dreamConfig } from '../config.ts';
import { DreamMaterials, prepareDreamInput, writeJson } from './materials.ts';
import { dreamOrientation, dreamTask } from './prompts.ts';
import { readDreamUsage, usageOffset, type DreamUsage } from './usage.ts';
import type { ReadReview } from '../state-review.ts';

export const DREAM = 'dream';
export interface DreamDeps {
  cfg: BotConfig; core: CoreApi; dreamTools: () => ToolDef[]; toolUsageText: () => string;
  log: Logger; onEmergence: (text: string) => void;
  dataDir?: string; memoryDir?: string; semanticState?: () => string; deferStateMigration?: () => boolean; onEnd?: () => void;
  reviewTools?: (tools: ToolDef[], readReview: ReadReview) => ToolDef[];
}
export interface DreamRun {
  id: string; startedAt: string; endedAt?: string; elapsedMs?: number;
  retryOf?: string; retryAttempt?: number;
  status: 'running' | 'complete' | 'partial' | 'interrupted';
  materialIds: string[]; processedMaterials: string[]; pendingTasks: string[];
  inputTokens?: number; inputBytes?: number; backgroundTokens?: number; stateTokens?: number; included?: number; omitted?: number;
  tools: Array<{ name: string; path?: string; elapsedMs: number; resultChars: number; failed: boolean }>;
  usage?: DreamUsage; error?: string;
}
export interface DreamStatus { dreaming: boolean; queued: number; pendingMaterials: number; pendingTasks: string[]; runs: DreamRun[]; retryAt: string | null }
interface DreamContext { system: ContextRecord[]; background: string }
interface Waiting extends DreamContext { resolve: () => void }
interface Closure { status: 'complete' | 'partial'; processedMaterials: string[]; pendingTasks: string[]; text: string }

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export class Dream {
  private readonly materials: DreamMaterials;
  private readonly dir?: string;
  private waiting: Waiting[] = [];
  private dreaming = false;
  private runs: DreamRun[] = [];
  private pendingTasks: string[] = [];
  private activeTasks = new Set<string>();
  private lastContext?: DreamContext;
  private stopped = false;
  private retryAt: string | null = null;
  private finishRetry?: (proceed: boolean) => void;
  private retryTimerId: string | null = null;

  constructor(private readonly d: DreamDeps) {
    this.dir = d.dataDir ? join(d.dataDir, 'continuity', 'dream') : undefined;
    this.materials = new DreamMaterials(this.dir);
    for (const entry of d.core.timers.list()) if (entry.payload.kind === 'continuity.dream-retry') d.core.timers.cancel(entry.id);
    if (this.dir) {
      this.runs = this.readState<DreamRun[]>(join(this.dir, 'runs.json'), (runs) => Array.isArray(runs) && runs.every((run) =>
        run && typeof run.id === 'string' && typeof run.startedAt === 'string'
        && ['running', 'complete', 'partial', 'interrupted'].includes(run.status)
        && stringList(run.materialIds) && stringList(run.processedMaterials) && stringList(run.pendingTasks) && Array.isArray(run.tools))) ?? [];
      const interrupted = this.runs.some((run) => run.status === 'running');
      for (const run of this.runs) if (run.status === 'running') { run.status = 'interrupted'; run.error = 'Process stopped before closure confirmation'; }
      if (interrupted) {
        try { this.saveRuns(); }
        catch (error) { d.log.warn('梦运行记录无法保存', { file: join(this.dir, 'runs.json'), err: String(error) }); }
      }
      this.lastContext = this.readState<DreamContext>(join(this.dir, 'context.json'), (context) => Boolean(context)
        && typeof context.background === 'string' && Array.isArray(context.system)
        && context.system.every((record) => record && record.version === 2 && record.item && typeof record.item.type === 'string' && record.context));
    }
    if (d.memoryDir) {
      this.pendingTasks = this.readState<{ pendingTasks: string[] }>(join(d.memoryDir, 'note', 'dream-pending.json'),
        (note) => Boolean(note) && stringList(note.pendingTasks))?.pendingTasks ?? [];
    }
  }
  private readState<T>(file: string, validate: (value: T) => boolean): T | undefined {
    try {
      const value: T = JSON.parse(readFileSync(file, 'utf8'));
      if (!validate(value)) throw new SyntaxError('Invalid Dream state');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      let backup: string | undefined;
      if (error instanceof SyntaxError) {
        const destination = `${file}.corrupt-${randomUUID()}`;
        try { renameSync(file, destination); backup = destination; }
        catch (backupError) { this.d.log.warn('梦状态原文无法归档', { file, err: String(backupError) }); }
      }
      this.d.log.warn('梦状态无法读取，使用空状态或当前上下文', { file, backup, err: String(error) });
      return undefined;
    }
  }
  getStatus(): DreamStatus {
    return { dreaming: this.dreaming, queued: this.waiting.length, retryAt: this.retryAt,
      pendingMaterials: this.materials.list().filter((item) => item.completedAtMs === null).length,
      pendingTasks: [...this.pendingTasks], runs: structuredClone(this.runs.slice(-20).reverse()).map((run) =>
        run.status === 'running' ? { ...run, elapsedMs: Math.max(0, Date.now() - Date.parse(run.startedAt)) } : run) };
  }
  addPendingTask(task: string): void {
    if (this.pendingTasks.includes(task)) return;
    this.savePending([...this.pendingTasks, task]);
  }
  removePendingTask(task: string): void {
    if (this.taskInProgress(task)) throw new Error('Dream is already using this task');
    this.savePending(this.pendingTasks.filter(item => item !== task));
  }
  taskInProgress(task: string): boolean { return this.dreaming && this.activeTasks.has(task); }
  private savePending(tasks: string[]): void {
    if (this.d.memoryDir) {
      mkdirSync(join(this.d.memoryDir, 'note'), { recursive: true });
      writeJson(join(this.d.memoryDir, 'note', 'dream-pending.json'), { updatedAt: new Date().toISOString(), pendingTasks: tasks });
    }
    this.pendingTasks = tasks;
  }
  getBaseToolSchemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return [...this.d.dreamTools(), ...this.materialTools(), this.surfaceTool(() => null, () => {}, [])]
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
  forceDreamAndTruncate(): boolean { return !this.stopped && !this.dreaming && this.d.core.requestContextHandoff(); }

  resumePending(): boolean {
    if (this.stopped || this.dreaming || !this.materials.pending().length) return false;
    const context = this.lastContext ?? this.contextFrom(this.d.core.sessionInfo('main').snapshot ?? []);
    void this.enqueue(context);
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.finishRetry?.(false);
    for (const waiting of this.waiting.splice(0)) waiting.resolve();
  }

  onRetryDue(entry: TimerEntry): boolean {
    if (entry.payload.kind !== 'continuity.dream-retry') return false;
    if (entry.id === this.retryTimerId) this.finishRetry?.(true);
    return true;
  }

  schedule(snapshot: ContextRecord[]): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const clean = cleanSnapshot(closeDanglingCalls([...snapshot]));
    const view = this.d.cfg.context.keepPastThinking ? clean.records : withoutPastReasoning(clean.records);
    this.materials.add(view);
    return this.enqueue(this.contextFrom(snapshot));
  }
  private contextFrom(snapshot: ContextRecord[]): DreamContext {
    const clean = cleanSnapshot(snapshot);
    let head = 0;
    while (head < clean.records.length && hasRole(clean.records[head], 'system')) head++;
    return { system: clean.records.slice(0, head), background: clean.background };
  }
  private enqueue(context: DreamContext): Promise<void> {
    this.lastContext = context;
    if (this.dir) writeJson(join(this.dir, 'context.json'), context);
    const promise = new Promise<void>((resolve) => this.waiting.push({ ...context, resolve }));
    if (!this.dreaming) void this.drain();
    return promise;
  }
  private async drain(): Promise<void> {
    this.dreaming = true;
    try {
      while (!this.stopped && this.waiting.length) {
        const batch = this.waiting.splice(0);
        try {
          for (let count = 0; !this.stopped && count < dreamConfig(this.d.cfg.dream).maxBatches; count++) {
            let previous: DreamRun | undefined;
            let run: DreamRun;
            for (let attempt = 0; ; attempt++) {
              run = await this.run(batch.at(-1)!, previous, attempt);
              if (run.status !== 'interrupted' || this.stopped || attempt >= dreamConfig(this.d.cfg.dream).maxRetries) break;
              previous = run;
              if (!await this.waitForRetry(dreamConfig(this.d.cfg.dream).retryDelaySec)) break;
              batch.push(...this.waiting.splice(0));
            }
            if (run.status === 'interrupted' || !run.processedMaterials.length || this.waiting.length
              || !this.materials.list().some((item) => item.completedAtMs === null)) break;
          }
        }
        catch (error) { this.d.log.error('梦队列失败', { err: String(error) }); }
        finally { for (const waiting of batch) waiting.resolve(); }
      }
    } finally { this.dreaming = false; }
  }
  private waitForRetry(seconds: number): Promise<boolean> {
    this.retryAt = new Date(Date.now() + seconds * 1000).toISOString();
    this.d.log.info('梦等待重试', { retryAt: this.retryAt });
    return new Promise((resolve, reject) => {
      const scheduled = this.d.core.timers.set(this.retryAt!, { kind: 'continuity.dream-retry' });
      if (!scheduled.ok) { this.retryAt = null; reject(new Error(scheduled.error)); return; }
      this.retryTimerId = scheduled.id;
      const monitor = setInterval(() => {
        if (!this.d.core.timers.list().some((entry) => entry.id === scheduled.id)) this.finishRetry?.(false);
      }, 1000);
      this.finishRetry = (proceed) => {
        clearInterval(monitor);
        this.d.core.timers.cancel(scheduled.id);
        this.retryTimerId = null; this.retryAt = null; this.finishRetry = undefined; resolve(proceed);
      };
    });
  }
  private materialTools(ids?: string[]): ToolDef[] {
    return DREAM_TOOL_DECLS.slice(0, 2).map(spec => ({ ...spec, handler: async args => this.materialResult(spec.name, args, ids) }));
  }
  private materialResult(name: string, args: Record<string, unknown>, ids?: string[]): string {
    if (name === 'dream_materials') {
      const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 40);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return '[bad input] invalid range';
      const items = this.materials.list().filter((item) => ids === undefined || ids.includes(item.id));
      return JSON.stringify({ total: items.length, next: offset + limit < items.length ? offset + limit : null,
        items: items.slice(offset, offset + limit).map(item => {
          const signals = this.d.cfg.cognition?.stateReview?.enabled ? this.materials.reviewSignals(item.id) : null;
          return signals && (signals.staged || signals.proceed || signals.cancel) ? { ...item, stateReview: signals } : item;
        }) });
    }
    const start = Number(args.start ?? 0), maxChars = Number(args.maxChars ?? 8000);
    if (typeof args.id !== 'string' || !Number.isInteger(start) || start < 0 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 12000) return '[bad input] invalid range';
    if (ids && !ids.includes(args.id)) return '[bad input] material is outside this dream';
    return this.materials.read(args.id, start, maxChars);
  }
  private materialReadReview(name: string, args: Record<string, unknown>, ids: string[]): ReturnType<ReadReview> {
    if (name !== 'dream_materials' && name !== 'dream_read_material') return undefined;
    const result = this.materialResult(name, args, ids);
    const revision = createHash('sha256').update(result).digest('hex');
    if (result.startsWith('[bad input]')) return { read: { invalid: true, chars: 0, lines: 0 }, revision };
    const parsed = JSON.parse(result);
    const text = name === 'dream_read_material' ? parsed.text as string : result;
    return { read: { chars: text.length, lines: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0,
      ...(name === 'dream_read_material' ? { start: parsed.start, next: parsed.next, totalChars: parsed.totalChars }
        : { offset: Number(args.offset ?? 0), limit: Number(args.limit ?? 40), items: parsed.items.length, totalItems: parsed.total }) }, revision };
  }
  private surfaceTool(get: () => Closure | null, set: (closure: Closure) => void, ids: string[]): ToolDef {
    return {
      ...DREAM_TOOL_DECLS[2],
      barrierAfter: true,
      handler: async (args) => {
        if (get()) return '[already confirmed]';
        if (args.status !== 'complete' && args.status !== 'partial') return '[bad input] status must be "complete" or "partial".';
        const processedMaterials = args.processedMaterials === 'all' ? ids : args.processedMaterials;
        if (!Array.isArray(processedMaterials)) return '[bad input] processedMaterials must be an array of full material IDs, or "all" after processing every material in this batch. Use dream_materials to obtain IDs.';
        for (let i = 0; i < processedMaterials.length; i++) {
          const id = processedMaterials[i];
          if (typeof id !== 'string') return `[bad input] processedMaterials[${i}] must be a string.`;
          if (!ids.includes(id)) return `[bad input] processedMaterials[${i}] ${JSON.stringify(id)} is outside this dream. Use full IDs from dream_materials; batch prefixes and ranges are not material IDs.`;
        }
        if (!Array.isArray(args.pendingTasks)) return '[bad input] pendingTasks must be an array of strings describing only unfinished Memory consolidation work; use [] when no consolidation work remains.';
        if (args.pendingTasks.length > 200) return `[bad input] pendingTasks has ${args.pendingTasks.length} items; maximum is 200.`;
        for (let i = 0; i < args.pendingTasks.length; i++) {
          const task = args.pendingTasks[i];
          if (typeof task !== 'string') return `[bad input] pendingTasks[${i}] must be a string.`;
          if (task.length > 2000) return `[bad input] pendingTasks[${i}] has ${task.length} characters; maximum is 2000.`;
        }
        if (typeof args.text !== 'string') return '[bad input] text must be a string; use "" for no emergence.';
        if (args.text.length > 8000) return `[bad input] text has ${args.text.length} characters; maximum is 8000.`;
        const processed = [...new Set(processedMaterials as string[])];
        if (args.status === 'complete' && processed.length !== ids.length) {
          const remaining = ids.filter((id) => !processed.includes(id));
          return `[bad input] complete requires all ${ids.length} materials; processed ${processed.length}, missing ${remaining.length}. Missing IDs (first 5): ${JSON.stringify(remaining.slice(0, 5))}. Use dream_materials for the full list, or status "partial" with only the IDs already processed.`;
        }
        if (args.status === 'complete' && args.pendingTasks.length) return `[bad input] complete requires pendingTasks: []; received entries: ${args.pendingTasks.length}. pendingTasks is only for unfinished Memory consolidation work. Use [] when none remains; use status "partial" while consolidation work remains.`;
        const arrived = this.pendingTasks.filter(task => !this.activeTasks.has(task));
        const tasks = [...new Set([...(args.pendingTasks as string[]), ...arrived])];
        const closure: Closure = { status: tasks.length ? 'partial' : args.status, processedMaterials: processed, pendingTasks: tasks, text: args.text.trim() };
        this.savePending(tasks);
        this.materials.complete(processed);
        set(closure);
        return '[' + closure.status + ' confirmed; ' + processed.length + ' materials processed]';
      }
    };
  }
  private async run(waiting: Waiting, previous?: DreamRun, retryAttempt = 0): Promise<DreamRun> {
    this.activeTasks = new Set(this.pendingTasks);
    const config = dreamConfig(this.d.cfg.dream);
    const offset = usageOffset(this.d.dataDir);
    const started = Date.now();
    const pending = this.materials.pending();
    const run: DreamRun = { id: randomUUID(), startedAt: new Date(started).toISOString(), status: 'running',
      materialIds: pending.map((item) => item.id), processedMaterials: [], pendingTasks: [...this.pendingTasks], tools: [],
      ...(previous ? { retryOf: previous.id, retryAttempt } : {}) };
    this.runs.push(run);
    this.runs = this.runs.slice(-50);
    let closure: Closure | null = null;
    this.saveRuns();
    try {
      const state = this.d.semanticState?.() ?? '';
      const dreamTools = this.d.dreamTools();
      const reservedBytes = Buffer.byteLength(JSON.stringify([...dreamTools, ...DREAM_TOOL_DECLS]
        .map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters }))));
      const prepared = prepareDreamInput(pending, {
        maxInputTokens: config.maxInputTokens!, maxBackgroundTokens: config.maxBackgroundTokens!, system: waiting.system,
        maxInputBytes: config.maxInputBytes, reservedBytes, blobBytes: handle => this.d.core.blob(handle)?.bytes.byteLength ?? null,
        guide: [dreamOrientation(this.d.deferStateMigration?.(), this.d.cfg.cognition?.stateReview?.enabled === true), '━━━ Using your tools ━━━', this.d.toolUsageText(),
          dreamTask({ nowText: nowIso(this.d.cfg.timezone) }),
          'Unfinished Memory consolidation work only (note/dream-pending.json; [] when none remains): ' + JSON.stringify(this.pendingTasks),
          ...(previous ? ['The previous fork ended without closure confirmation. Its Memory edits may already exist. Read current Memory before changing it; consolidate only work still unfinished.'] : [])].join('\n\n'),
        state, background: waiting.background, reviewFeedback: this.d.cfg.cognition?.stateReview?.enabled === true,
      });
      Object.assign(run, { materialIds: prepared.materialIds, inputTokens: prepared.inputTokens, inputBytes: prepared.inputBytes, backgroundTokens: prepared.backgroundTokens,
        stateTokens: prepared.stateTokens, included: prepared.included.length, omitted: prepared.omitted.length });
      this.saveRuns();
      this.d.log.info('梦开始', { id: run.id, materials: run.materialIds.length, pendingMaterials: pending.length });
      const availableTools = [...dreamTools, ...this.materialTools(run.materialIds), this.surfaceTool(() => closure, (next) => { closure = next; }, run.materialIds)];
      const reviewedTools = this.d.reviewTools?.(availableTools, (name, args) => this.materialReadReview(name, args, run.materialIds)) ?? availableTools;
      const tools = reviewedTools
        .map((tool): ToolDef => ({ ...tool, handler: async (args, ctx) => {
          if (this.stopped) return '[stopped] Dream is shutting down; this tool was not executed.';
          const before = Date.now();
          let result: string | ToolOutcome | undefined;
          let error: unknown;
          try { result = await tool.handler(args, ctx); return result; }
          catch (caught) { error = caught; throw caught; }
          finally {
            const text = typeof result === 'string' ? result : result?.text ?? '';
            const diagnostic = { name: tool.name, ...(typeof args.path === 'string' ? { path: args.path } : {}), elapsedMs: Date.now() - before, resultChars: text.length, failed: error !== undefined };
            run.tools.push(diagnostic);
            this.d.log.info('dream tool', { id: run.id, ...diagnostic });
            if (config.recordDetailedTrace && this.dir) {
              mkdirSync(join(this.dir, 'trace'), { recursive: true });
              appendFileSync(join(this.dir, 'trace', run.id + '.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...diagnostic, args, result, error: error === undefined ? undefined : String(error) }) + '\n');
            }
            this.saveRuns();
          }
        } }));
      const lastContent = await this.d.core.spawnFork({ id: DREAM, messages: prepared.messages, tools, stopWhen: () => closure !== null || this.stopped,
        wrapUpHint: 'Budget warning: finish current changes and call surface. Use processedMaterials: "all" only after processing every material in this batch; otherwise list processed IDs. pendingTasks must list only unfinished Memory consolidation work; use [] when none remains. Use partial status while consolidation work remains; text may be empty. Unconfirmed materials remain for a later batch.' });
      const confirmed = closure as Closure | null;
      run.status = confirmed?.status ?? 'interrupted';
      if (!confirmed) run.error = 'Fork ended without closure confirmation' + (lastContent.trim() ? ': ' + lastContent.trim().slice(0, 2000) : '');
      run.processedMaterials = confirmed?.processedMaterials ?? [];
      run.pendingTasks = confirmed?.pendingTasks ?? [...this.pendingTasks];
      if (confirmed?.text) {
        try { this.d.onEmergence(confirmed.text); }
        catch (error) { this.d.log.error('梦浮现投递失败', { id: run.id, err: String(error) }); }
      }
    } catch (error) {
      run.status = 'interrupted'; run.error = String(error);
      this.d.log.error('梦失败', { id: run.id, err: run.error });
    } finally {
      this.activeTasks.clear();
      this.d.onEnd?.();
      run.endedAt = new Date().toISOString(); run.elapsedMs = Date.now() - started;
      run.usage = readDreamUsage(this.d.dataDir, started, Date.now(), offset);
      this.saveRuns();
      this.d.log.info('梦结束', { ...run, tools: run.tools.length });
      this.materials.cleanup(config.materialRetentionDays!);
      if (this.dir && existsSync(join(this.dir, 'trace'))) for (const file of readdirSync(join(this.dir, 'trace'))) {
        if (!/^[0-9a-f-]+\.jsonl$/.test(file)) continue;
        const path = join(this.dir, 'trace', file);
        if (Date.now() - statSync(path).mtimeMs >= config.traceRetentionDays! * 86400000) unlinkSync(path);
      }
    }
    return run;
  }
  private saveRuns(): void { if (this.dir) writeJson(join(this.dir, 'runs.json'), this.runs); }
}

export const DREAM_TOOL_DECLS: ToolSpec[] = [
  {
    name: 'dream_materials',
    description: 'List original material IDs, creation times and completion confirmations. Paginated, read-only.',
    tags: ['read'],
    parameters: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } }
  },
  {
    name: 'dream_read_material',
    description: 'Read an original material by ID and character range. Return capped at 12000 characters; next marks the unread range.',
    tags: ['read'],
    parameters: { type: 'object', properties: { id: { type: 'string' }, start: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 12000 } }, required: ['id'] }
  },
  {
    name: 'surface',
    description: 'Confirm complete or partial consolidation, processed original material IDs and unfinished Memory consolidation work. Empty text ends without waking the main thread.',
    tags: ['flow'],
    parameters: {
      type: 'object', properties: {
        status: { type: 'string', enum: ['complete', 'partial'] },
        processedMaterials: {
          anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['all'] }],
          description: 'Use "all" after consolidating every material in this batch, with complete or partial status. Otherwise list only processed material IDs.'
        },
        pendingTasks: {
          type: 'array', items: { type: 'string' },
          description: 'Only unfinished Memory consolidation work. Use [] when no consolidation work remains.'
        }, text: { type: 'string' },
      }, required: ['status', 'processedMaterials', 'pendingTasks', 'text']
    }
  }
];
