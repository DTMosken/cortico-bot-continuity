import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { message, functionCall, functionResult } from 'cortico/protocol/open-responses/context.ts';
import type { ToolDef } from 'cortico/core/types.ts';
import { Core } from 'cortico/core/core.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { makeFakeHarnessApi, makeFakeIO, FakeLLM, toolReply } from '../../Cortico/tests/core/helpers.ts';
import { composeDefaults } from '../index.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { Appraiser } from '../persona/appraisal.ts';
import { parseState, renderState, type StateConstraint } from '../persona/state-document.ts';
import { StateReview, recentReviewEvidence } from '../persona/state-review.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { workspaceTools } from '../base/persona/workspaceTools.ts';
import { saveBlobTool } from '../base/persona/blobs.ts';

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const rule: StateConstraint = { id: 'metadata', scope: { sessions: ['main', 'dream'], tags: ['write' as const, 'speak' as const, 'act' as const] }, instruction: 'Omit processing metadata.', exceptions: 'Keep deadlines.' };
const receipt = (result: string | { text: string }) => typeof result === 'string' ? result : result.text;
const staged = (text: string): string => text.match(/暂存 ID：([0-9a-f-]+)/u)![1];

it('keeps recent completed eligible tool receipts within the evidence budget and marks omissions', () => {
  const snapshot = [message('system', 'Private prefix must not be copied.'),
    ...Array.from({ length: 5 }, (_, count) => [functionCall(String(count), 'lookup', JSON.stringify({ count })), functionResult(String(count), `Observed ${count}.`)]).flat(),
    functionCall('speak', 'send_message', '{}'), functionResult('speak', 'Unrelated speech receipt.'),
    functionCall('staged', 'lookup', '{}'), functionResult('staged', '[state review staged] Not executed.'),
    functionCall('unfinished', 'lookup', '{}')];
  const expected = [1, 2, 3, 4].map(count => ({ tool: 'lookup', args: { count }, result: `Observed ${count}.` }));
  const budget = expected.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
  expect(recentReviewEvidence(snapshot, new Set(['lookup']), budget)).toEqual([{ omittedEarlierToolReceipts: 1 }, ...expected]);
  expect(recentReviewEvidence([], new Set(['lookup']))).toEqual([]);
});

function fixture(options: { legacy?: boolean; enabled?: boolean; root?: string; virtual?: string; blobDir?: string; dialogue?: unknown[] } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'state-review-')); if (!options.root) roots.push(root);
  const memory = new GitWorkspaceMemory({ memoryDir: join(root, 'memory'), blobsDir: options.blobDir }); memory.ensureDirs(['state', 'note']);
  const statePath = join(memory.memoryDir, 'state/STATE.md');
  if (!existsSync(statePath)) writeFileSync(statePath, options.legacy ? 'Keep useful dates.' : renderState({ text: 'Current concern.', constraints: [rule] }));
  const cfg = composeDefaults(); cfg.appraisal!.provider = 'laya'; cfg.cognition!.stateReview = { enabled: options.enabled !== false };
  let choice = 'remind', failed = false; const requests: Array<Record<string, any>> = []; const injected: string[] = [];
  const appraiser = new Appraiser(cfg.appraisal!, { loadLaya: async () => ({
    systemOne: async (state, questions) => {
      requests.push(JSON.parse(String(state))); if (failed) throw new Error('service error with secret');
      return { answers: Object.fromEntries(Object.keys(questions as object).map(key => [key, { choice }])) };
    }, close: async () => {},
  }) }); closers.push(() => appraiser.dispose());
  const review = new StateReview({ memory, appraiser, enabled: () => !!cfg.cognition!.stateReview!.enabled,
    core: () => makeFakeHarnessApi({ injectInternal: text => { injected.push(text); } }),
    speechContext: () => ({ scene: 'scene', recentDialogue: options.dialogue ?? [{ text: 'Keep useful dates.' }] }), readOverride: () => options.virtual ?? null, dataDir: join(root, 'data') });
  const tools = (role = 'dream', extra: ToolDef[] = []) => review.wrap([
    ...workspaceTools({ memory, writeGuard: (_, path, role) => path === 'CORE.md' || path === 'state/STATE.md' && role === 'main' ? 'read-only' : null,
      readOverride: () => options.virtual ?? null, prefixResidentFiles: () => [] }), review.updateTool(), review.resolveTool(),
    { name: 'end_turn', description: 'End turn.', tags: ['flow'], endsTurn: true, parameters: {}, handler: async () => '[ended]' }, ...extra,
  ], role);
  const call = async (name: string, args: Record<string, unknown>, role = 'dream', extra: ToolDef[] = []) => receipt(await tools(role, extra).find(tool => tool.name === name)!.handler(args, { role, log: nullLogger() }));
  return { root, memory, statePath, cfg, review, tools, call, requests, injected,
    choice: (next: string) => { choice = next; }, currentChoice: () => choice, fail: (next: boolean) => { failed = next; }, isFailed: () => failed };
}

