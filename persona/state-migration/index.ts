/** User-started migration runs in a child; only completed candidates and Dream tasks survive a restart. */
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childExecArgv } from 'cortico/extensions/runtime.ts';
import type { CoreApi } from 'cortico/core/types.ts';
import type { Core } from 'cortico/core/core.ts';
import { GenerationError } from 'cortico/core/generation.ts';
import { itemText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import type { GitWorkspaceMemory } from '../../base/persona/memory.ts';
import type { Appraiser } from '../appraisal.ts';
import type { PersonaConfig } from '../config.ts';
import type { Dream } from '../subconscious/index.ts';
import { parseState, renderState, validateState } from '../state-document.ts';
import { migrationMinutes, type FromChild, type MigrationInput, type MigrationState, type ToolGroup } from './contracts.ts';

export const migrationTaskPrefix = '[state-migration:';
export function migrationTask(id: string): string {
  const candidate = `note/state-migration/${id}/candidate.md`;
  return `${migrationTaskPrefix}${id}] 应用已生成的 STATE 迁移候选。候选：${candidate}；目标：state/STATE.md。
1. 完整读取候选与当前 STATE；若候选已被搬空，跳过清空和搬运，继续剩余差异。若 STATE 已是中间空文件，不把它当作新的删除要求。
2. 首次应用时结合近期反馈检查差异；需要保留的当前内容先记入同目录 differences.md。恢复时不自动重建已有差异便笺。
3. 候选尚未搬入时，依次 write_file(path="state/STATE.md", content="")，再 move_file(from="${candidate}", to="state/STATE.md", offset=1)，不填 limit。原样搬入，正文不经模型重抄。
4. 根据 differences.md 处理冲突，保留仍有效的内容和最新要求，必要时使用现有 edit_file、write_file 或 update_state。
5. 完成后移除此待办，并用现有文件工具清理本任务的候选及差异便笺。不要求写后读回。`;
}

/** Keep delivered dialogue and calls, excluding system prefixes and private reasoning. */
export function historyText(records: unknown[]): string {
  const text: string[] = [];
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as ContextRecord;
    const item = record.item;
    if (!item || record.context?.head || record.context?.ephemeral) continue;
    if (item.type === 'reasoning' || item.type === 'message' && item.role === 'system') continue;
    const body = item.type === 'function_call' ? `${item.name} ${item.arguments}` : itemText(item);
    if (!body || body.includes('[system/continuity-state]')) continue;
    text.push(`[${record.context?.ts ?? ''} ${item.type}${item.type === 'message' ? ':' + item.role : ''}] ${body}`);
  }
  return text.join('\n\n');
}

