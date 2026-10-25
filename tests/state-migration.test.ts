import { checkedSources } from './migration-check-fixture.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { ResponsesProvider } from 'cortico/providers/openai-responses-compat/native.ts';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Core } from 'cortico/core/core.ts';
import { SessionTracker } from 'cortico/core/sessions.ts';
import { functionCall, message } from 'cortico/protocol/open-responses/context.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { FakeLLM, toolReply, textReply, makeFakeHarnessApi } from '../../Cortico/tests/core/helpers.ts';
import { composeDefaults } from '../index.ts';
import { Appraiser } from '../persona/appraisal.ts';
import { Dream } from '../persona/subconscious/index.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { parseState } from '../persona/state-document.ts';
import { StateMigration, historyText, migrationHistory, migrationTask } from '../persona/state-migration/index.ts';
import { MIGRATION_DEFAULT_MINUTES, MIGRATION_MIN_MINUTES, MIGRATION_MAX_MINUTES, migrationMinutes, type MigrationInput } from '../persona/state-migration/contracts.ts';
import { migrationWorkerTools, runMigrationWorker } from '../persona/state-migration/worker.ts';
import { dreamOrientation } from '../persona/subconscious/prompts.ts';

const roots: string[] = [], stops: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'migration-test-')); roots.push(dir); return dir; };
const log = nullLogger(), ctx = { role: 'dream', log };
const document = { text: 'Current concern.', constraints: [{ id: 'style', scope: { sessions: ['main'], tools: ['chat_send'] }, instruction: 'Omit processing metadata.', exceptions: '' }] };
const input = (): MigrationInput => ({ spec: { model: 'fixture', thinking: false }, contextTokens: 100000, readChars: 30,
  tools: [{ session: 'main', tools: [{ name: 'chat_send', tags: ['speak'], description: 'Send text.', parameters: { type: 'object', properties: { text: { type: 'string' } } } }] }],
  sources: { 'state/STATE.md': 'Omit processing metadata.', 'CONSTITUTION.md': 'Preserve commitments.' }, history: [] });
function services(llm = new FakeLLM()) {
  const core = { sessions: new SessionTracker('UTC'), internBlobs: () => [] } as unknown as Core;
  return { core, llm, signal: new AbortController().signal, progress() {}, review: async () => ({ kind: 'reviewed', choices: { style: 'allow' } }) };
}

it('validates only the user-selected duration and keeps the declared defaults', () => {
  expect(migrationMinutes(MIGRATION_DEFAULT_MINUTES)).toBe(MIGRATION_DEFAULT_MINUTES);
  expect(migrationMinutes(MIGRATION_MIN_MINUTES)).toBe(MIGRATION_MIN_MINUTES);
  expect(migrationMinutes(MIGRATION_MAX_MINUTES)).toBe(MIGRATION_MAX_MINUTES);
  for (const value of [0, 4, 31, 10.5, '10', undefined]) expect(() => migrationMinutes(value)).toThrow();
});

it('defers initial migration while preserving normal structured STATE maintenance', () => {
  expect(dreamOrientation(true)).toContain('Initial structured migration is an operator-started background task');
  expect(dreamOrientation(true)).not.toContain('Every independently reviewable prohibition needs constraint coverage');
  expect(dreamOrientation()).toContain('Every independently reviewable prohibition needs constraint coverage');
  expect(dreamOrientation()).toContain('How-to instructions, procedures, positive duties and earlier deliberation stay in text');
});