it('provides main tool evidence through remote privacy and drops evidence removed from the snapshot', async () => {
  const f = fixture(); const requests: any[] = [];
  const cfg = { ...f.cfg.appraisal!, provider: 'jev' as const, jev: { ...f.cfg.appraisal!.jev, source: 'custom' as const, endpoint: 'https://decision.test', allowRemoteText: true } };
  const appraiser = new Appraiser(cfg, { getEnv: () => 'scripted-key', requestJev: async request => {
    requests.push(JSON.parse(request.state.message));
    return { answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { choice: 'allow' }])) };
  } }); closers.push(() => appraiser.dispose());
  let snapshot = [functionCall('read', 'lookup', JSON.stringify({ userId: '123456789012' })), functionResult('read', '123456789012 reported 12 items.')];
  const core = makeFakeHarnessApi({ toolsTagged: tag => new Set(tag === 'flow' ? ['state_review_resolve'] : tag === 'read' ? ['lookup'] : tag === 'write' ? ['write_file'] : []) });
  core.sessionInfo = id => ({ id, running: 0, snapshot, estTokens: 0, hardTokens: 1000 });
  const review = new StateReview({ memory: f.memory, appraiser, core: () => core, enabled: () => true, readOverride: () => null, speechContext: () => ({ recentDialogue: [] }) });
  const tool = review.wrap(workspaceTools({ memory: f.memory, writeGuard: () => null, readOverride: () => null, prefixResidentFiles: () => [] }), 'main').find(tool => tool.name === 'write_file')!;
  await tool.handler({ path: 'note/evidence.md', content: 'Observed 12 items.' }, { role: 'main', log: nullLogger() });
  expect(f.memory.readFile('note/evidence.md')).toBe('Observed 12 items.');
  expect(requests[0].history[0]).toMatchObject({ tool: 'lookup', args: { userId: expect.stringContaining('[identity') } });
  expect(requests[0].history[0].result).toContain(requests[0].history[0].args.userId);
  expect(JSON.stringify(requests)).not.toMatch(/123456789012|scripted-key/u);
  snapshot = [];
  await tool.handler({ path: 'note/evidence.md', content: 'Updated.' }, { role: 'main', log: nullLogger() });
  expect(requests[1].history).toEqual([]);
});

it('stages before writes, permits reads, blocks later side effects and consumes a proceed only once', async () => {
  const f = fixture();
  const reminder = await f.call('write_file', { path: 'note/a.md', content: 'first' });
  const id = staged(reminder);
  expect(reminder).toContain('尚未执行。通过 state_review_resolve 取消或填写理由后坚持执行。修改时先取消，再用原工具提交新参数。');
  expect(reminder).not.toMatch(/不评分|任意非空|not evaluated/u);
  expect(f.memory.exists('note/a.md')).toBe(false);
  expect(await f.call('write_file', { path: 'note/later.md', content: 'later' })).toContain('preceding action');
  expect(await f.call('read_file', { path: 'state/STATE.md' })).toBe(f.memory.readFile('state/STATE.md'));
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: ' ' })).toContain('nonempty');
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('[written]');
  expect(f.memory.readFile('note/a.md')).toBe('first'); expect(f.memory.exists('note/later.md')).toBe(false);
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('expired');
  f.choice('allow'); await f.call('write_file', { path: 'note/later.md', content: 'resubmitted' });
  expect(f.memory.readFile('note/later.md')).toBe('resubmitted'); expect(f.requests).toHaveLength(2);
});

it.each(['remind', 'insufficient'])('explains a staged action in natural language with its %s verdict and rule', async choice => {
  const f = fixture(); f.choice(choice);
  const text = await f.call('write_file', { path: 'note/a.md', content: 'Processing timestamp.' });
  expect(text).toContain('STATE 行动审核未通过，write_file 尚未执行');
  expect(text).toContain(choice === 'remind' ? 'metadata（疑似冲突）' : 'metadata（信息不足）');
  expect(text).toContain(rule.instruction); expect(text).toContain(rule.exceptions);
  expect(text).toMatch(/暂存 ID：[0-9a-f-]+/u);
  expect(text).not.toContain('{"id"');
  expect(text).toContain('针对上述约束说明理由');
  expect(f.memory.exists('note/a.md')).toBe(false);
});

it('tracks the full STATE read internally and rejects stale implicit updates without adding receipt text', async () => {
  const f = fixture({ enabled: false });
  const args = { text: 'New concern.', constraints: [] };
  expect(await f.call('update_state', args)).toContain('Read STATE');
  const original = f.memory.readFile('state/STATE.md');
  expect(await f.call('read_file', { path: 'state/STATE.md' })).toBe(original);
  f.memory.writeFileAtomic('state/STATE.md', 'Changed outside.');
  expect(await f.call('update_state', args)).toContain('STATE changed');
  expect(f.memory.readFile('state/STATE.md')).toBe('Changed outside.');
  await f.call('read_file', { path: 'state/STATE.md' });
  expect(await f.call('update_state', args)).toContain('[written]');
  expect(parseState(f.memory.readFile('state/STATE.md')).text).toContain(args.text);
  f.review.end('dream');
  expect(await f.call('update_state', args)).toContain('Read STATE');
});

it('does not use a partial STATE read or another session read to authorize an implicit update', async () => {
  const f = fixture({ enabled: false });
  const args = { text: 'New concern.', constraints: [] };
  await f.call('read_file', { path: 'state/STATE.md', limit: 1 });
  expect(await f.call('update_state', args)).toContain('Read STATE');
  await f.call('read_file', { path: 'state/STATE.md' }, 'main');
  expect(await f.call('update_state', args)).toContain('Read STATE');
  expect(await f.call('update_state', { ...args, expectedRevision: f.review.documents.read().revision })).toContain('[written]');
});

