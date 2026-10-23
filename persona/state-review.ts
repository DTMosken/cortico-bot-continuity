/** Tool handlers review actions before side effects; pending actions live only for their turn. */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoreApi, ToolCallContext, ToolDef, ToolOutcome, ToolSpec } from 'cortico/core/types.ts';
import type { GitWorkspaceMemory } from '../base/persona/memory.ts';
import type { Appraiser } from './appraisal.ts';
import { appliesTo, STATE_PATH, StateDocuments, UPDATE_STATE_SPEC, type StateSnapshot } from './state-document.ts';

export const RESOLVE_STATE_SPEC: ToolSpec = {
  name: 'state_review_resolve', tags: ['flow'],
  description: 'Resolve a staged action in this session. cancel discards it; proceed requires a reason for proceeding and executes the unchanged action once. To revise, cancel then resubmit the original tool. Skipped later calls are never replayed automatically.',
  parameters: { type: 'object', properties: {
    id: { type: 'string' }, decision: { type: 'string', enum: ['cancel', 'proceed'] }, reason: { type: 'string' },
  }, required: ['id', 'decision'] },
};

interface TurnReview { enabled: boolean; failed: boolean }
interface Metadata { migrationNotified: boolean; migrationPending: boolean; outageNotified: boolean; scopeMigrationNotified?: boolean }
interface Pending {
  id: string; role: string; tool: ToolDef; args: Record<string, unknown>; stateRevision: string;
  targetRevision: string; target: () => string;
}
interface ReviewOptions {
  memory: GitWorkspaceMemory; appraiser: Appraiser; enabled: () => boolean; core: () => CoreApi | null;
  speechContext: (name: string, args: Record<string, unknown>) => { scene?: string | null; target?: unknown; recentDialogue: unknown[] };
  readOverride: (path: string, role: string) => string | null;
  dataDir?: string;
}
export type ReadReview = (name: string, args: Record<string, unknown>) => { read: Record<string, unknown>; revision: string } | undefined;
interface PreparedAction { action: Record<string, unknown>; history: unknown[]; target: () => string }
type FileSnapshot = { kind: 'file'; revision: string; bytes: number; text?: string }
  | { kind: 'missing' | 'directory' | 'unavailable' };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const outputText = (value: string | ToolOutcome): string => typeof value === 'string' ? value : value.text;
const effects = (tool: ToolDef): boolean => tool.tags.some(tag => ['write', 'speak', 'act'].includes(tag));
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value)
  : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? parseInt(value, 10) : undefined;

export class StateReview {
  readonly documents: StateDocuments;
  private readonly turns = new Map<string, TurnReview>();
  private readonly pending = new Map<string, Pending>();
  private readonly stateReads = new Map<string, string>();
  private readonly metadataFile?: string;
  private metadata: Metadata = { migrationNotified: false, migrationPending: false, outageNotified: false };
  private draft: { args: Record<string, unknown>; revision: string } | null = null;
  private failureReason = '';
  private diagnostic = '';

  constructor(private readonly options: ReviewOptions) {
    this.documents = new StateDocuments(options.memory);
    this.metadataFile = options.dataDir ? join(options.dataDir, 'continuity', 'state-review.json') : undefined;
    if (this.metadataFile && existsSync(this.metadataFile)) this.metadata = JSON.parse(readFileSync(this.metadataFile, 'utf8'));
  }

  private save(): void {
    if (!this.metadataFile) return;
    mkdirSync(dirname(this.metadataFile), { recursive: true });
    writeFileSync(this.metadataFile + '.tmp', JSON.stringify(this.metadata) + '\n');
    renameSync(this.metadataFile + '.tmp', this.metadataFile);
  }

