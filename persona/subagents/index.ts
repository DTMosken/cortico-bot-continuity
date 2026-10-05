/** Main delegations and World cognition share capacity, receipts and read-only Persona Memory. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Core } from 'cortico/core/core.ts';
import type { CoreApi, CognitionContext, CognitionRequest, CognitionResult, SessionDecl, ToolDef, ToolOutcome, World } from 'cortico/core/types.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { subagentsConfig, type SubagentsConfig } from './config.ts';
import { charLength, charSlice, TaskStore, type TaskRecord, type TaskStatus } from './store.ts';
import { balancedSnapshot, runWorker } from './runtime.ts';
import { subagentCompletionText, subagentListText, subagentResultText, subagentSection, subagentSpawnText } from './prompts.ts';

export const SUBAGENT = 'subagent';
const MEMORY_READ_TOOLS = new Set(['read_file', 'list_files', 'glob_files', 'grep_files']);
export interface Assignment { task: string; materials: string[]; tools: string[]; context: 'isolated' | 'main'; hintRounds?: number; }
export type SpawnResult = { accepted: true; taskId: string; status: TaskStatus; requested?: boolean }
  | { accepted: false; reason: string; availableTools?: string };
export interface ToolEntry { name: string; description: string; tags: string[]; allowed: boolean; available: boolean; reason?: string; }
export interface ToolGroup { id: string; label: string; enabled: boolean; tools: ToolEntry[]; }
interface OwnedTool { owner: string; tool: ToolDef; }
interface SubagentsDependencies {
  config(): SubagentsConfig; core(): CoreApi | null; runtime(): Core | null;
  memoryTools(): ToolDef[]; visibleTools(): ToolDef[]; worlds: World[]; contextTokens(): number;
  messages(assignment: Assignment & { taskId: string; worldId?: string }, config: SubagentsConfig, tools: OwnedTool[]): Promise<ContextRecord[]>;
  savePermissions(): void; isRunning(): boolean; isWorldVisible(id: string): boolean; dataDir?: string;
}
type Closure = { status: 'complete' | 'partial' | 'failed'; summary: string; result: string };
type StopStatus = 'cancelled' | 'timed_out' | 'interrupted';
interface ActiveTask {
  record: TaskRecord; controller: AbortController; world?: World;
  stop?: { status: StopStatus; reason: string };
  settle(result: CognitionResult): void; result: Promise<CognitionResult>;
}
function lockReason(owner: string, tool: ToolDef): string | undefined {
  return owner === 'memory' && !MEMORY_READ_TOOLS.has(tool.name) ? 'Memory 只读' : undefined;
}
function readOnly(tool: ToolDef): boolean {
  return tool.tags.includes('read') && !tool.tags.some(tag => ['write', 'speak', 'act', 'flow'].includes(tag));
}
function integer(value: unknown, fallback: number, maximum: number): number {
  const number = value === undefined ? fallback : value;
  if (!Number.isInteger(number) || (number as number) < 0 || (number as number) > maximum) throw new Error('分页范围无效');
  return number as number;
}
function brief(record: TaskRecord) { const { materials: _, ...rest } = record; return structuredClone(rest); }
function toolReceipt(title: string, render: () => string): string | ToolOutcome {
  try { return render(); }
  catch (error) { return { text: subagentSection(title, '状态：failed\n原因：' + String(error)), failed: true }; }
}

export class Subagents {
  private readonly store: TaskStore;
  private readonly active = new Map<string, ActiveTask>();
  private stopped = false;
  constructor(private readonly d: SubagentsDependencies) {
    this.store = new TaskStore(d.dataDir ? join(d.dataDir, 'continuity', 'subagents') : undefined);
  }
  private canRun(source: 'main' | 'world' = 'main'): boolean { return !this.stopped && (source === 'world' || this.d.isRunning()); }
  private ownedTools(): OwnedTool[] {
    return [...this.d.memoryTools().map(tool => ({ owner: 'memory', tool })),
      ...this.d.worlds.flatMap(world => world.tools().map(tool => ({ owner: world.id, tool })))];
  }
  catalogue(source: 'main' | 'world' = 'main'): ToolGroup[] {
    const cfg = this.d.config(), owned = this.ownedTools();
    const first = Object.keys(cfg.permissions).length === 0;
    let changed = false;
    if (source === 'main') for (const { owner, tool } of owned) {
      if (!Object.hasOwn(cfg.permissions, owner)) { cfg.permissions[owner] = { enabled: true, tools: {} }; changed = true; }
      const group = cfg.permissions[owner];
      if (!Object.hasOwn(group.tools, tool.name)) { group.tools[tool.name] = first && !lockReason(owner, tool) && readOnly(tool); changed = true; }
    }
    if (changed) this.d.savePermissions();
    const visible = new Set(this.d.visibleTools().map(tool => tool.name));
    const groups = new Map<string, ToolGroup>();
    for (const { owner, tool } of owned) {
      if (source === 'world' && owner === 'memory') continue;
      const policy = (source === 'main' ? cfg.permissions : cfg.cognitionPermissions)[owner];
      let group = groups.get(owner);
      if (!group) {
        const world = this.d.worlds.find(world => world.id === owner);
        group = { id: owner, label: owner === 'memory' ? 'Memory' : world?.console?.().label ?? owner, enabled: policy?.enabled !== false, tools: [] };
        groups.set(owner, group);
      }
      const reason = lockReason(owner, tool);
      group.tools.push({ name: tool.name, description: tool.description, tags: [...tool.tags],
        allowed: !reason && (source === 'world' ? policy?.tools[tool.name] !== false : policy?.tools[tool.name] === true),
        available: source === 'world' || owner === 'memory' || this.d.isWorldVisible(owner) && visible.has(tool.name), ...(reason ? { reason } : {}) });
    }
    return [...groups.values()];
  }
  availableToolsText(): string {
    return this.catalogue().map(group => {
      const tools = group.tools.filter(tool => this.d.config().enabled && group.enabled && tool.allowed && tool.available);
      return tools.length ? group.label + ': ' + tools.map(tool => tool.name).join(', ') : '';
    }).filter(Boolean).join('\n') || '(none)';
  }
  session(): SessionDecl {
    return { id: SUBAGENT, label: '子代理', persistent: false, receivesEvents: false, tools: () => [],
      rounds: () => ({ soft: this.d.config().softRounds, hard: this.d.config().maxRounds }) };
  }
  mainTools(): ToolDef[] {
    return [
      { name: 'subagent_spawn', description: 'Start a task and return its ID immediately, or cancel by taskId. For start, supply task, materials, tools; context defaults to isolated, or use main for an acceptance-time snapshot.',
        tags: ['flow'], parameters: { type: 'object', properties: {
          mode: { type: 'string', enum: ['start', 'cancel'] }, taskId: { type: 'string' }, task: { type: 'string', minLength: 1 },
          materials: { type: 'array', items: { type: 'string' } }, tools: { type: 'array', items: { type: 'string' } }, context: { type: 'string', enum: ['isolated', 'main'] },
        }, additionalProperties: false }, handler: async args => toolReceipt('子代理任务委派', () => subagentSpawnText(this.spawn(args))) },
      { name: 'subagent_list', description: 'List tasks, source, rounds, peak metered input, end reason and reminder indices. Full results and evidence use subagent_get.',
        tags: ['read'], parameters: { type: 'object', properties: {
          offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string', enum: ['running', 'stopping', 'complete', 'partial', 'failed', 'unconfirmed', 'interrupted', 'cancelled', 'timed_out'] },
          source: { type: 'string', enum: ['main', 'world'] }, worldId: { type: 'string' },
        } }, handler: async args => toolReceipt('子代理任务列表', () => subagentListText(this.list(args), args)) },
      { name: 'subagent_get', description: 'Read a character page of the current result, or reminder evidence by one-based reminderIndex. Available during execution.',
        tags: ['read'], parameters: { type: 'object', properties: {
          taskId: { type: 'string' }, reminderIndex: { type: 'integer', minimum: 1 }, offsetChars: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 32000 },
        }, required: ['taskId'] }, handler: async args => toolReceipt('子代理结果查询', () => subagentResultText(this.get(args), args.maxChars)) },
    ];
  }
  list(args: Record<string, unknown> = {}) {
    const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER), limit = integer(args.limit, 20, 100);
    if (!limit) throw new Error('页长必须大于 0');
    const records = this.store.all().reverse().filter(record => (args.status === undefined || record.status === args.status)
      && (args.source === undefined || record.source === args.source) && (args.worldId === undefined || record.worldId === args.worldId));
    return { total: records.length, nextOffset: offset + limit < records.length ? offset + limit : null, tasks: records.slice(offset, offset + limit).map(brief) };
  }
  get(args: Record<string, unknown>) {
    if (typeof args.taskId !== 'string') throw new Error('缺少任务 ID');
    const record = this.store.get(args.taskId);
    if (!record) throw new Error('未知任务 ID');
    const offset = integer(args.offsetChars, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(args.maxChars, this.d.config().resultPageChars, this.d.config().resultPageChars);
    if (!limit) throw new Error('页长必须大于 0');
    const reminderIndex = args.reminderIndex === undefined ? undefined : integer(args.reminderIndex, 1, record.reminders.length);
    const text = reminderIndex === undefined ? this.store.result(record.id) : this.store.reminder(record.id, reminderIndex);
    return { ...brief(record), reminderIndex, contentChars: charLength(text), offsetChars: offset, result: charSlice(text, offset, limit),
      nextOffset: offset + limit < charLength(text) ? offset + limit : null };
  }
  state() {
    const page = this.list();
    return { groups: this.catalogue(), cognitionGroups: this.catalogue('world'), running: this.active.size, records: page.tasks,
      total: page.total, nextOffset: page.nextOffset };
  }
  normalizePermissions(config: SubagentsConfig): void {
    for (const { owner, tool } of this.ownedTools()) if (lockReason(owner, tool) && config.permissions[owner]?.tools[tool.name]) throw new Error(tool.name + '：' + lockReason(owner, tool));
    if (config.cognitionPermissions.memory) throw new Error('World扩展子代理权限仅接受 World；Memory 只读工具由主线子代理权限配置');
  }
  permissionsChanged(): void {
    for (const active of this.active.values()) {
      if (!this.d.config().enabled) this.requestStop(active, 'interrupted', 'disabled');
      else if (active.record.worldId && this.d.config().cognitionPermissions[active.record.worldId]?.enabled === false) this.requestStop(active, 'interrupted', 'world_disabled');
    }
  }
  spawn(args: Record<string, unknown>): SpawnResult {
    const mode = args.mode ?? 'start';
    if (mode === 'cancel') {
      if (Object.keys(args).some(key => !['mode', 'taskId'].includes(key)) || typeof args.taskId !== 'string') throw new Error('取消只接受 mode 和 taskId');
      const record = this.store.get(args.taskId);
      if (!record) return { accepted: false, reason: '未知任务 ID' };
      const active = this.active.get(record.id);
      if (active) this.requestStop(active, 'cancelled', 'cancelled');
      return { accepted: true, taskId: record.id, status: record.status, requested: !!active };
    }
    if (mode !== 'start' || Object.keys(args).some(key => !['mode', 'task', 'materials', 'tools', 'context'].includes(key))
      || typeof args.task !== 'string' || !args.task.trim() || !Array.isArray(args.materials) || args.materials.some(value => typeof value !== 'string')
      || !Array.isArray(args.tools) || args.tools.some(value => typeof value !== 'string') || !['isolated', 'main'].includes(String(args.context ?? 'isolated'))) throw new Error('任务、材料、上下文和工具列表格式无效');
    const assignment: Assignment = { task: args.task, materials: [...args.materials], tools: [...new Set(args.tools as string[])], context: args.context === 'main' ? 'main' : 'isolated' };
    const permitted = new Set(this.catalogue().filter(group => group.enabled).flatMap(group => group.tools.filter(tool => tool.allowed && tool.available).map(tool => tool.name)));
    const denied = assignment.tools.filter(name => !permitted.has(name));
    if (denied.length) return { accepted: false, reason: 'Tools are not permitted or currently available: ' + denied.join(', '), availableTools: this.availableToolsText() };
    const started = this.start(assignment, this.ownedTools().filter(({ tool }) => assignment.tools.includes(tool.name)));
    return typeof started === 'string' ? { accepted: false, reason: started } : { accepted: true, taskId: started.record.id, status: 'running' };
  }
  async request(req: CognitionRequest, ctx: CognitionContext): Promise<CognitionResult> {
    const group = this.catalogue('world').find(group => group.id === ctx.worldId);
    if (this.d.config().cognitionPermissions[ctx.worldId]?.enabled === false) return { error: 'World cognition is disabled.' };
    if (ctx.tools.some(tool => !group?.tools.find(entry => entry.name === tool.name)?.allowed)) return { error: 'Requested World tool is not permitted.' };
    const memory = this.catalogue().find(group => group.id === 'memory');
    const names = new Set(memory?.enabled ? memory.tools.filter(tool => tool.allowed).map(tool => tool.name) : []);
    const ownTools = [...new Map(ctx.tools.map(tool => [tool.name, tool])).values()];
    const owned = [...ownTools.map(tool => ({ owner: ctx.worldId, tool })), ...this.d.memoryTools().filter(tool => names.has(tool.name) && MEMORY_READ_TOOLS.has(tool.name)).map(tool => ({ owner: 'memory', tool }))];
    const started = this.start({ task: req.brief, materials: [], tools: owned.map(entry => entry.tool.name), context: 'main', hintRounds: req.hint?.rounds }, owned, ctx.worldId);
    return typeof started === 'string' ? { error: started } : started.result;
  }
  private start(assignment: Assignment, owned: OwnedTool[], worldId?: string): ActiveTask | string {
    const runtime = this.d.runtime(), api = this.d.core();
    if (!this.canRun(worldId ? 'world' : 'main') || !runtime || !api) return 'Subagents are stopped or not attached.';
    const config = subagentsConfig(this.d.config());
    if (!config.enabled) return 'Subagents are disabled.';
    if (this.active.size >= config.maxWorkers) return 'Worker capacity reached; no task was queued.';
    const main = api.sessionInfo('main');
    const snapshot = assignment.context === 'main' ? balancedSnapshot(main.snapshot ?? []) : [];
    const record: TaskRecord = { id: randomUUID(), ...assignment, source: worldId ? 'world' : 'main', ...(worldId ? { worldId } : {}),
      status: 'running', startedAt: new Date().toISOString(), summary: '', resultChars: 0, reminders: [], softRounds: config.softRounds, maxRounds: config.maxRounds, timeoutMs: config.timeoutMs,
      contextTokens: Math.min(this.d.contextTokens(), main.hardTokens ?? Infinity), rounds: 0, peakInputTokens: null, estimatedInputTokens: 0 };
    this.store.save(record);
    let settle!: ActiveTask['settle'];
    const result = new Promise<CognitionResult>(resolve => { settle = resolve; });
    const active: ActiveTask = { record, controller: new AbortController(), settle, result, world: this.d.worlds.find(world => world.id === worldId) };
    const llm = runtime.llm.bind?.() ?? runtime.llm, spec = structuredClone(runtime.mainSessionSpec());
    this.active.set(record.id, active);
    const timer = setTimeout(() => {
      try { this.requestStop(active, 'timed_out', 'timeout'); }
      catch (error) { api.log.error('子代理停止记录保存失败', { id: record.id, error: String(error) }); }
    }, config.timeoutMs);
    void this.run(active, assignment, config, owned, snapshot, runtime, llm, spec).catch(error => {
      settle({ error: 'Task persistence failed: ' + String(error) });
      api.log.error('子代理记录保存失败', { id: record.id, error: String(error) });
    }).finally(() => { clearTimeout(timer); this.active.delete(record.id); });
    return active;
  }
  private async run(active: ActiveTask, assignment: Assignment, config: SubagentsConfig, owned: OwnedTool[], snapshot: ContextRecord[], runtime: Core, llm: Core['llm'], spec: ReturnType<Core['mainSessionSpec']>): Promise<void> {
    const { record } = active;
    let closure: Closure | undefined;
    const stopped = () => {
      if (!this.canRun(record.source)) this.requestStop(active, 'interrupted', 'shutdown');
      this.permissionsChanged();
      if (record.worldId && this.d.worlds.find(world => world.id === record.worldId) !== active.world) this.requestStop(active, 'interrupted', 'world_unmounted');
      return !!active.stop;
    };
    const finish: ToolDef = { name: 'subagent_finish', description: 'Optionally finish with complete, partial or failed status. Natural final text also completes the task.', tags: ['flow'], barrierAfter: true,
      parameters: { type: 'object', properties: { status: { type: 'string', enum: ['complete', 'partial', 'failed'] }, summary: { type: 'string', maxLength: config.maxSummaryChars }, result: { type: 'string' } }, required: ['status', 'summary', 'result'], additionalProperties: false },
      handler: async args => {
        if (Object.keys(args).some(key => !['status', 'summary', 'result'].includes(key)) || typeof args.status !== 'string' || !['complete', 'partial', 'failed'].includes(args.status) || typeof args.summary !== 'string' || typeof args.result !== 'string'
          || (args.status === 'failed' ? !args.summary.trim() : !args.result.trim())) return { failed: true, text: subagentSection('子代理收尾', '状态：bad_input\n原因：Supply status, summary and result; complete/partial need a result, failed needs a reason.') };
        if (charLength(args.summary) > config.maxSummaryChars) return { failed: true, text: subagentSection('子代理收尾', '状态：bad_input\n原因：Shorten summary to at most ' + config.maxSummaryChars + ' characters.') };
        closure = { status: args.status as Closure['status'], summary: args.summary, result: args.result };
        return subagentSection('子代理收尾', '状态：' + closure.status + '\n确认：已接受');
      } };
    const notify: ToolDef = { name: 'subagent_notify', description: 'Save evidence and notify the main agent of a finding needing attention or a Memory decision. Task continues; Memory is unchanged.', tags: ['flow'],
      parameters: { type: 'object', properties: { summary: { type: 'string', minLength: 1, maxLength: config.maxSummaryChars }, details: { type: 'string', minLength: 1 } }, required: ['summary', 'details'], additionalProperties: false },
      handler: async args => {
        if (Object.keys(args).some(key => !['summary', 'details'].includes(key)) || typeof args.summary !== 'string' || !args.summary.trim() || charLength(args.summary) > config.maxSummaryChars || typeof args.details !== 'string' || !args.details.trim()) return { failed: true, text: 'Supply a nonempty bounded summary and full details only.' };
        const reminder = this.store.writeReminder(record, args.summary, args.details);
        this.d.core()!.injectInternal(`━━━ 子代理提醒 ━━━\n任务 ID：${record.id}\n来源：${record.worldId ?? '主线'}\n提醒序号：${reminder.index}\n摘要：${reminder.summary}\n读取：subagent_get(taskId="${record.id}", reminderIndex=${reminder.index})`, 'continuity.subagent.reminder');
        return `Evidence saved; reminder ${reminder.index} submitted. Task continues. Memory unchanged.`;
      } };
    const tools = owned.map(({ owner, tool }): ToolDef => ({ ...tool, handler: async (args, ctx) => {
      if (stopped()) return { failed: true, text: '[stopped] Tool was not executed.' };
      const group = this.catalogue(record.source === 'world' && owner !== 'memory' ? 'world' : 'main').find(group => group.id === owner);
      const entry = group?.tools.find(entry => entry.name === tool.name);
      if (!group?.enabled || !entry?.allowed || !entry.available) return { failed: true, text: '[permission denied] Tool was not executed: ' + tool.name };
      const live = this.ownedTools().find(current => current.owner === owner && current.tool.name === tool.name);
      return live ? live.tool.handler(args, { ...ctx, role: 'subagent' }) : { failed: true, text: '[unavailable] ' + tool.name };
    } }));
    let result = this.store.result(record.id), status: TaskStatus = 'failed', summary = '', reason = 'error';
    try {
      const taskMessages = await this.d.messages({ ...assignment, context: snapshot.length ? 'main' : 'isolated', taskId: record.id, worldId: record.worldId }, config, owned);
      const messages = snapshot.length ? [...snapshot, ...taskMessages] : taskMessages;
      if (!stopped()) {
        const outcome = await runWorker({ core: runtime, llm, spec, messages, log: this.d.core()!.log, tools: [...tools, finish, notify], ...config,
          contextTokens: record.contextTokens, signal: active.controller.signal, label: (record.worldId ?? '主线') + ' · ' + charSlice(record.task, 0, 40), stopped, finished: () => !!closure,
          progress: progress => {
            record.rounds = progress.rounds; record.peakInputTokens = progress.peakInputTokens; record.estimatedInputTokens = progress.estimatedInputTokens;
            if (active.stop) this.store.save(record); else this.store.writeResult(record, progress.text);
          } });
        result = closure?.result ?? outcome.text; reason = outcome.reason;
        status = closure?.status ?? (outcome.reason === 'natural' && result.trim() ? 'complete' : result.trim() ? 'partial' : 'failed');
        summary = closure?.summary ?? (status === 'complete' ? charSlice(result, 0, config.maxSummaryChars) : 'Worker ended: ' + reason);
      }
    } catch (error) { summary = 'Worker failed: ' + String(error); result = this.store.result(record.id) || String(error); }
    if (active.stop) { status = active.stop.status; reason = active.stop.reason; summary = 'Worker stopped: ' + reason; result = this.store.result(record.id); }
    Object.assign(record, { status, endReason: reason, summary: charSlice(summary, 0, config.maxSummaryChars), finishedAt: new Date().toISOString() });
    this.store.writeResult(record, result);
    active.settle(status === 'complete' || status === 'partial' ? { text: status === 'partial' ? `[partial: ${reason}]\n${result}` : result } : { error: summary });
    if (record.source === 'main' && this.canRun()) this.d.core()!.injectInternal(subagentCompletionText(record, config.maxSummaryChars), 'continuity.subagent');
  }
  private requestStop(active: ActiveTask, status: StopStatus, reason: string): void {
    if (active.stop || active.record.status !== 'running') return;
    active.stop = { status, reason }; active.record.status = 'stopping'; active.record.endReason = reason;
    active.controller.abort(new Error(reason)); active.settle({ error: 'Worker stopped: ' + reason }); this.store.save(active.record);
  }
  stopWorld(id: string): void {
    for (const active of this.active.values()) if (active.record.worldId === id) this.requestStop(active, 'interrupted', 'world_unmounted_or_restarted');
  }
  stop(): void {
    this.stopped = true;
    for (const active of this.active.values()) this.requestStop(active, 'interrupted', 'shutdown');
  }
}