it('cancel permits a revised action and end_turn clears pending actions', async () => {
  const f = fixture(); let id = staged(await f.call('write_file', { path: 'note/a.md', content: 'old' }));
  expect(await f.call('state_review_resolve', { id, decision: 'cancel' })).toContain('Nothing executed');
  id = staged(await f.call('write_file', { path: 'note/a.md', content: 'new' }));
  await f.call('end_turn', {});
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('expired');
  expect(f.memory.exists('note/a.md')).toBe(false); expect(f.requests).toHaveLength(2);
});

it('rejects stale file and STATE versions, isolates role IDs and clears the pause on invalidation', async () => {
  const f = fixture(); let id = staged(await f.call('write_file', { path: 'note/a.md', content: 'old' }));
  expect(await f.call('state_review_resolve', { id, decision: 'cancel' }, 'main')).toContain('expired');
  f.memory.writeFileAtomic('note/a.md', 'outside');
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('changed');
  id = staged(await f.call('append_file', { path: 'note/a.md', content: 'old' }));
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: 'New', constraints: [] }));
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('changed');
  expect(await f.call('append_file', { path: 'note/a.md', content: 'new' })).toContain('[appended]');
});

it('does not review disabled, unmatched or ordinary read calls and reads changed constraints on the next action', async () => {
  const f = fixture({ enabled: false });
  await f.call('write_file', { path: 'note/a.md', content: 'a' });
  f.cfg.cognition!.stateReview!.enabled = true; f.review.end('dream');
  await f.call('read_file', { path: 'note/a.md' });
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: 'x', constraints: [{ ...rule, scope: { sessions: ['main'], tags: ['write'] } }] }));
  await f.call('append_file', { path: 'note/a.md', content: 'b' }); expect(f.requests).toHaveLength(0);
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: 'x', constraints: [rule] }));
  expect(await f.call('append_file', { path: 'note/a.md', content: 'c' })).toContain('staged');
});

it('keeps successful calls unbarriered and reviews the previous actual write before the next action', async () => {
  const f = fixture(); f.choice('allow');
  expect(f.tools().find(tool => tool.name === 'write_file')!.barrierAfter).toBeFalsy();
  await f.call('write_file', { path: 'note/a.md', content: 'first' });
  await f.call('edit_file', { path: 'note/a.md', old_string: 'first', new_string: 'second' });
  expect(f.requests[1].action.change.context).toBe('first'); expect(f.memory.readFile('note/a.md')).toBe('second');
});

it('includes actual read ranges and lengths without sending the file body', async () => {
  const f = fixture(); f.choice('allow');
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: '', constraints: [{ ...rule, scope: { sessions: ['main', 'dream'], tools: ['read_file'] } }] }));
  f.memory.writeFileAtomic('note/a.md', 'abc\ndef\nghi\n');
  await f.call('read_file', { path: 'note/a.md', offset: 2, limit: 100 });
  expect(f.requests.at(-1)!.action.read).toMatchObject({ lines: 2, chars: 7, full: false, limit: 100 });
  expect(JSON.stringify(f.requests.at(-1))).not.toContain('abc');
  await f.call('read_file', { path: 'note/a.md' });
  expect(f.requests.at(-1)!.action.read).toMatchObject({ lines: 3, chars: 12, full: true, limit: null });
  await f.call('read_file', { path: 'note/a.md', offset: -1, limit: 1 });
  expect(f.requests.at(-1)!.action.read).toMatchObject({ lines: 1, chars: 3 });
  await f.call('read_file', { path: 'note/a.md', offset: 99 });
  expect(f.requests.at(-1)!.action.read).toMatchObject({ lines: 0, chars: 0 });
});

it('reports the full virtual read even when offset and limit were requested', async () => {
  const f = fixture({ virtual: 'one\ntwo\nthree' }); f.choice('allow');
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: '', constraints: [{ ...rule, scope: { sessions: ['main', 'dream'], tools: ['read_file'] } }] }));
  expect(await f.call('read_file', { path: 'CORE.md', offset: 1, limit: 1 })).toBe('one\ntwo\nthree');
  expect(f.requests.at(-1)!.action.read).toMatchObject({ lines: 3, chars: 13, full: true, limit: 1 });
});

it('falls back for the turn, retries only real next-turn work and notifies once per outage', async () => {
  const f = fixture(); f.fail(true);
  const first = await f.call('write_file', { path: 'note/a.md', content: 'a' });
  expect(first).toContain('可以通知维护者');
  expect(first).not.toContain('[system/continuity-state]');
  await f.call('append_file', { path: 'note/a.md', content: 'b' }); expect(f.requests).toHaveLength(1);
  f.review.end('dream'); f.review.begin('dream'); expect(f.requests).toHaveLength(1);
  const retry = await f.call('append_file', { path: 'note/a.md', content: 'c' });
  expect(retry).not.toContain('可以通知维护者'); expect(retry).not.toContain('[system/continuity-state]');
  f.review.end('dream'); f.fail(false); f.choice('allow'); await f.call('append_file', { path: 'note/a.md', content: 'd' });
  f.review.end('dream'); f.fail(true);
  expect(await f.call('append_file', { path: 'note/a.md', content: 'e' })).toContain('可以通知维护者');
});