  unavailable(): string | null { return this.options.appraiser.reviewUnavailable(); }
  status(): { enabled: boolean; available: boolean; reason: string; status: string; migrationPending: boolean } {
    const unavailable = this.unavailable();
    const enabled = this.options.enabled();
    const snapshot = enabled ? this.documents.read() : null;
    const failed = !!this.failureReason;
    const waiting = enabled && !this.resolverAvailable('main');
    return { enabled, available: !unavailable, reason: unavailable ?? snapshot?.error ?? (snapshot?.needsScopeMigration ? '约束缺少适用范围，下一次正常 Dream 补齐；当前使用完整 STATE' : failed ? this.failureReason : waiting ? '主线程工具表待刷新；当前继续使用完整 STATE' : ''),
      status: !enabled ? '关闭' : unavailable ? '不可用' : snapshot?.error ? '文档格式错误'
        : snapshot?.raw.trim() && (!snapshot.structured || snapshot.needsScopeMigration) ? '待整理约束' : failed ? '故障回退' : waiting ? '待刷新工具' : '已开启',
      migrationPending: this.metadata.migrationPending };
  }

  begin(role: string): void {
    if (!this.turns.has(role)) this.turns.set(role, { enabled: this.options.enabled(), failed: false });
    const snapshot = this.documents.read();
    this.checkMigration(snapshot, this.turns.get(role)!.enabled);
    const error = this.turns.get(role)!.enabled ? snapshot.error ?? this.unavailable() ?? '' : '';
    if (error && error !== this.diagnostic) this.options.core()?.injectInternal('[system/state-review] 使用完整 STATE：' + error, 'state-review');
    this.diagnostic = error;
  }

  private checkMigration(snapshot: StateSnapshot, enabled: boolean): void {
    if (snapshot.structured && !snapshot.needsScopeMigration && this.metadata.migrationPending) { this.metadata.migrationPending = false; this.save(); }
    const notice = snapshot.needsScopeMigration ? 'scopeMigrationNotified' : 'migrationNotified';
    if (enabled && !this.unavailable() && (!snapshot.structured || snapshot.needsScopeMigration) && !snapshot.error
      && snapshot.raw.trim()) {
      const notify = !this.metadata[notice];
      if (notify || !this.metadata.migrationPending) { this.metadata[notice] = true; this.metadata.migrationPending = true; this.save(); }
      if (notify) this.options.core()?.injectInternal('[system/state-review] STATE 需要整理行动约束及适用范围，当前继续使用完整提示词。下一次正常 Dream 将整理已有内容并补齐 scope，不额外入梦。', 'state-review-migration');
    }
  }

  text(_role: string): string { return this.documents.read().raw; }
  reviewing(role: string): boolean {
    const turn = this.turns.get(role);
    const snapshot = this.documents.read();
    return !!turn?.enabled && !turn.failed && this.resolverAvailable(role) && !this.unavailable() && snapshot.structured && !snapshot.needsScopeMigration;
  }
  private resolverAvailable(role: string): boolean {
    const core = this.options.core();
    return role !== 'main' || !core || core.toolsTagged('flow').has(RESOLVE_STATE_SPEC.name);
  }
  migrationTask(): string {
    return this.options.enabled() && this.metadata.migrationPending
      ? 'Use update_state to organize the action constraints worth reviewing. Read the full STATE.md, CONSTITUTION.md, and other existing documents that define enduring hard constraints on your actions. Preserve ordinary STATE text and the meaning of existing rules. Collect relevant hard constraints from those documents into the STATE action-constraint section; do not limit the review to rules already in STATE. Do not turn soft preferences, factual records or temporary plans into hard constraints, invent new commitments, or rewrite source commitments as part of this migration. Every constraint must include scope.sessions (main and/or dream) and at least one of scope.tools (exact available tool names) or scope.tags (tool categories). Follow update_state guidance to split actions and select scopes from the actual session tools. Content conditions and semantic timing belong in instruction or exceptions. Fill missing scopes in existing structured constraints too. Empty constraints are a valid explicit result when none of the existing commitments warrants action review.' : '';
  }
  changed(): void {
    if (!this.options.enabled()) this.pending.clear();
    this.checkMigration(this.documents.read(), this.options.enabled());
    this.options.core()?.injectInternal(`[system/state-review] 审核已${this.options.enabled() ? '开启，下轮 turn 或下次 Dream 生效' : '关闭，未执行的暂存已取消，需要时请重新提交'}；工具显示随现有前缀／工具表刷新更新。`, 'state-review');
  }
  end(role: string): void {
    this.turns.delete(role);
    this.stateReads.delete(role);
    for (const [id, pending] of this.pending) if (pending.role === role) this.pending.delete(id);
    if (role === 'main') this.draft = null;
  }