it('reads cross-run retained history and excludes prefixes and reasoning', async () => {
  const dir = root(); mkdirSync(join(dir, 'runs', 'older'), { recursive: true }); mkdirSync(join(dir, 'runs', 'newer'));
  const secret = message('system', 'private prefix');
  writeFileSync(join(dir, 'runs/older/transcript.jsonl'), [secret, message('user', 'older feedback')].map(record => JSON.stringify(record)).join('\n'));
  writeFileSync(join(dir, 'runs/newer/transcript.jsonl'), JSON.stringify(functionCall('a', 'chat_send', '{"text":"newer action"}')));
  const history = await migrationHistory(dir);
  expect(history.map(entry => entry.text).join('\n')).toContain('older feedback'); expect(history.map(entry => entry.text).join('\n')).toContain('newer action');
  expect(history.map(entry => entry.text).join('\n')).not.toContain('private prefix'); expect(await migrationHistory()).toEqual([]);
  expect(historyText([secret, message('user', '[system/continuity-state] old STATE')])).toBe('');
});

it('uses dynamic contracts, validates scopes and requires replay of the latest draft', async () => {
  const source = input(), calls: unknown[] = [];
  const checkLlm = new FakeLLM(); checkLlm.script(textReply(checkedSources(input().sources, ['style'])));
  const worker = migrationWorkerTools(source, { llm: checkLlm, signal: new AbortController().signal, review: async (action, rules, history) => { calls.push({ action, rules, history }); return { kind: 'reviewed', choices: { style: 'allow' } }; } });
  const call = (name: string, args: Record<string, unknown>) => worker.tools.find(tool => tool.name === name)!.handler(args, ctx);
  expect(await call('migration_tools', { names: ['chat_send'] })).toContain('parameters');
  await expect(call('migration_draft', { ...document, constraints: [{ ...document.constraints[0], scope: {} }] })).rejects.toThrow('scope');
  await call('migration_draft', document);
  await expect(call('migration_finish', { reason: 'ready', explanation: 'usable' })).rejects.toThrow();
  await call('migration_review', { session: 'main', tool: 'chat_send', args: { text: 'Hello.' }, expected: 'allow', evidence: 'No metadata.', dialogue: [{ text: 'Hi.' }] });
  expect(calls).toMatchObject([{ action: { tool: 'chat_send', context: { recentDialogue: [{ text: 'Hi.' }] } }, rules: document.constraints }]);
  await call('migration_check', {});
  await call('migration_finish', { reason: 'diminishing_returns', explanation: 'The faithful candidate is usable; further wording changes do not improve the remaining model blind spot.' });
  expect(worker.candidate()).toEqual({ document, reason: 'diminishing_returns' });
  await call('migration_draft', { ...document, text: 'Updated concern.' });
  expect(worker.candidate()).toBeUndefined();
  await expect(call('migration_finish', { reason: 'ready', explanation: 'usable' })).rejects.toThrow();
  await expect(call('migration_review', { session: 'dream', tool: 'chat_send', args: {}, expected: 'allow', evidence: '' })).rejects.toThrow('Unknown tool');
});

it('runs migration beyond ordinary worker round limits with scripted generation and accepts only explicit completion', async () => {
  const llm = new FakeLLM(); llm.script(...Array.from({ length: 35 }, () => toolReply([{ name: 'migration_tools', args: {} }])),
    toolReply([{ name: 'migration_draft', args: document }]),
    toolReply([{ name: 'migration_check', args: {} }]), textReply(checkedSources(input().sources, ['style'])),
    toolReply([{ name: 'migration_review', args: { session: 'main', tool: 'chat_send', args: { text: 'Hello.' }, expected: 'allow', evidence: 'No metadata.' } }]),
    toolReply([{ name: 'migration_finish', args: { reason: 'ready', explanation: 'Faithful and replayed.' } }]));
  const result = await runMigrationWorker(input(), services(llm));
  expect(result.document).toEqual(document); expect(llm.calls.length).toBe(40);
  await expect(runMigrationWorker(input(), services())).rejects.toThrow('没有形成');
});