it('persists one legacy migration task and accepts an empty constraint result with concise receipts', async () => {
  const f = fixture({ legacy: true }); f.review.begin('main');
  expect(f.injected.join('\n')).toContain('下一次正常 Dream');
  const g = fixture({ root: f.root }); g.review.begin('dream');
  expect(g.injected).toEqual([]); expect(g.review.migrationTask()).toContain('Use update_state');
  const args = { text: 'Keep useful dates.', constraints: [], expectedRevision: g.review.documents.read().revision };
  expect(await g.call('update_state', args, 'main')).toContain('Dream only');
  expect(await g.call('update_state', { ...args, expectedRevision: 'old' })).toContain('STATE changed');
  const updated = await g.call('update_state', args); expect(updated).toContain('STATE revision'); expect(updated).not.toContain(args.text);
  expect(g.review.migrationTask()).toBe(''); expect(g.review.status().migrationPending).toBe(false);
  expect(parseState(g.memory.readFile('state/STATE.md')).constraints).toEqual([]);
  expect(await g.call('write_file', { path: 'state/STATE.md', content: 'Legacy again.' })).toBe('[written] state/STATE.md');
  expect(await g.call('read_file', { path: 'state/STATE.md' })).toContain('Legacy again.');
});

it('keeps malformed STATE visible, stages oversized input and preserves original write guards on proceed', async () => {
  const f = fixture(); const id = staged(await f.call('write_file', { path: 'CORE.md', content: 'x'.repeat(10000) }));
  expect(f.requests).toHaveLength(0);
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('read-only');
  const raw = 'Keep\n## Action constraints\nbroken'; f.memory.writeFileAtomic('state/STATE.md', raw);
  expect(f.review.text('dream')).toBe(raw);
  expect(await f.call('write_file', { path: 'note/a.md', content: 'a' })).toContain('[written]'); expect(f.requests).toHaveLength(0);
});

it('cancels pending work on disable while a turn keeps its original setting until it ends', async () => {
  const f = fixture(); const id = staged(await f.call('write_file', { path: 'note/a.md', content: 'a' }));
  f.cfg.cognition!.stateReview!.enabled = false; f.review.changed();
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('expired');
  f.review.end('dream'); await f.call('write_file', { path: 'note/a.md', content: 'new' });
  expect(f.memory.readFile('note/a.md')).toBe('new'); expect(f.requests).toHaveLength(1);
});

function personaFixture() {
  const f = fixture(); const appraiser = new Appraiser(f.cfg.appraisal!, { loadLaya: async () => ({
    systemOne: async (state, questions) => {
      f.requests.push(JSON.parse(String(state)));
      if (f.isFailed()) throw new Error('scripted service failure');
      return { answers: Object.fromEntries(Object.keys(questions as object).map(key => [key, { choice: f.currentChoice() }])) };
    }, close: async () => {},
  }) });
  f.cfg.cognition!.blacklist = [{ id: 'all', label: 'all', enabled: true, match: {} }];
  f.cfg.providers = { fixture: { kind: 'openai-responses-compat', baseUrl: 'https://model.test', spec: { model: 'test-model', thinking: false } } };
  f.cfg.activeProvider = 'fixture';
  const persona = new ContinuityPersona({ cfg: f.cfg, appraiser, memoryDir: f.memory.memoryDir, dataDir: join(f.root, 'data'), deploymentDir: f.root });
  closers.push(() => persona.dispose()); return { ...f, persona };
}

it('exposes the live STATE catalogue only in enabled Dream sessions with main and Dream capabilities', async () => {
  const f = personaFixture();
  const query = f.persona.declareSessions().find(session => session.id === 'dream')!.tools().find(tool => tool.name === 'state_review_tools')!;
  expect(f.persona.declareSessions().find(session => session.id === 'main')!.tools().some(tool => tool.name === query.name)).toBe(false);
  const catalogue = JSON.parse(receipt(await query.handler({}, { role: 'dream', log: nullLogger() })));
  expect(catalogue.tools.find((tool: any) => tool.name === 'update_state').sessions).toEqual(['dream']);
  expect(catalogue.tools.find((tool: any) => tool.name === 'subagent_spawn').sessions).toEqual(['main']);
  expect(catalogue.tools.find((tool: any) => tool.name === 'read_file').sessions).toEqual(['main', 'dream']);
  expect(catalogue.tools.find((tool: any) => tool.name === 'surface').sessions).toEqual(['dream']);
  f.cfg.cognition!.stateReview!.enabled = false;
  expect(f.persona.declareSessions().find(session => session.id === 'dream')!.tools().some(tool => tool.name === query.name)).toBe(false);
});

it('updates STATE tool contracts when a World is hidden, shown or removed without executing it', async () => {
  const f = fixture(); let executions = 0;
  const read: ToolDef = { name: 'archive_lookup', tags: ['read'], description: 'Read the archive.', parameters: { type: 'object' }, handler: async () => { executions++; return 'data'; } };
  const publish: ToolDef = { ...read, name: 'archive_publish', tags: ['act'], description: 'Publish to the archive.', parameters: { type: 'object', properties: { text: { type: 'string' } } } };
  const worlds = [makeFakeIO('archive', [read, publish])];
  const persona = new ContinuityPersona({ cfg: f.cfg, worlds, memoryDir: f.memory.memoryDir, dataDir: join(f.root, 'data') });
  const core = new Core({ config: f.cfg, rootDir: f.root, memoryDir: f.memory.memoryDir, dataDir: join(f.root, 'data'), secret: () => '' }, { persona, worlds, llm: new FakeLLM() });
  persona.setSubagentsRuntime(core); closers.push(async () => { await core.stop(); });
  const query = persona.declareSessions().find(session => session.id === 'dream')!.tools().find(tool => tool.name === 'state_review_tools')!;
  const contracts = async () => JSON.parse(receipt(await query.handler({ names: [read.name, publish.name] }, { role: 'dream', log: nullLogger() })));
  expect((await contracts()).tools).toEqual([
    { name: read.name, tags: read.tags, sessions: ['main', 'dream'], description: read.description, parameters: read.parameters },
    { name: publish.name, tags: publish.tags, sessions: ['main'], description: publish.description, parameters: publish.parameters },
  ]);
  core.setWorldVisible('archive', false); expect((await contracts()).tools).toEqual([]);
  core.setWorldVisible('archive', true); expect((await contracts()).tools).toHaveLength(2);
  worlds.splice(0); expect((await contracts()).unavailable).toEqual([read.name, publish.name]);
  expect(executions).toBe(0);
});

