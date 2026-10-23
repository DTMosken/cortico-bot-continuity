import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { message } from 'cortico/protocol/open-responses/context.ts';
import type { ToolDef } from 'cortico/core/types.ts';
import { Core } from 'cortico/core/core.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { makeFakeHarnessApi, makeFakeIO, FakeLLM, toolReply } from '../../Cortico/tests/core/helpers.ts';
import { composeDefaults } from '../index.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { Appraiser } from '../persona/appraisal.ts';
import { parseState, renderState, type StateConstraint } from '../persona/state-document.ts';
import { StateReview } from '../persona/state-review.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { workspaceTools } from '../base/persona/workspaceTools.ts';

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const rule: StateConstraint = { id: 'metadata', scope: {}, instruction: 'Omit processing metadata.', exceptions: 'Keep deadlines.' };
const receipt = (result: string | { text: string }) => typeof result === 'string' ? result : result.text;
const staged = (text: string): string => JSON.parse(text.split('\n')[0].slice('[state review staged] '.length)).id;

function fixture(options: { legacy?: boolean; enabled?: boolean; root?: string; virtual?: string } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'state-review-')); if (!options.root) roots.push(root);
  const memory = new GitWorkspaceMemory({ memoryDir: join(root, 'memory') }); memory.ensureDirs(['state', 'note']);
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
    speechContext: () => ({ scene: 'scene', recentDialogue: [{ text: 'Keep useful dates.' }] }), readOverride: () => options.virtual ?? null, dataDir: join(root, 'data') });
  const tools = (role = 'dream', extra: ToolDef[] = []) => review.wrap([
    ...workspaceTools({ memory, writeGuard: (_, path, role) => path === 'CORE.md' || path === 'state/STATE.md' && role === 'main' ? 'read-only' : null,
      readOverride: () => options.virtual ?? null, prefixResidentFiles: () => [] }), review.updateTool(), review.resolveTool(),
    { name: 'end_turn', description: 'End turn.', tags: ['flow'], endsTurn: true, parameters: {}, handler: async () => '[ended]' }, ...extra,
  ], role);
  const call = async (name: string, args: Record<string, unknown>, role = 'dream', extra: ToolDef[] = []) => receipt(await tools(role, extra).find(tool => tool.name === name)!.handler(args, { role, log: nullLogger() }));
  return { root, memory, statePath, cfg, review, tools, call, requests, injected,
    choice: (next: string) => { choice = next; }, currentChoice: () => choice, fail: (next: boolean) => { failed = next; } };
}

it('stages before writes, permits reads, blocks later side effects and consumes a proceed only once', async () => {
  const f = fixture();
  const id = staged(await f.call('write_file', { path: 'note/a.md', content: 'first' }));
  expect(f.memory.exists('note/a.md')).toBe(false);
  expect(await f.call('write_file', { path: 'note/later.md', content: 'later' })).toContain('preceding action');
  expect(await f.call('read_file', { path: 'state/STATE.md' })).toContain('STATE revision');
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: ' ' })).toContain('nonempty');
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('[written]');
  expect(f.memory.readFile('note/a.md')).toBe('first'); expect(f.memory.exists('note/later.md')).toBe(false);
  expect(await f.call('state_review_resolve', { id, decision: 'proceed', reason: 'x' })).toContain('expired');
  f.choice('allow'); await f.call('write_file', { path: 'note/later.md', content: 'resubmitted' });
  expect(f.memory.readFile('note/later.md')).toBe('resubmitted'); expect(f.requests).toHaveLength(2);
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
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: 'x', constraints: [{ ...rule, scope: { sessions: ['main'] } }] }));
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
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: '', constraints: [{ ...rule, scope: { tools: ['read_file'] } }] }));
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
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: '', constraints: [{ ...rule, scope: { tools: ['read_file'] } }] }));
  expect(await f.call('read_file', { path: 'CORE.md', offset: 1, limit: 1 })).toBe('one\ntwo\nthree');
  expect(f.requests.at(-1)!.action.read).toMatchObject({ lines: 3, chars: 13, full: true, limit: 1 });
});

it('falls back for the turn, retries only real next-turn work and notifies once per outage', async () => {
  const f = fixture(); f.fail(true);
  expect(await f.call('write_file', { path: 'note/a.md', content: 'a' })).toContain('可以通知维护者');
  await f.call('append_file', { path: 'note/a.md', content: 'b' }); expect(f.requests).toHaveLength(1);
  f.review.end('dream'); f.review.begin('dream'); expect(f.requests).toHaveLength(1);
  expect(await f.call('append_file', { path: 'note/a.md', content: 'c' })).not.toContain('可以通知维护者');
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
      return { answers: Object.fromEntries(Object.keys(questions as object).map(key => [key, { choice: f.currentChoice() }])) };
    }, close: async () => {},
  }) });
  f.cfg.cognition!.blacklist = [{ id: 'all', label: 'all', enabled: true, match: {} }];
  f.cfg.providers = { fixture: { kind: 'openai-responses-compat', baseUrl: 'https://model.test', spec: { model: 'test-model', thinking: false } } };
  f.cfg.activeProvider = 'fixture';
  const persona = new ContinuityPersona({ cfg: f.cfg, appraiser, memoryDir: f.memory.memoryDir, dataDir: join(f.root, 'data'), deploymentDir: f.root });
  closers.push(() => persona.dispose()); return { ...f, persona };
}

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
    if (step === 2) return toolReply([{ name: 'update_state', args: { text: 'Keep useful dates.', constraints: [], expectedRevision: /\[STATE revision: ([a-f0-9]+)/.exec(llm.calls.at(-1)!.messages.at(-1)!.content!)![1] } }]);
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
      expect(receipts.some(text => text.includes('STATE revision'))).toBe(true);
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

it('injects ordinary STATE at existing boundaries only and restores full legacy reminders when off', async () => {
  const f = personaFixture(); const injected: string[] = [];
  f.persona.attach(makeFakeHarnessApi({ injectInternal: text => { injected.push(text); },
    toolsTagged: () => new Set(f.persona.declareSessions().flatMap(decl => decl.tools().map(tool => tool.name))) }));
  f.persona.onOpening({ reason: 'new' });
  const states = () => injected.filter(text => text.startsWith('[system/continuity-state]'));
  expect(states()).toHaveLength(1); expect(states()[0]).toContain('Current concern.'); expect(states()[0]).not.toContain('Omit processing');
  const deliver = async () => f.persona.onDelivery({ events: [{ origin: 'external', cursor: injected.length, ts: new Date().toISOString(), source: 'chat', type: 'chat.message', text: 'hi' }] });
  for (let i = 0; i < 12; i++) await deliver(); expect(states()).toHaveLength(1);
  f.memory.writeFileAtomic('state/STATE.md', renderState({ text: 'Changed outside.', constraints: [rule] }));
  f.persona.onTurnEnded(); await deliver(); expect(states()).toHaveLength(2); expect(states()[1]).toContain('Changed outside.');
  const raw = f.memory.readFile('state/STATE.md'); f.cfg.cognition!.stateReview!.enabled = false;
  f.persona.onTurnEnded(); await deliver(); expect(states().at(-1)).toContain('Omit processing'); expect(f.memory.readFile('state/STATE.md')).toBe(raw);
});
