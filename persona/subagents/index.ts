/**
 * Single-task workers persist their receipts separately from the main context.
 * Operator permissions bound each task's tool selection and are checked again on every invocation.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CoreApi, SessionDecl, ToolDef, World } from 'cortico/core/types.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { subagentsConfig, type SubagentsConfig } from './config.ts';
import { charLength, charSlice, TaskStore, type TaskRecord, type TaskStatus } from './store.ts';

export const SUBAGENT = 'subagent';
const MEMORY_READ_TOOLS = new Set(['read_file', 'list_files', 'glob_files', 'grep_files']);
const TAGS = ['read', 'write', 'speak', 'act', 'flow', 'snapshot'] as const;

export interface Assignment { task: string; materials: string[]; tools: string[]; }
export interface ToolEntry {
  name: string; description: string; tags: string[]; allowed: boolean; available: boolean; reason?: string;
}
export interface ToolGroup { id: string; label: string; enabled: boolean; tools: ToolEntry[]; }
interface OwnedTool { owner: string; tool: ToolDef; }
interface SubagentsDependencies {
  config(): SubagentsConfig;
  core(): CoreApi | null;
  memoryTools(): ToolDef[];
  worlds: World[];
  messages(assignment: Assignment & { taskId: string }, config: SubagentsConfig, tools: OwnedTool[]): Promise<ContextRecord[]>;
  savePermissions(): void;
  isRunning(): boolean;
  isWorldVisible(id: string): boolean;
  dataDir?: string;
}
type Closure = { status: 'complete' | 'partial' | 'failed'; summary: string; result: string };

function lockReason(owner: string, tool: ToolDef): string | undefined {
  if (owner === 'memory' && !MEMORY_READ_TOOLS.has(tool.name)) return 'Memory 只读';
  if (tool.tags.includes('speak')) return '对外发送由主 agent 执行';
  if (tool.tags.includes('flow') || tool.endsTurn) return '主线调度由主 agent 执行';
  if (tool.name === 'qq_view_image') return 'worker 首版只接收文本回执';
  return undefined;
}
function readOnly(tool: ToolDef): boolean {
  return tool.tags.includes('read') && !tool.tags.some(tag => ['write', 'speak', 'act', 'flow'].includes(tag));
}
function integer(value: unknown, fallback: number, maximum: number): number {
  const number = value === undefined ? fallback : value;
  if (!Number.isInteger(number) || (number as number) < 0 || (number as number) > maximum) throw new Error('分页范围无效');
  return number as number;
}
function brief(record: TaskRecord) {
  const { id, task, status, startedAt, finishedAt, summary, resultChars, tools, softRounds, maxRounds } = record;
  return { id, task, status, startedAt, finishedAt, summary, resultChars, tools: [...tools], softRounds, maxRounds };
}

export class Subagents {
  private readonly store: TaskStore;
  private readonly active = new Map<string, Promise<void>>();
  private stopped = false;
  private startingConfig: SubagentsConfig | null = null;

  constructor(private readonly d: SubagentsDependencies) {
    this.store = new TaskStore(d.dataDir ? join(d.dataDir, 'continuity', 'subagents') : undefined);
  }
  private canRun(): boolean { return !this.stopped && this.d.isRunning(); }
  private ownedTools(): OwnedTool[] {
    return [
      ...this.d.memoryTools().map(tool => ({ owner: 'memory', tool })),
      ...this.d.worlds.flatMap(world => world.tools().map(tool => ({ owner: world.id, tool }))),
    ];
  }
  private visible(): Set<string> {
    if (!this.d.worlds.some(world => world.tools().length)) return new Set();
    const core = this.d.core();
    return new Set(core ? TAGS.flatMap(tag => [...core.toolsTagged(tag)]) : []);
  }
  catalogue(): ToolGroup[] {
    const cfg = this.d.config();
    const owned = this.ownedTools();
    const first = Object.keys(cfg.permissions).length === 0;
    let changed = false;
    for (const { owner, tool } of owned) {
      if (!Object.hasOwn(cfg.permissions, owner)) {
        cfg.permissions[owner] = { enabled: true, tools: {} }; changed = true;
      }
      const group = cfg.permissions[owner];
      if (!Object.hasOwn(group.tools, tool.name)) {
        group.tools[tool.name] = first && !lockReason(owner, tool) && readOnly(tool); changed = true;
      }
      if (lockReason(owner, tool) && group.tools[tool.name]) { group.tools[tool.name] = false; changed = true; }
    }
    if (changed) this.d.savePermissions();
    const visible = this.visible();
    const groups = new Map<string, ToolGroup>();
    for (const { owner, tool } of owned) {
      let group = groups.get(owner);
      if (!group) {
        const world = this.d.worlds.find(world => world.id === owner);
        group = { id: owner, label: owner === 'memory' ? 'Memory' : world?.console?.().label ?? owner,
          enabled: cfg.permissions[owner].enabled, tools: [] };
        groups.set(owner, group);
      }
      const reason = lockReason(owner, tool);
      group.tools.push({ name: tool.name, description: tool.description, tags: [...tool.tags],
        allowed: !reason && cfg.permissions[owner].tools[tool.name] === true,
        available: owner === 'memory' || this.d.isWorldVisible(owner) && visible.has(tool.name), ...(reason ? { reason } : {}) });
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
      rounds: () => {
        const cfg = this.startingConfig ?? this.d.config();
        return { soft: cfg.softRounds, hard: cfg.maxRounds };
      } };
  }
  mainTools(): ToolDef[] {
    return [
      { name: 'subagent_spawn', description: 'Delegate one self-contained task with selected materials and an explicit tool subset. Returns a task ID immediately; completion summary arrives asynchronously.',
        tags: ['flow'], parameters: { type: 'object', properties: {
          task: { type: 'string', minLength: 1, description: 'Task and delivery requirements.' },
          materials: { type: 'array', items: { type: 'string' }, description: 'Selected text or references. No main history is copied automatically.' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Explicit subset of currently permitted tools; may be empty.' },
        }, required: ['task', 'materials', 'tools'], additionalProperties: false },
        handler: async args => JSON.stringify(this.spawn(args)) },
      { name: 'subagent_list', description: 'List persisted delegated tasks with status and short summaries, newest first. Full results are retrieved with subagent_get.',
        tags: ['read'], parameters: { type: 'object', properties: {
          offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string', enum: ['running', 'complete', 'partial', 'failed', 'unconfirmed', 'interrupted'] },
        } }, handler: async args => JSON.stringify(this.list(args)) },
      { name: 'subagent_get', description: 'Read a delegated task and one character page of its full result. nextOffset marks the next page; a null value ends the result.',
        tags: ['read'], parameters: { type: 'object', properties: {
          taskId: { type: 'string' }, offsetChars: { type: 'integer', minimum: 0 },
          maxChars: { type: 'integer', minimum: 1, maximum: 32000 },
        }, required: ['taskId'] }, handler: async args => JSON.stringify(this.get(args)) },
    ];
  }
  list(args: Record<string, unknown> = {}) {
    const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER), limit = integer(args.limit, 20, 100);
    if (!limit) throw new Error('页长必须大于 0');
    const records = this.store.all().reverse().filter(record => args.status === undefined || record.status === args.status);
    return { total: records.length, nextOffset: offset + limit < records.length ? offset + limit : null, tasks: records.slice(offset, offset + limit).map(brief) };
  }
  get(args: Record<string, unknown>) {
    if (typeof args.taskId !== 'string') throw new Error('缺少任务 ID');
    const record = this.store.get(args.taskId);
    if (!record) throw new Error('未知任务 ID');
    const offset = integer(args.offsetChars, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(args.maxChars, this.d.config().resultPageChars, this.d.config().resultPageChars);
    if (!limit) throw new Error('页长必须大于 0');
    const text = this.store.result(record.id);
    return { ...brief(record), offsetChars: offset, result: charSlice(text, offset, limit),
      nextOffset: offset + limit < charLength(text) ? offset + limit : null };
  }
  state() { return { groups: this.catalogue(), running: this.active.size, records: this.list().tasks }; }
  normalizePermissions(config: SubagentsConfig): void {
    for (const { owner, tool } of this.ownedTools()) {
      if (lockReason(owner, tool) && config.permissions[owner]?.tools[tool.name]) throw new Error(tool.name + '：' + lockReason(owner, tool));
    }
  }
  spawn(args: Record<string, unknown>) {
    if (!this.canRun() || !this.d.core()) return { accepted: false, reason: 'Subagents are stopped or not attached.' };
    const config = subagentsConfig(this.d.config());
    if (!config.enabled) return { accepted: false, reason: 'Subagents are disabled.' };
    if (this.active.size >= config.maxWorkers) return { accepted: false, reason: 'Worker capacity reached; no task was queued.' };
    if (typeof args.task !== 'string' || !args.task.trim() || !Array.isArray(args.materials) || args.materials.some(value => typeof value !== 'string')
      || !Array.isArray(args.tools) || args.tools.some(value => typeof value !== 'string')) throw new Error('任务、材料和工具列表格式无效');
    const assignment: Assignment = { task: args.task, materials: [...args.materials], tools: [...new Set(args.tools as string[])] };
    const catalogue = this.catalogue();
    const permitted = new Set(catalogue.filter(group => group.enabled).flatMap(group => group.tools.filter(tool => tool.allowed && tool.available).map(tool => tool.name)));
    const denied = assignment.tools.filter(name => !permitted.has(name));
    if (denied.length) return { accepted: false, reason: 'Tools are not permitted or currently available: ' + denied.join(', '),
      availableTools: this.availableToolsText() };
    const owned = this.ownedTools().filter(({ tool }) => assignment.tools.includes(tool.name));
    const record: TaskRecord = { id: randomUUID(), ...assignment, status: 'running', startedAt: new Date().toISOString(),
      summary: '', resultChars: 0, softRounds: config.softRounds, maxRounds: config.maxRounds };
    this.store.save(record);
    const execution = this.run(record, assignment, config, owned);
    this.active.set(record.id, execution);
    void execution.catch(error => this.d.core()?.log.error('子代理记录保存失败', { id: record.id, error: String(error) }))
      .finally(() => this.active.delete(record.id));
    return { accepted: true, taskId: record.id, status: record.status };
  }
  private async run(record: TaskRecord, assignment: Assignment, config: SubagentsConfig, owned: OwnedTool[]): Promise<void> {
    let closure: Closure | null = null;
    const finish: ToolDef = {
      name: 'subagent_finish', description: 'Confirm complete, partial or failed status with a bounded summary and full result. One valid confirmation ends this task.',
      tags: ['flow'], barrierAfter: true,
      parameters: { type: 'object', properties: {
        status: { type: 'string', enum: ['complete', 'partial', 'failed'] },
        summary: { type: 'string', maxLength: config.maxSummaryChars },
        result: { type: 'string', description: 'Full findings, evidence, uncertainty, remaining work and proposed Memory edits or deletions.' },
      }, required: ['status', 'summary', 'result'] },
      handler: async args => {
        if (!this.canRun()) return '[stopped] Worker is shutting down; no confirmation was applied.';
        if (closure) return '[already confirmed]';
        if (typeof args.status !== 'string' || !['complete', 'partial', 'failed'].includes(args.status) || typeof args.summary !== 'string' || typeof args.result !== 'string') return '[bad input] status, summary and result are required.';
        if (charLength(args.summary) > config.maxSummaryChars) return '[bad input] Shorten summary to at most ' + config.maxSummaryChars + ' characters.';
        const next = { ...record, status: args.status as Closure['status'], summary: args.summary, finishedAt: new Date().toISOString() };
        this.store.writeResult(next, args.result);
        Object.assign(record, next);
        closure = { status: next.status, summary: next.summary, result: args.result };
        return '[confirmation accepted]';
      },
    };
    const tools = owned.map(({ owner, tool }): ToolDef => ({ ...tool, handler: async (args, ctx) => {
      if (!this.canRun()) return '[stopped] Worker is shutting down; tool was not executed.';
      const group = this.catalogue().find(group => group.id === owner);
      const entry = group?.tools.find(entry => entry.name === tool.name);
      if (!this.d.config().enabled || !group?.enabled || !entry?.allowed || !entry.available) return '[permission denied] Tool was not executed: ' + tool.name;
      const live = this.ownedTools().find(current => current.owner === owner && current.tool.name === tool.name);
      if (!live) return '[unavailable] Tool was not executed: ' + tool.name;
      const result = await live.tool.handler(args, ctx);
      if (typeof result === 'string') return result;
      if (result.blobs?.length) return '[unsupported] This worker receives text only. ' + result.text;
      return result.failed ? '[failed] ' + result.text : result.text;
    } }));
    try {
      const messages = await this.d.messages({ ...assignment, taskId: record.id }, config, owned);
      if (!this.canRun()) { this.end(record, 'interrupted', 'Worker stopped before execution.', ''); return; }
      this.startingConfig = config;
      let running: Promise<string>;
      try { running = this.d.core()!.spawnFork({ id: SUBAGENT, messages, tools: [...tools, finish],
        stopWhen: () => closure !== null || !this.canRun(),
        wrapUpHint: 'Wrap up this task now. Call subagent_finish with complete, partial or failed status, summary and full result.' }); }
      finally { this.startingConfig = null; }
      const last = await running;
      if (!this.canRun()) {
        if (record.status === 'running') this.end(record, 'interrupted', 'Worker interrupted by shutdown.', last);
        else if (record.status === 'interrupted' && last) this.store.writeResult(record, last);
        return;
      }
      if (!closure) this.end(record, 'unconfirmed', 'Worker ended without a valid subagent_finish confirmation.', last);
      this.notify(record);
    } catch (error) {
      if (record.status === 'running') this.end(record, this.canRun() ? 'failed' : 'interrupted', 'Worker failed: ' + String(error), String(error));
      if (this.canRun()) this.notify(record);
    }
  }
  private end(record: TaskRecord, status: TaskStatus, summary: string, result: string): void {
    Object.assign(record, { status, summary: charSlice(summary, 0, this.d.config().maxSummaryChars), finishedAt: new Date().toISOString() });
    this.store.writeResult(record, result);
  }
  private notify(record: TaskRecord): void {
    this.d.core()!.injectInternal('[subagent completed] ' + JSON.stringify({ taskId: record.id, status: record.status,
      summary: charSlice(record.summary, 0, this.d.config().maxSummaryChars) }), 'continuity.subagent');
  }
  stop(): void {
    this.stopped = true;
    for (const id of this.active.keys()) {
      const record = this.store.get(id)!;
      if (record.status === 'running') this.end(record, 'interrupted', 'Worker interrupted by shutdown.', this.store.result(id));
    }
  }
}