it.each([false, true])('executes multiple approved writes in one actual Core response (streaming=%s)', async streaming => {
  const f = personaFixture(); const llm = new FakeLLM(); let step = 0;
  f.choice('allow');
  const declarations = f.persona.declareSessions.bind(f.persona);
  f.persona.declareSessions = () => declarations().map(decl => decl.id === 'main' ? { ...decl, outputTap: streaming ? decl.outputTap : undefined } : decl);
  llm.fallback = () => ++step === 1 ? toolReply([
    { name: 'write_file', args: { path: 'note/first.md', content: 'first' } },
    { name: 'write_file', args: { path: 'note/second.md', content: 'second' } }, { name: 'end_turn' },
  ]) : toolReply([{ name: 'end_turn' }]);
  const core = new Core({ config: f.cfg, rootDir: f.root, memoryDir: f.memory.memoryDir, dataDir: join(f.root, 'data'), secret: () => '' }, { persona: f.persona, worlds: [], llm });
  try {
    await core.start(); const deadline = Date.now() + 5000;
    while (!step || core.loop.getStatus().phase.state !== 'idle') { if (Date.now() > deadline) throw new Error('Core did not finish'); await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(f.memory.readFile('note/first.md')).toBe('first'); expect(f.memory.readFile('note/second.md')).toBe('second'); expect(f.requests).toHaveLength(2);
  } finally { await core.stop(); }
});

it('migrates in a normal Dream through the unchanged Core fork and retains its per-run tools', async () => {
  const f = personaFixture(); f.memory.writeFileAtomic('state/STATE.md', 'Keep useful dates.');
  Object.assign(f.cfg.dream, { maxRounds: 10, softRounds: 8, maxBatches: 1, maxRetries: 0 });
  const llm = new FakeLLM(); let step = 0;
  llm.fallback = () => {
    step++;
    if (step === 1) return toolReply([{ name: 'read_file', args: { path: 'state/STATE.md' } }]);
    if (step === 2) return toolReply([{ name: 'update_state', args: { text: 'Keep useful dates.', constraints: [] } }]);
    return toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
  };
  const core = new Core({ config: f.cfg, rootDir: f.root, memoryDir: f.memory.memoryDir, dataDir: join(f.root, 'data'), secret: () => '' }, { persona: f.persona, worlds: [], llm });
  try {
    await f.persona.dream.schedule([message('system', 'prefix'), message('user', 'An old concern.')]);
    expect(f.persona.dream.getStatus().runs.at(-1)?.status).toBe('complete');
    expect(llm.calls[0].tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['dream_materials', 'dream_read_material', 'surface']));
    expect(JSON.stringify(llm.calls[0].messages)).toContain('Use update_state');
    expect(parseState(f.memory.readFile('state/STATE.md'))).toMatchObject({ structured: true, constraints: [] });
  } finally { await core.stop(); }
});

