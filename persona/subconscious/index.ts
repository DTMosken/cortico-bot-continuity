/** Serial dream work merges waiting handoffs and resumes unconfirmed materials. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, withoutPastReasoning } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { CoreApi, Logger, ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import type { BotConfig } from '../../index.ts';
import { nowIso } from 'cortico/core/util.ts';
import { closeDanglingCalls } from 'cortico/core/truncate.ts';
import { cleanSnapshot } from '../context-material.ts';
import { dreamConfig } from '../config.ts';
import { DreamMaterials, prepareDreamInput, writeJson } from './materials.ts';
import { dreamOrientation, dreamTask } from './prompts.ts';
import { readDreamUsage, usageOffset, type DreamUsage } from './usage.ts';

export const DREAM = 'dream';
export interface DreamDeps {
  cfg: BotConfig; core: CoreApi; dreamTools: () => ToolDef[]; toolUsageText: () => string;
  log: Logger; onEmergence: (text: string) => void;
  dataDir?: string; memoryDir?: string; semanticState?: () => string;
}
export interface DreamRun {
  id: string; startedAt: string; endedAt?: string; elapsedMs?: number;
  status: 'running' | 'complete' | 'partial' | 'interrupted';
  materialIds: string[]; processedMaterials: string[]; pendingTasks: string[];
  inputTokens?: number; backgroundTokens?: number; stateTokens?: number; included?: number; omitted?: number;
  tools: Array<{ name: string; path?: string; elapsedMs: number; resultChars: number; failed: boolean }>;
  usage?: DreamUsage; error?: string;
}
export interface DreamStatus { dreaming: boolean; queued: number; pendingMaterials: number; pendingTasks: string[]; runs: DreamRun[] }
interface Waiting { system: ContextRecord[]; background: string; resolve: () => void }
interface Closure { status: 'complete' | 'partial'; processedMaterials: string[]; pendingTasks: string[]; text: string }

export class Dream {
  private readonly materials: DreamMaterials;
  private readonly dir?: string;
  private waiting: Waiting[] = [];
  private dreaming = false;
  private runs: DreamRun[] = [];
  private pendingTasks: string[] = [];

  constructor(private readonly d: DreamDeps) {
    this.dir = d.dataDir ? join(d.dataDir, 'continuity', 'dream') : undefined;
    this.materials = new DreamMaterials(this.dir);
    if (this.dir) {
      try { this.runs = JSON.parse(readFileSync(join(this.dir, 'runs.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const run of this.runs) if (run.status === 'running') { run.status = 'interrupted'; run.error = 'Process stopped before closure confirmation'; }
      this.saveRuns();
    }
    if (d.memoryDir) {
      try { this.pendingTasks = JSON.parse(readFileSync(join(d.memoryDir, 'note', 'dream-pending.json'), 'utf8')).pendingTasks; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  getStatus(): DreamStatus {
    return { dreaming: this.dreaming, queued: this.waiting.length,
      pendingMaterials: this.materials.list().filter((item) => item.completedAt === null).length,
      pendingTasks: [...this.pendingTasks], runs: structuredClone(this.runs.slice(-20).reverse()) };
  }
  getBaseToolSchemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return [...this.d.dreamTools(), ...this.materialTools(), this.surfaceTool(() => null, () => {}, [])]
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
  forceDreamAndTruncate(): boolean { return !this.dreaming && this.d.core.requestContextHandoff(); }

  schedule(snapshot: ContextRecord[]): Promise<void> {
    const clean = cleanSnapshot(closeDanglingCalls([...snapshot]));
    const view = this.d.cfg.context.keepPastThinking ? clean.records : withoutPastReasoning(clean.records);
    this.materials.add(view);
    let head = 0;
    while (head < view.length && hasRole(view[head], 'system')) head++;
    const promise = new Promise<void>((resolve) => this.waiting.push({ system: view.slice(0, head), background: clean.background, resolve }));
    if (!this.dreaming) void this.drain();
    return promise;
  }
  private async drain(): Promise<void> {
    this.dreaming = true;
    try {
      while (this.waiting.length) {
        const batch = this.waiting.splice(0);
        try { await this.run(batch.at(-1)!); }
        catch (error) { this.d.log.error('梦队列失败', { err: String(error) }); }
        finally { for (const waiting of batch) waiting.resolve(); }
      }
    } finally { this.dreaming = false; }
  }
  private materialTools(ids?: string[]): ToolDef[] {
    return [
      { name: 'dream_materials', description: 'List original material IDs, creation times and completion confirmations. Paginated, read-only.', tags: ['read'],
        parameters: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
        handler: async (args) => {
          const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 40);
          if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return '[bad input] invalid range';
          const items = this.materials.list().filter((item) => ids === undefined || ids.includes(item.id));
          return JSON.stringify({ total: items.length, next: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) });
        } },
      { name: 'dream_read_material', description: 'Read an original material by ID and character range. Return capped at 12000 characters; next marks the unread range.', tags: ['read'],
        parameters: { type: 'object', properties: { id: { type: 'string' }, start: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 12000 } }, required: ['id'] },
        handler: async (args) => {
          const start = Number(args.start ?? 0), maxChars = Number(args.maxChars ?? 8000);
          if (typeof args.id !== 'string' || !Number.isInteger(start) || start < 0 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 12000) return '[bad input] invalid range';
          if (ids && !ids.includes(args.id)) return '[bad input] material is outside this dream';
          return this.materials.read(args.id, start, maxChars);
        } },
    ];
  }
  private surfaceTool(get: () => Closure | null, set: (closure: Closure) => void, ids: string[]): ToolDef {
    return {
      name: 'surface', description: 'Confirm complete or partial consolidation, processed original material IDs and remaining tasks. Empty text ends without waking the main thread.',
      tags: ['flow'], barrierAfter: true,
      parameters: { type: 'object', properties: {
        status: { type: 'string', enum: ['complete', 'partial'] }, processedMaterials: { type: 'array', items: { type: 'string' } },
        pendingTasks: { type: 'array', items: { type: 'string' } }, text: { type: 'string' },
      }, required: ['status', 'processedMaterials', 'pendingTasks', 'text'] },
      handler: async (args) => {
        if (get()) return '[already confirmed]';
        if ((args.status !== 'complete' && args.status !== 'partial') || !Array.isArray(args.processedMaterials)
          || args.processedMaterials.some((id) => typeof id !== 'string' || !ids.includes(id))
          || !Array.isArray(args.pendingTasks) || args.pendingTasks.length > 200 || args.pendingTasks.some((task) => typeof task !== 'string' || task.length > 2000)
          || typeof args.text !== 'string' || args.text.length > 8000) return '[bad input] invalid closure';
        const processed = [...new Set(args.processedMaterials as string[])];
        if (args.status === 'complete' && (processed.length !== ids.length || args.pendingTasks.length)) return '[bad input] complete requires all materials processed and no remaining tasks';
        const closure: Closure = { status: args.status, processedMaterials: processed, pendingTasks: args.pendingTasks as string[], text: args.text.trim() };
        if (this.d.memoryDir) {
          mkdirSync(join(this.d.memoryDir, 'note'), { recursive: true });
          writeJson(join(this.d.memoryDir, 'note', 'dream-pending.json'), { updatedAt: new Date().toISOString(), pendingTasks: closure.pendingTasks });
        }
        this.materials.complete(processed);
        this.pendingTasks = closure.pendingTasks;
        set(closure);
        return '[' + closure.status + ' confirmed; ' + processed.length + ' materials processed]';
      },
    };
  }
  private async run(waiting: Waiting): Promise<void> {
    const config = dreamConfig(this.d.cfg.dream);
    const offset = usageOffset(this.d.dataDir);
    const started = Date.now();
    const pending = this.materials.pending();
    const run: DreamRun = { id: randomUUID(), startedAt: new Date(started).toISOString(), status: 'running',
      materialIds: pending.map((item) => item.id), processedMaterials: [], pendingTasks: [...this.pendingTasks], tools: [] };
    this.runs.push(run);
    this.runs = this.runs.slice(-50);
    let closure: Closure | null = null;
    this.saveRuns();
    this.d.log.info('梦开始', { id: run.id, materials: pending.length });
    try {
      const prepared = prepareDreamInput(pending, {
        maxInputTokens: config.maxInputTokens!, maxBackgroundTokens: config.maxBackgroundTokens!, system: waiting.system,
        guide: [dreamOrientation(), '━━━ Using your tools ━━━', this.d.toolUsageText(),
          dreamTask({ nowText: nowIso(this.d.cfg.timezone) }),
          'Remaining tasks (Memory note/dream-pending.json): ' + JSON.stringify(this.pendingTasks)].join('\n\n'),
        state: this.d.semanticState?.() ?? '', background: waiting.background,
      });
      Object.assign(run, { inputTokens: prepared.inputTokens, backgroundTokens: prepared.backgroundTokens,
        stateTokens: prepared.stateTokens, included: prepared.included.length, omitted: prepared.omitted.length });
      const tools = [...this.d.dreamTools(), ...this.materialTools(run.materialIds), this.surfaceTool(() => closure, (next) => { closure = next; }, run.materialIds)]
        .map((tool): ToolDef => ({ ...tool, handler: async (args, ctx) => {
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
            if (config.detailedTrace && this.dir) {
              mkdirSync(join(this.dir, 'trace'), { recursive: true });
              appendFileSync(join(this.dir, 'trace', run.id + '.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...diagnostic, args, result, error: error === undefined ? undefined : String(error) }) + '\n');
            }
            this.saveRuns();
          }
        } }));
      await this.d.core.spawnFork({ id: DREAM, messages: prepared.messages, tools, stopWhen: () => closure !== null,
        wrapUpHint: 'Budget warning: stop expanding the task. Call surface with complete or partial status, processedMaterials, pendingTasks, and optional empty text. Unconfirmed materials remain for a later dream.' });
      const confirmed = closure as Closure | null;
      run.status = confirmed?.status ?? 'interrupted';
      run.processedMaterials = confirmed?.processedMaterials ?? [];
      run.pendingTasks = confirmed?.pendingTasks ?? [...this.pendingTasks];
      if (confirmed?.text) this.d.onEmergence(confirmed.text);
    } catch (error) {
      run.status = 'interrupted'; run.error = String(error);
      this.d.log.error('梦失败', { id: run.id, err: run.error });
    } finally {
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
  }
  private saveRuns(): void { if (this.dir) writeJson(join(this.dir, 'runs.json'), this.runs); }
}