  updateTool(): ToolDef {
    return { ...UPDATE_STATE_SPEC, handler: async (args, context) => {
      if (context.role !== 'dream') return '[state update failed] Dream only.';
      try {
        const revision = args.expectedRevision ?? this.stateReads.get(context.role);
        if (revision === undefined) return '[state update failed] Read STATE.md in full before updating it.';
        const next = this.documents.update(args, revision);
        this.stateReads.set(context.role, next.revision);
        if (this.metadata.migrationPending) { this.metadata.migrationPending = false; this.save(); }
        return `[written] ${STATE_PATH}\nSTATE revision: ${next.revision}`;
      } catch (error) { return `[state update failed] ${String(error)}`; }
    } };
  }

  resolveTool(): ToolDef {
    return { ...RESOLVE_STATE_SPEC, handler: async (args, context) => {
      const item = typeof args.id === 'string' ? this.pending.get(args.id) : undefined;
      if (!item || item.role !== context.role) return '[state review failed] Unknown or expired staged ID in this session; resubmit the original tool if needed.';
      if (args.decision !== 'proceed' && args.decision !== 'cancel') return '[state review failed] Use cancel or proceed.';
      if (args.decision === 'cancel') { this.pending.delete(item.id); return '[state review cancelled] Nothing executed; resubmit changed actions using the original tool.'; }
      if (typeof args.reason !== 'string' || !args.reason.trim()) return '[state review failed] A nonempty reason for proceeding is required.';
      if (context.signal?.aborted) return '[state review failed] Call aborted.';
      if (!this.options.enabled() || this.documents.read().revision !== item.stateRevision || item.target() !== item.targetRevision || !this.available(item.tool, context.role)) {
        this.pending.delete(item.id);
        return '[state review failed] Mode, STATE, target or tool availability changed. Read current content and resubmit.';
      }
      this.pending.delete(item.id);
      return this.execute(item.tool, item.args, context);
    } };
  }

  private available(tool: ToolDef, role: string): boolean {
    const core = this.options.core();
    return role !== 'main' || !core || tool.tags.some(tag => core.toolsTagged(tag).has(tool.name));
  }