it.each([false, true])('stops later writes after staging and expires the ID at real Core end_turn (streaming=%s)', async streaming => {
  const f = personaFixture(); const llm = new FakeLLM(); let step = 0, id = '';
  const declarations = f.persona.declareSessions.bind(f.persona);
  f.persona.declareSessions = () => declarations().map(decl => decl.id === 'main' ? { ...decl, outputTap: streaming ? decl.outputTap : undefined } : decl);
  llm.fallback = () => {
    step++;
    if (step === 1) return toolReply([
      { name: 'write_file', args: { path: 'note/first.md', content: 'first' } },
      { name: 'write_file', args: { path: 'note/later.md', content: 'later' } },
      { name: 'read_file', args: { path: 'state/STATE.md' } },
    ]);
    if (step === 2) {
      const receipts = llm.calls.at(-1)!.messages.filter(record => record.role === 'tool').map(record => record.content ?? '');
      id = staged(receipts.find(text => text.startsWith('[state review staged]'))!);
      expect(receipts.some(text => text.includes('preceding action'))).toBe(true);
      expect(receipts).toContain(f.memory.readFile('state/STATE.md'));
      return toolReply([{ name: 'end_turn' }]);
    }
    if (step === 3) return toolReply([{ name: 'state_review_resolve', args: { id, decision: 'proceed', reason: 'x' } }]);
    return toolReply([{ name: 'end_turn' }]);
  };
  const core = new Core({ config: f.cfg, rootDir: f.root, memoryDir: f.memory.memoryDir, dataDir: join(f.root, 'data'), secret: () => '' }, { persona: f.persona, worlds: [], llm });
  const until = async (minimum: number) => {
    const deadline = Date.now() + 5000;
    while (step < minimum || core.loop.getStatus().phase.state !== 'idle') { if (Date.now() > deadline) throw new Error('Core did not finish'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    await core.start(); await until(2); expect(id).toBeTruthy();
    core.loop.injectInternal('Next batch.', 'test'); await until(4);
    expect(JSON.stringify(core.session.records)).toContain('Unknown or expired staged ID');
    expect(f.memory.exists('note/first.md')).toBe(false); expect(f.memory.exists('note/later.md')).toBe(false); expect(f.requests).toHaveLength(1);
  } finally { await core.stop(); }
});

it('keeps QQ draft barriers, reviews actual draft content and retains the original send guard', async () => {
  const f = fixture(); f.choice('allow'); let draft = '', permission = false; const sent: string[] = [];
  const extra: ToolDef[] = [
    { name: 'qq_draft', description: 'Stage draft.', tags: ['speak'], parameters: {}, barrierAfter: true,
      handler: async args => { draft = String(args.text); return '[draft staged]'; } },
    { name: 'qq_confirm', description: 'Send or cancel.', tags: ['speak'], parameters: {}, handler: async args => {
      if (args.decision === 'cancel') { draft = ''; return '[cancelled]'; }
      if (!permission || !draft) return '[send denied]'; sent.push(draft); return '[sent → scene]';
    } },
  ];
  expect(f.tools('dream', extra).find(tool => tool.name === 'qq_draft')!.barrierAfter).toBe(true);
  await f.call('qq_draft', { to: 'group:42', text: 'The actual message.' }, 'dream', extra);
  f.choice('remind'); let id = staged(await f.call('qq_confirm', { decision: 'send' }, 'dream', extra));
  expect(f.requests.at(-1)!.action.draft.text).toBe('The actual message.');
  expect(f.requests.at(-1)!.action.context.recentDialogue[0].text).toBe('Keep useful dates.');
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('send denied'); expect(sent).toEqual([]);
  permission = true; id = staged(await f.call('qq_confirm', { decision: 'send' }, 'dream', extra));
  await f.call('qq_confirm', { decision: 'cancel' }, 'dream', extra);
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('changed'); expect(sent).toEqual([]);
});

it('injects ordinary STATE on changes and full fallback once across consecutive failed review turns', async () => {
  const f = personaFixture(); const injected: string[] = [];
  f.persona.attach(makeFakeHarnessApi({ injectInternal: text => { injected.push(text); },
    toolsTagged: () => new Set(f.persona.declareSessions().flatMap(decl => decl.tools().map(tool => tool.name))) }));
  f.persona.onOpening({ reason: 'new' });
  const states = () => injected.filter(text => text.startsWith('[system/continuity-state]'));
  expect(states()).toHaveLength(1); expect(states()[0]).toContain('Current concern.'); expect(states()[0]).not.toContain('Action constraints');
  const deliver = async () => f.persona.onDelivery({ events: [{ origin: 'external', cursor: injected.length, ts: new Date().toISOString(), source: 'chat', type: 'chat.message', text: 'hi' }] });
  for (let i = 0; i < 12; i++) await deliver(); expect(states()).toHaveLength(1);
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: 'Changed outside.', constraints: [rule] }));
  f.persona.onTurnEnded(); await deliver(); expect(states()).toHaveLength(2); expect(states()[1]).toContain('Changed outside.');
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: 'Changed outside.', constraints: [{ ...rule, instruction: 'Omit redundant processing metadata.' }] }));
  f.persona.onTurnEnded(); await deliver(); expect(states()).toHaveLength(2);
  const raw = f.memory.readFile('state/STATE.md');
  f.fail(true);
  const tool = f.persona.declareSessions().find(decl => decl.id === 'main')!.tools().find(tool => tool.name === 'write_file')!;
  expect(receipt(await tool.handler({ path: 'note/failure.md', content: 'a' }, { role: 'main', log: nullLogger() }))).not.toContain('[system/continuity-state]');
  expect(states()).toHaveLength(3); expect(states()[2]).toContain('Action constraints');
  for (let i = 0; i < 12; i++) {
    f.persona.onTurnEnded(); await deliver();
    await tool.handler({ path: 'note/failure.md', content: String(i) }, { role: 'main', log: nullLogger() });
  }
  expect(states()).toHaveLength(3);
  f.fail(false); f.choice('allow'); f.persona.onTurnEnded(); await deliver();
  await tool.handler({ path: 'note/recovered.md', content: 'recovered' }, { role: 'main', log: nullLogger() });
  expect(states()).toHaveLength(4); expect(states()[3]).not.toContain('Action constraints');
  f.persona.onTurnEnded(); await deliver(); expect(states()).toHaveLength(4);
  f.cfg.cognition!.stateReview!.enabled = false;
  f.persona.onTurnEnded(); await deliver(); expect(states()).toHaveLength(5); expect(states().at(-1)).toContain('Action constraints');
  for (let i = 0; i < 9; i++) await deliver(); expect(states()).toHaveLength(5);
  await deliver(); expect(states()).toHaveLength(6); expect(f.memory.readFile('state/STATE.md')).toBe(raw);
});

it.each(['legacy', 'scope', 'malformed', 'unavailable', 'resolver'])('keeps full main STATE when review cannot apply: %s', mode => {
  const f = personaFixture(); const injected: string[] = [];
  if (mode === 'legacy') f.memory.writeFileAtomic('state/STATE.md', 'Keep the original requirements.');
  if (mode === 'scope') f.memory.writeFileAtomic('state/STATE.md', f.memory.readFile('state/STATE.md').replace(/^- sessions: .*\n/m, ''));
  if (mode === 'malformed') f.memory.writeFileAtomic('state/STATE.md', 'Keep\n## Action constraints\nbroken');
  if (mode === 'unavailable') f.cfg.appraisal!.provider = 'random';
  f.persona.attach(makeFakeHarnessApi({ injectInternal: text => { injected.push(text); },
    toolsTagged: () => new Set(mode === 'resolver' ? [] : f.persona.declareSessions().flatMap(decl => decl.tools().map(tool => tool.name))) }));
  f.persona.onOpening({ reason: 'new' });
  const states = injected.filter(text => text.startsWith('[system/continuity-state]'));
  expect(states).toHaveLength(1); expect(states[0]).toContain(f.memory.readFile('state/STATE.md').trim());
});