it('keeps tasks arriving during a Dream for its next run and restores registered tasks after restart', async () => {
  const dir = root(), cfg = composeDefaults(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fork: any;
  const api = makeFakeHarnessApi({ spawnFork: async options => { fork = options; await gate; return ''; } });
  const create = () => new Dream({ cfg, core: api, dataDir: dir, memoryDir: join(dir, 'memory'), dreamTools: () => [], toolUsageText: () => '', log, onEmergence() {} });
  const dream = create(); dream.addPendingTask('earlier');
  const running = dream.schedule([message('user', 'feedback')]);
  await vi.waitFor(() => expect(fork).toBeDefined());
  const task = migrationTask('arrival'); dream.addPendingTask(task);
  expect(dream.taskInProgress('earlier')).toBe(true); expect(dream.taskInProgress(task)).toBe(false);
  const surface = fork.tools.find((tool: any) => tool.name === 'surface');
  const ids = dream.getStatus().runs[0].materialIds;
  await surface.handler({ status: 'complete', processedMaterials: ids, pendingTasks: [], text: '' }, ctx);
  release(); await running;
  expect(dream.getStatus().pendingTasks).toEqual([task]);
  expect(create().getStatus().pendingTasks).toEqual([task]);
  dream.removePendingTask(task); expect(dream.getStatus().pendingTasks).toEqual([]);
});

it('runs a real migration child with scripted provider and only persists candidate plus Dream task', async () => {
  const dir = root(), memory = new GitWorkspaceMemory({ memoryDir: join(dir, 'memory') }), cfg = composeDefaults();
  memory.writeFileAtomic('state/STATE.md', 'Omit processing metadata.'); memory.writeFileAtomic('CONSTITUTION.md', 'Keep meaning.');
  cfg.appraisal!.provider = 'laya';
  const appraiser = new Appraiser(cfg.appraisal!, { loadLaya: async () => ({ systemOne: async () => ({ answers: { rule0: { choice: 'allow' } } }), close: async () => {} }) }); stops.push(() => appraiser.dispose());
  const llm = new FakeLLM(); llm.script(toolReply([{ name: 'migration_draft', args: document }]),
    toolReply([{ name: 'migration_check', args: {} }]), textReply(checkedSources({ 'state/STATE.md': 'Omit processing metadata.', 'CONSTITUTION.md': 'Keep meaning.' }, ['style'])),
    toolReply([{ name: 'migration_review', args: { session: 'main', tool: 'chat_send', args: { text: 'Hello.' }, expected: 'allow', evidence: 'No processing metadata.' } }]),
    toolReply([{ name: 'migration_finish', args: { reason: 'ready', explanation: 'Usable and replayed.' } }]));
  const api = makeFakeHarnessApi(); const dream = new Dream({ cfg, core: api, memoryDir: memory.memoryDir, dreamTools: () => [], toolUsageText: () => '', log, onEmergence() {} });
  const runtime = { ...services(llm).core, llm, activeSpec: () => input().spec } as unknown as Core;
  const deps = { memory, runtime: () => runtime, api: () => api, dream: () => dream, enabled: () => true, appraiser,
    appraisalConfig: () => cfg.appraisal!, tools: () => input().tools, readChars: () => 30, contextTokens: () => 100000 };
  const migration = new StateMigration(deps); stops.push(() => migration.stop());
  expect((await migration.start(MIGRATION_MIN_MINUTES)).status).toBe('running');
  await vi.waitFor(() => expect(migration.state().status).toBe('waiting'), { timeout: 20000 });
  expect(memory.readFile('state/STATE.md')).toBe('Omit processing metadata.');
  const id = migration.state().id!; expect(parseState(memory.readFile(`note/state-migration/${id}/candidate.md`)).constraints).toEqual(document.constraints);
  expect(new StateMigration(deps).state().status).toBe('waiting'); expect(llm.calls).toHaveLength(5);
  const reminders = llm.calls[0].messages.filter(item => typeof item.content === 'string' && item.content.startsWith('[migration time budget]'));
  expect(reminders).toHaveLength(1);
  const notice = reminders[0].content;
  if (typeof notice !== 'string') throw new Error('Missing child time reminder');
  const budget = JSON.parse(notice.split('\n')[0].slice('[migration time budget] '.length));
  expect(budget.remainingSeconds).toBeGreaterThan(0); expect(budget.remainingSeconds).toBeLessThanOrEqual(MIGRATION_MIN_MINUTES * 60);
  expect(budget.finishingReserveSeconds).toBeGreaterThan(0); expect(budget.finishingReserveSeconds).toBeLessThan(MIGRATION_MIN_MINUTES * 60);
  expect(dream.getStatus().pendingTasks).toHaveLength(1);
  migration.cancel(); expect(memory.exists(`note/state-migration/${id}/candidate.md`)).toBe(false); expect(dream.getStatus().pendingTasks).toEqual([]);
}, 25000);

function managerFixture() {
  const dir = root(), memory = new GitWorkspaceMemory({ memoryDir: join(dir, 'memory') }), cfg = composeDefaults();
  memory.writeFileAtomic('state/STATE.md', 'Legacy text.'); cfg.appraisal!.provider = 'laya';
  const appraiser = new Appraiser(cfg.appraisal!, { loadLaya: async () => { throw new Error('No implicit probes'); } });
  stops.push(() => appraiser.dispose());
  const llm = new FakeLLM(), api = makeFakeHarnessApi();
  const dream = new Dream({ cfg, core: api, memoryDir: memory.memoryDir, dreamTools: () => [], toolUsageText: () => '', log, onEmergence() {} });
  const runtime = { ...services(llm).core, llm, activeSpec: () => input().spec } as unknown as Core;
  let enabled = true;
  const migration = new StateMigration({ memory, runtime: () => runtime, api: () => api, dream: () => dream,
    enabled: () => enabled, appraiser, appraisalConfig: () => cfg.appraisal!, tools: () => input().tools, readChars: () => 30, contextTokens: () => 100000 });
  stops.push(() => migration.stop());
  return { migration, memory, llm, dream, cfg, setEnabled: (value: boolean) => { enabled = value; } };
}

it('rejects unavailable/disabled starts without model requests and stops generation without a candidate on timeout', async () => {
  const f = managerFixture(); f.setEnabled(false);
  await expect(f.migration.start(MIGRATION_DEFAULT_MINUTES)).rejects.toThrow('先开启');
  f.setEnabled(true); f.cfg.appraisal!.provider = 'random';
  await expect(f.migration.start(MIGRATION_DEFAULT_MINUTES)).rejects.toThrow(); expect(f.llm.calls).toEqual([]);
  f.cfg.appraisal!.provider = 'laya'; f.llm.blockUntilAbort = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await f.migration.start(MIGRATION_MIN_MINUTES);
    await vi.advanceTimersByTimeAsync(MIGRATION_MIN_MINUTES * 60000);
    expect(f.migration.state()).toMatchObject({ status: 'failed', reason: '整理超时，未应用 STATE' });
    expect(f.dream.getStatus().pendingTasks).toEqual([]); expect(f.memory.readFile('state/STATE.md')).toBe('Legacy text.');
  } finally { vi.useRealTimers(); }
});