  wrap(tools: ToolDef[], role: string, readReview?: ReadReview): ToolDef[] {
    return tools.map(tool => tool.name === RESOLVE_STATE_SPEC.name ? tool : { ...tool, handler: async (args, context) => {
      this.begin(role);
      const turn = this.turns.get(role)!;
      if (effects(tool) && !(tool.name === 'qq_confirm' && args.decision === 'cancel')
        && [...this.pending.values()].some(item => item.role === role)) return '[state review waiting] A preceding action is staged. Nothing executed; resolve it before resubmitting this call.';
      if (!this.reviewing(role) || tool.tags.includes('flow') || tool.name === 'qq_confirm' && args.decision === 'cancel') return this.execute(tool, args, context);
      const snapshot = this.documents.read();
      const constraints = snapshot.constraints.filter(rule => appliesTo(rule, role, tool));
      if (!constraints.length) return this.execute(tool, args, context);
      const prepared = this.prepare(tool, args, role, readReview);
      const targetRevision = prepared.target();
      const assessment = await this.options.appraiser.reviewAction(prepared.action, constraints, prepared.history, undefined, context.log.child('state-review'));
      if (context.signal?.aborted || this.turns.get(role) !== turn) return '[state review stopped] Turn ended; nothing executed.';
      if (this.documents.read().revision !== snapshot.revision || prepared.target() !== targetRevision || !this.available(tool, role)) return '[state review stopped] STATE, target or tool availability changed during review. Read current content and resubmit.';
      if (assessment.kind === 'unavailable') {
        turn.failed = true; this.failureReason = assessment.reason;
        let notice = '';
        if (!this.metadata.outageNotified) {
          this.metadata.outageNotified = true; this.save();
          notice = `[system/state-review] 审核失败：${assessment.reason}。本轮按现有 STATE 提示继续执行；你可以通知维护者。\n`;
        }
        const result = await this.execute(tool, args, context);
        return notice ? { ...(typeof result === 'string' ? {} : result), text: notice + outputText(result) } : result;
      }
      if (assessment.kind === 'reviewed') {
        this.failureReason = '';
        if (this.metadata.outageNotified) { this.metadata.outageNotified = false; this.save(); }
      }
      const conflicts = assessment.kind === 'reviewed' ? constraints.filter(rule => assessment.choices[rule.id] !== 'allow') : constraints;
      if (!conflicts.length) return this.execute(tool, args, context);
      if (!this.options.enabled()) return '[state review stopped] Review was disabled; nothing executed. Resubmit if still needed.';
      const id = randomUUID();
      this.pending.set(id, { id, role, tool, args: structuredClone(args), stateRevision: snapshot.revision, targetRevision, target: prepared.target });
      return `[state review staged] ${JSON.stringify({ id, tool: tool.name, constraints: conflicts.map(rule => ({ id: rule.id, instruction: rule.instruction, exceptions: rule.exceptions })) })}\n`
        + (assessment.kind === 'insufficient' ? assessment.reason + '\n' : '')
        + '尚未执行。通过 state_review_resolve 取消或填写理由后坚持执行。修改时先取消，再用原工具提交新参数。';
    } });
  }