it('keeps full STATE for Dream maintenance and explicit reads', async () => {
  const f = fixture(); f.review.begin('dream');
  expect(f.review.text('dream')).toBe(f.memory.readFile('state/STATE.md'));
  expect(await f.call('read_file', { path: 'state/STATE.md' }, 'main')).toBe(f.memory.readFile('state/STATE.md'));
});

it.each([false, true])('delivers fallback STATE once before the next Core request without copying it into receipts (streaming=%s)', async streaming => {
  const f = personaFixture(); f.fail(true); const llm = new FakeLLM(); let step = 0;
  const declarations = f.persona.declareSessions.bind(f.persona);
  f.persona.declareSessions = () => declarations().map(decl => decl.id === 'main' ? { ...decl, outputTap: streaming ? decl.outputTap : undefined } : decl);
  llm.fallback = () => ++step <= 2 ? toolReply([{ name: 'write_file', args: { path: 'note/work.md', content: String(step) } }]) : toolReply([{ name: 'end_turn' }]);
  const core = new Core({ config: f.cfg, rootDir: f.root, memoryDir: f.memory.memoryDir, dataDir: join(f.root, 'data'), secret: () => '' }, { persona: f.persona, worlds: [], llm });
  try {
    await core.start(); const deadline = Date.now() + 5000;
    while (step < 3 || core.loop.getStatus().phase.state !== 'idle') { if (Date.now() > deadline) throw new Error('Core did not finish'); await new Promise(resolve => setTimeout(resolve, 10)); }
    const states = (index: number) => llm.calls[index].messages.filter(msg => msg.content?.startsWith('[system/continuity-state]'));
    expect(states(0)).toHaveLength(1); expect(states(0)[0].content).not.toContain('Action constraints');
    expect(states(1)).toHaveLength(2); expect(states(1)[1].content).toContain('Action constraints'); expect(states(2)).toHaveLength(2);
    expect(llm.calls[2].messages.filter(msg => msg.role === 'tool').every(msg => !msg.content?.includes('[system/continuity-state]'))).toBe(true);
    expect(f.requests).toHaveLength(1); expect(f.memory.readFile('note/work.md')).toBe('2');
  } finally { await core.stop(); }
});

it('budgets older speech history separately while retaining the latest relevant dialogue', async () => {
  const f = fixture({ dialogue: [{ ts: '2026-10-20T00:00:00Z', text: 'old '.repeat(3000) }, { ts: '2026-10-24T00:00:00Z', text: 'Latest relevant request.' }] }); f.choice('allow');
  const speak: ToolDef = { name: 'chat_send', description: 'Send.', tags: ['speak'], parameters: {}, handler: async () => '[sent]' };
  expect(await f.call('chat_send', { text: 'Reply.' }, 'dream', [speak])).toBe('[sent]');
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].action.context.recentDialogue).toEqual([{ ts: '2026-10-24T00:00:00Z', text: 'Latest relevant request.' }]);
  expect(f.requests[0].history).toEqual([]);
});

it('does not discard a referenced earlier message just to fit the speech review budget', async () => {
  const f = fixture({ dialogue: [{ messageId: '987', text: 'Quoted '.repeat(3000) }, { text: 'Latest request.' }] }); f.choice('allow');
  const speak: ToolDef = { name: 'qq_draft', description: 'Draft.', tags: ['speak'], parameters: {}, handler: async () => '[draft staged]' };
  expect(await f.call('qq_draft', { reply_to: '#987', text: 'Reply.' }, 'dream', [speak])).toContain('[state review staged]');
  expect(f.requests).toHaveLength(0);
});

it.each([undefined, 'external/images/'])('rejects stale save_blob destinations using the real blob store (%s)', async blobDir => {
  const f = fixture({ blobDir });
  const tool = saveBlobTool({ blobs: f.memory.blobs, core: () => makeFakeHarnessApi({ blob: () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'application/octet-stream' }) }) });
  const original = new Uint8Array([4, 5, 6]);
  const stored = f.memory.blobs.put('image.bin', original, 'application/octet-stream');
  const id = staged(await f.call('save_blob', { handle: 'log:0123456789', path: 'image.bin' }, 'dream', [tool]));
  const changed = new Uint8Array([9, 8, 7]); f.memory.blobs.put('image.bin', changed, 'application/octet-stream');
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('changed');
  expect(Array.from(f.memory.blobs.get(stored)!.bytes)).toEqual(Array.from(changed));
});

it('reports a binary attachment read as binary metadata and preserves directory read failures', async () => {
  const f = fixture(); f.choice('allow');
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: '', constraints: [{ ...rule, scope: { sessions: ['main', 'dream'], tools: ['read_file'] } }] }));
  f.memory.blobs.put('sample.bin', new Uint8Array([255, 0, 254, 10]), 'application/octet-stream');
  const result = await f.tools().find(tool => tool.name === 'read_file')!.handler({ path: 'blobs/sample.bin' }, { role: 'dream', log: nullLogger() });
  expect(result).toMatchObject({ text: '', blobs: [{ handle: 'mem:blobs/sample.bin' }] });
  expect(f.requests.at(-1)!.action.read).toMatchObject({ binary: true, chars: 0, lines: 0, bytes: 4 });
  expect(await f.call('read_file', { path: 'note' })).toBe('[not found] note');
});