it('cancels an in-flight model request and rejects late completion without writing deployed STATE', async () => {
  const f = managerFixture(); f.llm.blockUntilAbort = true;
  await f.migration.start(MIGRATION_DEFAULT_MINUTES);
  await vi.waitFor(() => expect(f.llm.calls.length).toBe(1), { timeout: 20000 });
  f.migration.cancel(); expect(f.migration.state().status).toBe('idle');
  expect(f.dream.getStatus().pendingTasks).toEqual([]); expect(f.memory.readFile('state/STATE.md')).toBe('Legacy text.');
}, 25000);

it('reports a worker ending without a usable candidate and does not queue application', async () => {
  const f = managerFixture();
  await f.migration.start(MIGRATION_DEFAULT_MINUTES);
  await vi.waitFor(() => expect(f.migration.state().status).toBe('failed'), { timeout: 20000 });
  expect(f.dream.getStatus().pendingTasks).toEqual([]); expect(f.memory.readFile('state/STATE.md')).toBe('Legacy text.');
}, 25000);


it('streams real child requests while withholding candidate acceptance until the final response completes', async () => {
  const dir = root(), memory = new GitWorkspaceMemory({ memoryDir: join(dir, 'memory') }), cfg = composeDefaults();
  const sources = { 'state/STATE.md': 'Omit processing metadata.', 'CONSTITUTION.md': 'Keep meaning.' };
  for (const [path, text] of Object.entries(sources)) memory.writeFileAtomic(path, text);
  cfg.appraisal!.provider = 'laya';
  const appraiser = new Appraiser(cfg.appraisal!, { loadLaya: async () => ({ systemOne: async () => ({ answers: { rule0: { choice: 'allow' } } }), close: async () => {} }) });
  stops.push(() => appraiser.dispose());
  const script = [
    { name: 'migration_draft', args: document }, { name: 'migration_check', args: {} },
    { text: checkedSources(sources, ['style']) },
    { name: 'migration_review', args: { session: 'main', tool: 'chat_send', args: { text: 'Hello.' }, expected: 'allow', evidence: 'No processing metadata.' } },
    { name: 'migration_finish', args: { reason: 'ready', explanation: 'Sources preserved and replayed.' } },
  ];
  let requests = 0, held = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    if (!request.stream) { res.writeHead(400); res.end('{"error":{"message":"Streaming is required by this fixture."}}'); return; }
    const number = ++requests, item = script[number - 1];
    if (!item) { res.writeHead(400); res.end('{}'); return; }
    const output = 'name' in item ? [{ type: 'function_call', id: `fc_${number}`, call_id: `call_${number}`, name: item.name, arguments: JSON.stringify(item.args), status: 'completed' }]
      : [{ type: 'message', id: `msg_${number}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: item.text, annotations: [] }] }];
    const response = { id: `response_${number}`, object: 'response', status: 'completed', model: 'fixture', output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let sequence = 0;
    const event = (value: object) => res.write('data: ' + JSON.stringify({ ...value, sequence_number: sequence++ }) + '\n\n');
    event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    event({ type: 'response.output_item.added', output_index: 0, item: { ...output[0], status: 'in_progress' } });
    event({ type: 'response.output_item.done', output_index: 0, item: output[0] });
    if (number === script.length) { held = true; await gate; }
    event({ type: 'response.completed', response }); res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  stops.push(async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local fixture port');
  const llm = new ResponsesProvider({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture', log });
  const api = makeFakeHarnessApi(), dream = new Dream({ cfg, core: api, memoryDir: memory.memoryDir, dreamTools: () => [], toolUsageText: () => '', log, onEmergence() {} });
  const runtime = { ...services().core, llm, activeSpec: () => input().spec } as unknown as Core;
  const migration = new StateMigration({ memory, runtime: () => runtime, api: () => api, dream: () => dream, enabled: () => true, appraiser,
    appraisalConfig: () => cfg.appraisal!, tools: () => input().tools, readChars: () => 100, contextTokens: () => 100000 });
  stops.push(() => migration.stop());
  await migration.start(MIGRATION_MIN_MINUTES);
  await vi.waitFor(() => expect(held || migration.state().status === 'failed').toBe(true), { timeout: 10000 });
  expect(migration.state().status).toBe('running'); expect(held).toBe(true); expect(dream.getStatus().pendingTasks).toEqual([]);
  release();
  await vi.waitFor(() => expect(migration.state().status).toBe('waiting'), { timeout: 10000 });
  expect(requests).toBe(script.length); expect(memory.readFile('state/STATE.md')).toBe(sources['state/STATE.md']);
  expect(dream.getStatus().pendingTasks).toHaveLength(1);
}, 25000);