/** Read retained original materials and transcripts from multiple runs, not configuration or logs. */
export async function migrationHistory(dataDir?: string): Promise<MigrationInput['history']> {
  if (!dataDir) return [];
  const history: MigrationInput['history'] = [];
  const names = async (dir: string) => {
    try { return await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const load = async (path: string, id: string, jsonl: boolean) => {
    let records: unknown[];
    try {
      const raw = await readFile(path, 'utf8');
      records = jsonl ? raw.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : JSON.parse(raw);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const text = historyText(records);
    if (text) history.push({ id, text });
  };
  const materials = join(dataDir, 'continuity', 'dream', 'raw');
  for (const file of await names(materials)) if (file.endsWith('.json')) await load(join(materials, file), 'material/' + file, false);
  const runs = join(dataDir, 'runs');
  for (const run of await names(runs)) await load(join(runs, run, 'transcript.jsonl'), 'run/' + run, true);
  await load(join(dataDir, 'session-main.jsonl'), 'current/main', true);
  return history;
}

interface MigrationDeps {
  memory: GitWorkspaceMemory; dataDir?: string; runtime(): Core | null; dream(): Dream | null | undefined; api(): CoreApi | null;
  enabled(): boolean; appraiser: Appraiser; appraisalConfig(): PersonaConfig['appraisal']; tools(): ToolGroup[];
  readChars(): number; contextTokens(): number;
}
interface Active { id: string; child?: ChildProcess; abort: AbortController; timer: ReturnType<typeof setTimeout>; state: MigrationState }
export class StateMigration {
  private active?: Active;
  private last: MigrationState = { status: 'idle' };
  private deliveredId?: string;
  constructor(private readonly d: MigrationDeps) {}
  state(): MigrationState {
    if (this.active) return { ...this.active.state };
    const task = this.d.dream()?.getStatus().pendingTasks.find(task => task.startsWith(migrationTaskPrefix));
    if (task) {
      const id = task.slice(migrationTaskPrefix.length).split(']')[0];
      return { status: this.d.dream()!.taskInProgress(task) ? 'applying' : 'waiting', id };
    }
    if (this.deliveredId) return { status: 'complete', id: this.deliveredId };
    return { ...this.last };
  }
  async start(minutes: unknown): Promise<MigrationState> {
    const duration = migrationMinutes(minutes);
    if (['running', 'waiting', 'applying'].includes(this.state().status)) throw new Error('已有迁移任务');
    if (!this.d.enabled()) throw new Error('请先开启强化STATE约束');
    const unavailable = this.d.appraiser.reviewUnavailable();
    if (unavailable) throw new Error(unavailable);
    const runtime = this.d.runtime(), dream = this.d.dream();
    if (!runtime || !dream) throw new Error('服务尚未启动');
    const state = parseState(this.d.memory.exists('state/STATE.md') ? this.d.memory.readFile('state/STATE.md') : '');
    if (!state.raw.trim() || state.structured && !state.needsScopeMigration) throw new Error('当前 STATE 无须迁移');
    const id = randomUUID();
    this.deliveredId = undefined;
    const llm = runtime.llm.bind?.() ?? runtime.llm;
    const spec = structuredClone(runtime.activeSpec());
    const appraisal = structuredClone(this.d.appraisalConfig());
    const tools = this.d.tools();
    const sources = Object.fromEntries(this.d.memory.walkFiles().filter(path => /\.md$/iu.test(path) && !path.startsWith('note/state-migration/'))
      .map(path => [path, this.d.memory.readFile(path)]));
    const contextTokens = Math.min(this.d.contextTokens(), this.d.api()?.sessionInfo('main').hardTokens ?? Infinity);
    const active: Active = { id, abort: new AbortController(), state: { id, status: 'running', rounds: 0 },
      timer: setTimeout(() => this.stopActive('整理超时，未应用 STATE'), duration * 60000) };
    this.active = active;
    this.d.api()?.log.info('STATE migration started', { id, maxMinutes: duration });
    void (async () => {
      const history = await migrationHistory(this.d.dataDir);
      if (this.active !== active || active.abort.signal.aborted) return;
      const child = fork(fileURLToPath(new URL('./engine-child.ts', import.meta.url)), [], {
        execArgv: childExecArgv(), serialization: 'advanced', windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: Object.fromEntries(['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
      });
      active.child = child;
      let observed: ContextRecord[] = [];
      const track = runtime.sessions.open('subagent', 'STATE 迁移', { messagesRef: () => observed });
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      child.on('message', (message: FromChild) => {
        if (this.active !== active || active.abort.signal.aborted) return;
        if (message.kind === 'progress') { active.state.rounds = message.value.rounds; return; }
        if (message.kind === 'failed') { this.stopActive(message.error); return; }
        if (message.kind === 'candidate') {
          try {
            if (!['ready', 'diminishing_returns'].includes(message.value.reason)) throw new Error('无效迁移结果');
            const document = validateState(message.value.document);
            const path = `note/state-migration/${id}/candidate.md`;
            this.d.memory.writeFileAtomic(path, renderState(document));
            dream.addPendingTask(migrationTask(id));
            this.d.api()?.log.info('STATE migration candidate ready', { id, path, reason: message.value.reason });
            this.deliveredId = id; this.last = { status: 'waiting', id };
            clearTimeout(active.timer); this.active = undefined;
          } catch (error) { this.stopActive(String(error)); }
          return;
        }
        void (async () => {
          let value: unknown, error: string | undefined;
          try {
            if (message.method === 'generate') {
              const args = message.args as { input: Parameters<typeof llm.respond>[0]; context: ContextRecord[] };
              observed = args.context;
              try {
                const result = await llm.respond(args.input, { role: 'subagent', sessionId: track.id, context: observed, nativeSpec: spec, signal: active.abort.signal });
                track.recordAttempts(result.attempts, observed); value = result;
              } catch (failure) { if (failure instanceof GenerationError) track.recordAttempts(failure.attempts, observed); throw failure; }
            } else if (message.method === 'review') {
              const args = message.args as { action: unknown; constraints: StateDocumentConstraints; history: unknown[] };
              value = await this.d.appraiser.reviewAction(args.action, args.constraints, args.history, appraisal, this.d.api()?.log.child('state-migration'));
            } else throw new Error('Unknown migration request');
          } catch (failure) { error = String(failure); }
          if (child.connected && this.active === active) child.send({ kind: 'reply', id: message.id, value, error });
        })();
      });
      child.on('error', error => { if (this.active === active) this.stopActive(String(error)); });
      child.on('exit', (code) => { track.close(); if (this.active === active) this.stopActive('整理进程已退出：' + (stderr || String(code))); });
      child.send({ kind: 'init', input: { spec, contextTokens, sources, history, tools, readChars: this.d.readChars() } satisfies MigrationInput });
    })().catch(error => { if (this.active === active) this.stopActive(String(error)); });
    return this.state();
  }
  cancel(): MigrationState {
    if (this.active) { this.stopActive(); return this.state(); }
    const dream = this.d.dream();
    const task = dream?.getStatus().pendingTasks.find(task => task.startsWith(migrationTaskPrefix));
    if (!task || !dream) return this.state();
    if (dream.taskInProgress(task)) throw new Error('Dream 已开始应用，等待此次入梦处理完成');
    const id = task.slice(migrationTaskPrefix.length).split(']')[0];
    dream.removePendingTask(task);
    for (const name of ['candidate.md', 'differences.md']) {
      const path = `note/state-migration/${id}/${name}`;
      if (this.d.memory.exists(path)) this.d.memory.deleteFile(path);
      this.d.memory.pruneEmptyDirs(path);
    }
    this.deliveredId = undefined; this.last = { status: 'idle' };
    return this.state();
  }
  stop(): void { if (this.active) this.stopActive('服务已停止，未应用 STATE'); }
  private stopActive(reason?: string): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined; clearTimeout(active.timer); active.abort.abort(); active.child?.kill();
    this.d.api()?.log.info('STATE migration ended', { id: active.id, reason: reason ?? 'cancelled' });
    this.last = reason ? { status: 'failed', reason } : { status: 'idle' };
  }
}
type StateDocumentConstraints = ReturnType<typeof validateState>['constraints'];