it('registers legacy migration when enabled in WebUI even if the current turn began disabled', async () => {
  const f = personaFixture(); f.cfg.cognition!.stateReview!.enabled = false;
  f.memory.writeFileAtomic('state/STATE.md', 'Keep useful dates.');
  writeFileSync(join(f.root, 'config.json'), '{}'); const injected: string[] = [];
  f.persona.attach(makeFakeHarnessApi({ injectInternal: text => { injected.push(text); } }));
  f.persona.onOpening({ reason: 'new' });
  const state = f.persona.configState('cognition');
  const next = await f.persona.configInvoke('cognition', 'saveDraft', [{ ...(state.values as Record<string, unknown>), 'cognition.stateReview.enabled': true }, state.revision]);
  expect(next).toMatchObject({ stateReview: { status: '待整理约束', migrationPending: true } });
  expect(JSON.parse(readFileSync(join(f.root, 'data/continuity/state-review.json'), 'utf8'))).toMatchObject({ migrationPending: true, migrationNotified: true });
  expect(injected.filter(text => text.includes('下一次正常 Dream'))).toHaveLength(1);
  expect(f.persona.dream.getStatus().runs).toHaveLength(0);
  const restarted = fixture({ root: f.root }); expect(restarted.review.migrationTask()).toContain('Use update_state');
  restarted.review.changed(); expect(restarted.injected.filter(text => text.includes('下一次正常 Dream'))).toHaveLength(0);
});

it('migrates previously structured scopes after restart and preserves full STATE until completion', async () => {
  const f = fixture();
  const raw = 'Keep.\n## Action constraints\n### old\n- instruction: "Keep useful facts."\n- exceptions: ""\n';
  f.memory.writeFileAtomic('state/STATE.md', raw);
  const metadata = join(f.root, 'data/continuity/state-review.json');
  mkdirSync(join(f.root, 'data/continuity'), { recursive: true });
  writeFileSync(metadata, JSON.stringify({ migrationNotified: true, migrationPending: false, outageNotified: false }));
  const restarted = fixture({ root: f.root });
  restarted.review.begin('dream');
  expect(restarted.review.status()).toMatchObject({ status: '待整理约束', migrationPending: true });
  expect(restarted.review.text('dream')).toBe(raw);
  expect(restarted.review.migrationTask()).toContain('CONSTITUTION.md');
  expect(restarted.review.migrationTask()).toContain('scope.sessions');
  expect(restarted.review.migrationTask()).toContain('other existing documents');
  expect(restarted.memory.readFile('state/STATE.md')).toBe(raw);
  await restarted.call('write_file', { path: 'note/before.md', content: 'before' });
  expect(restarted.requests).toHaveLength(0);
  const again = fixture({ root: f.root }); again.review.begin('dream');
  expect(again.injected.filter(text => text.includes('补齐 scope'))).toHaveLength(0);
  expect(again.review.migrationTask()).toBeTruthy();
  await restarted.call('read_file', { path: 'state/STATE.md' });
  expect(await restarted.call('update_state', { text: 'Keep.', constraints: [rule] })).toContain('[written]');
  expect(restarted.review.status().migrationPending).toBe(false);
  expect(restarted.review.documents.read().needsScopeMigration).toBeUndefined();
  restarted.choice('allow');
  expect(await restarted.call('write_file', { path: 'note/after.md', content: 'after' })).toContain('[written]');
  expect(restarted.requests).toHaveLength(1);
});

it('reviews per-run Dream material tools when a read scope explicitly includes them', async () => {
  const f = personaFixture();
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: '', constraints: [{ ...rule, scope: { sessions: ['dream'], tags: ['read'] } }] }));
  Object.assign(f.cfg.dream, { maxRounds: 12, softRounds: 10, maxBatches: 1, maxRetries: 0 });
  const llm = new FakeLLM(); let step = 0, materialId = '';
  llm.fallback = () => {
    step++;
    const last = llm.calls.at(-1)!.messages.at(-1)!.content ?? '';
    if (step === 1) return toolReply([{ name: 'dream_materials' }]);
    if (step === 2 || step === 4) return toolReply([{ name: 'state_review_resolve', args: { id: staged(last), decision: 'proceed', reason: 'x' } }]);
    if (step === 3) {
      materialId = JSON.parse(last.split('\n')[0]).items[0].id;
      return toolReply([{ name: 'dream_read_material', args: { id: materialId, maxChars: 12 } }]);
    }
    expect(JSON.parse(last.split('\n')[0]).text).toHaveLength(12);
    return toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
  };
  const core = new Core({ config: f.cfg, rootDir: f.root, memoryDir: f.memory.memoryDir, dataDir: join(f.root, 'data'), secret: () => '' }, { persona: f.persona, worlds: [], llm });
  try {
    await f.persona.dream.schedule([message('system', 'prefix'), message('user', 'A material long enough to read in parts.')]);
    expect(f.persona.dream.getStatus().runs.at(-1)?.status).toBe('complete');
    expect(f.requests.map(request => request.action.tool)).toEqual(['dream_materials', 'dream_read_material']);
    expect(f.requests[1].action.read.chars).toBe(12);
  } finally { await core.stop(); }
});