  private prepare(tool: ToolDef, args: Record<string, unknown>, role: string, readReview?: ReadReview): PreparedAction {
    const action: Record<string, unknown> = { tool: tool.name, args };
    const history: unknown[] = [];
    if (tool.tags.includes('speak')) {
      const { recentDialogue, ...scene } = this.options.speechContext(tool.name, args);
      const reply = tool.name === 'qq_confirm' ? this.draft?.args.reply_to : args.reply_to;
      const replyId = reply === undefined ? '' : String(reply).replace(/^#/u, '');
      const necessary = recentDialogue.filter((item, index) => index === recentDialogue.length - 1
        || !!replyId && !!item && typeof item === 'object' && String((item as { messageId?: unknown }).messageId ?? '') === replyId);
      action.context = { ...scene, recentDialogue: necessary };
      history.push(...recentDialogue.filter(item => !necessary.includes(item)));
    }
    if (tool.name === 'qq_confirm') return { action: { ...action, draft: this.draft?.args ?? null }, history, target: () => this.draft?.revision ?? '' };
    const preview = tool.tags.includes('read') ? readReview?.(tool.name, args) : undefined;
    if (preview) return { action: { ...action, read: preview.read }, history, target: () => readReview!(tool.name, args)?.revision ?? '' };
    const paths = [args.path, args.from, args.to].filter((value): value is string => typeof value === 'string');
    if (!['read_file', 'write_file', 'edit_file', 'append_file', 'delete_file', 'move_file', 'update_state', 'save_blob'].includes(tool.name)) {
      if (tool.tags.includes('read')) action.read = { chars: null, lines: null };
      return { action, history, target: () => '' };
    }
    const binaryRead = tool.name === 'read_file' && String(args.path ?? '').replaceAll('\\', '/').replace(/^\.\//u, '').startsWith('blobs/');
    let selected = tool.name === 'update_state' ? [STATE_PATH] : paths;
    if (tool.name === 'save_blob') {
      try { selected = [this.options.memory.blobs.resolvePath(String(args.path ?? '').trim())]; }
      catch { return { action, history, target: () => 'invalid path' }; }
      action.destination = selected[0];
    }
    const current = (): Record<string, FileSnapshot> => Object.fromEntries(selected.map(path => {
      try {
        const absolute = this.options.memory.insideWorkspace(path);
        if (statSync(absolute).isDirectory()) return [path, { kind: 'directory' }];
        const bytes = readFileSync(absolute);
        return [path, { kind: 'file', revision: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength,
          ...(!binaryRead && tool.name !== 'save_blob' ? { text: bytes.toString('utf8') } : {}) }];
      } catch (error) { return [path, { kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' }]; }
    }));
    const before = current();
    const first = Object.values(before)[0];
    const original = first?.kind === 'file' ? first.text ?? '' : '';
    if (tool.name === 'read_file') {
      const virtual = this.options.readOverride(String(args.path ?? ''), role);
      if (virtual === null && binaryRead) return { action: { ...action, read: { binary: true, chars: 0, lines: 0,
        bytes: first?.kind === 'file' ? first.bytes : null } }, history, target: () => hash(current()) };
      const text = virtual ?? original;
      const offset = integer(args.offset), limit = integer(args.limit);
      const lines = text.split('\n');
      const total = !text ? 0 : text.endsWith('\n') ? lines.length - 1 : lines.length;
      const start = Math.max(1, !offset ? 1 : offset > 0 ? offset : total + offset + 1);
      const end = limit === undefined ? total : Math.min(total, start + Math.max(limit, 1) - 1);
      const full = virtual !== null || offset === undefined && limit === undefined;
      const selectedText = full ? text : start > total ? '' : lines.slice(start - 1, end).join('\n');
      action.read = { offset: offset ?? null, limit: limit ?? null, lines: full ? total : Math.max(0, end - start + 1), chars: selectedText.length,
        full: full || start === 1 && end >= total, missing: virtual === null && first?.kind === 'missing' };
    } else if (tool.name === 'edit_file') {
      const old = String(args.old_string ?? '');
      action.change = { before: old, after: String(args.new_string ?? ''), context: original.slice(Math.max(0, original.indexOf(old) - 160), original.indexOf(old) + old.length + 160) };
    } else if (tool.name === 'append_file') action.previousTail = original.slice(-240);
    else if (tool.name === 'save_blob') action.previousBytes = first?.kind === 'file' ? first.bytes : null;
    else action.before = Object.fromEntries(Object.entries(before).map(([path, file]) => [path, file.kind === 'file' ? file.text : file.kind === 'missing' ? null : { kind: file.kind }]));
    return { action, history, target: () => hash(Object.entries(current()).map(([path, file]) => [path, file.kind, file.kind === 'file' ? file.revision : null])) };
  }

  private async execute(tool: ToolDef, args: Record<string, unknown>, context: ToolCallContext): Promise<string | ToolOutcome> {
    const state = tool.name === 'read_file' && this.options.memory.normalize(String(args.path ?? '')) === STATE_PATH ? this.documents.read() : null;
    const result = await tool.handler(args, context);
    const text = outputText(result);
    if (tool.name === 'qq_draft' && text.startsWith('[draft staged')) this.draft = { args: structuredClone(args), revision: randomUUID() };
    if (tool.name === 'qq_confirm' && (args.decision === 'cancel' || /^\[sent/u.test(text))) this.draft = null;
    if (tool.endsTurn) this.end(context.role);
    if (state && integer(args.offset) === undefined && integer(args.limit) === undefined && text === state.raw) this.stateReads.set(context.role, state.revision);
    return result;
  }
}
