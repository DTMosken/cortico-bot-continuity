import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger } from 'cortico/core/util.ts';
import { FakeLLM, textReply } from '../../Cortico/tests/core/helpers.ts';
import { composeDefaults } from '../index.ts';
import { Appraiser } from '../persona/appraisal.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { workspaceTools } from '../base/persona/workspaceTools.ts';
import { StateReview, prepareStateAction } from '../persona/state-review.ts';
import { renderState } from '../persona/state-document.ts';
import { StateMigration } from '../persona/state-migration/index.ts';
import { migrationWorkerTools } from '../persona/state-migration/worker.ts';
import type { MigrationInput } from '../persona/state-migration/contracts.ts';

const roots: string[] = [], closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ctx = { role: 'dream', log: nullLogger() };
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'migration-fixes-')); roots.push(root); return root; };
function setup() {
  const memory = new GitWorkspaceMemory({ memoryDir: temp() });
  const config = composeDefaults();
  const appraiser = new Appraiser(config.appraisal!); closers.push(() => appraiser.dispose());
  const options = { memory, core: () => null, appraiser, enabled: () => true, readOverride: () => null, speechContext: () => ({ recentDialogue: [] }) };
  return { memory, appraiser, options, config };
}

it('derives migration availability from external edits, scope validity and empty documents without waiting for a turn', () => {
  const { memory, options, config } = setup(); memory.writeFileAtomic('state/STATE.md', renderState({ text: '', constraints: [] }));
  const review = new StateReview(options); review.begin('main');
  memory.writeFileAtomic('state/STATE.md', 'Legacy again.'); expect(review.status()).toMatchObject({ status: '不可用', migrationPending: true });
  memory.writeFileAtomic('state/STATE.md', ''); expect(review.status().migrationPending).toBe(false);
  memory.writeFileAtomic('state/STATE.md', 'ordinary\n\n## Action constraints\n### old\n- instruction: "Keep it"\n- exceptions: ""\n');
  config.appraisal!.provider = 'laya';
  expect(review.status().reason).toContain('迁移旧约束'); expect(review.status().reason).not.toContain('下一次正常 Dream');
});

it('clears a delivered completion marker when STATE is reverted to a legacy or invalid document', () => {
  const { memory, appraiser } = setup();
  const migration = new StateMigration({ memory, appraiser, enabled: () => true, runtime: () => null, api: () => null, dream: () => undefined,
    appraisalConfig: () => composeDefaults().appraisal!, tools: () => [], readChars: () => 100, contextTokens: () => 1000 });
  memory.writeFileAtomic('state/STATE.md', renderState({ text: 'done', constraints: [] }));
  Object.assign(migration, { deliveredId: 'done', last: { status: 'waiting' } }); expect(migration.state().status).toBe('complete');
  memory.writeFileAtomic('state/STATE.md', 'old format'); expect(migration.state().status).toBe('idle');
});

it.each(['./state/STATE.md', 'state\\STATE.md'])('recognizes full range coverage through equivalent STATE path %s', async path => {
  const { memory, options } = setup(); memory.writeFileAtomic('state/STATE.md', 'one\ntwo\n');
  const review = new StateReview({ ...options, enabled: () => false, wholeReadFallbackChars: () => 4 });
  const tools = review.wrap([...workspaceTools({ memory, writeGuard: () => null, readOverride: () => null, prefixResidentFiles: () => [], wholeReadFallbackChars: () => 4 }), review.updateTool()], 'dream');
  const call = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.handler(args, ctx);
  await call('read_file', { path }); await call('read_file', { path, offset: 2 });
  expect(await call('update_state', { text: 'new', constraints: [] })).toContain('[written]');
});

it('previews the same normalized folder destination and rejects impossible line changes without inventing a diff', async () => {
  const { memory, options } = setup(); memory.writeFileAtomic('note/sub/a.md', 'one\ntwo\n');
  const spec = { name: 'move_file', description: '', tags: ['write' as const], parameters: {} };
  const prepared = prepareStateAction(options, spec, { from: 'note\\sub', to: 'external\\dest' }, 'dream');
  expect(prepared.action).toMatchObject({ move: { pairs: [{ from: 'note/sub/a.md', to: 'external/dest/a.md' }] } });
  const invalid = prepareStateAction(options, spec, { from: 'note/sub/a.md', to: 'note/new.md', offset: 99 }, 'dream');
  expect(invalid.action.change).toBeUndefined(); expect(invalid.action.invalid).toBeDefined();
  memory.writeFileAtomic('note/empty.md', '');
  expect(prepareStateAction(options, spec, { from: 'note/empty.md', to: 'note/new.md', offset: 1 }, 'dream').action.change).toBeUndefined();
});

it('requires actual applicable decision replay and an independent source check for the latest draft', async () => {
  const llm = new FakeLLM(); llm.script(textReply('{"ready":false,"issues":[{"kind":"scope","detail":"The authorship rule only covers retrieval."}]}'), textReply('{"ready":true,"issues":[]}'));
  let decisions = 0;
  const input: MigrationInput = { spec: { model: 'fixture', thinking: false }, contextTokens: 100000, readChars: 100, history: [],
    sources: { 'state/STATE.md': 'Preserve identifiers and repair existing citations.', 'CONSTITUTION.md': 'Keep ordinary preferences.' },
    tools: [{ session: 'main', tools: [
      { name: 'send_text', tags: ['speak'], description: 'Publish authored text', parameters: {} },
      { name: 'read_entry', tags: ['read'], description: 'Retrieve one entry', parameters: {} },
      { name: 'qq_confirm', tags: ['speak'], description: 'Confirm or cancel draft', parameters: {} },
    ] }] };
  const worker = migrationWorkerTools(input, { llm, signal: new AbortController().signal, review: async () => { decisions++; return { kind: 'reviewed', choices: { authorship: 'allow' } }; } });
  const call = (name: string, args: Record<string, unknown>) => worker.tools.find(tool => tool.name === name)!.handler(args, ctx);
  const doc = { text: 'Ordinary preferences.', constraints: [{ id: 'authorship', scope: { sessions: ['main'], tools: ['send_text', 'qq_confirm'] }, instruction: 'Keep identifiers.', exceptions: '' }] };
  const receipt = await call('migration_draft', doc); expect(String(receipt)).toContain('effectiveScope');
  await call('migration_review', { session: 'main', tool: 'read_entry', args: {}, expected: 'allow', evidence: 'Reading is unrelated.' });
  await call('migration_review', { session: 'main', tool: 'qq_confirm', args: { decision: 'cancel' }, expected: 'allow', evidence: 'Cancel.' });
  expect(decisions).toBe(0);
  await expect(call('migration_finish', { reason: 'ready', explanation: 'done' })).rejects.toThrow();
  await call('migration_review', { session: 'main', tool: 'send_text', args: {}, expected: 'allow', evidence: 'Valid text.' });
  await call('migration_check', {});
  await expect(call('migration_finish', { reason: 'ready', explanation: 'done' })).rejects.toThrow();
  await call('migration_draft', doc); await call('migration_check', {});
  const checkMessages = llm.calls.at(-1)!.messages;
  const checkInput = JSON.parse(checkMessages.at(-1)!.content as string);
  expect(checkInput.tools).toEqual(input.tools);
  expect(JSON.stringify(checkMessages)).toContain('repair existing citations'); expect(JSON.stringify(checkMessages)).toContain('effectiveScope');
  expect(JSON.stringify(checkMessages)).not.toContain('Reading is unrelated.');
  await expect(call('migration_finish', { reason: 'ready', explanation: 'done' })).rejects.toThrow();
  await call('migration_review', { session: 'main', tool: 'send_text', args: {}, expected: 'allow', evidence: 'Valid text.' });
  await call('migration_finish', { reason: 'ready', explanation: 'Source checked and replayed.' }); expect(worker.candidate()).toBeDefined();
  await expect(call('migration_draft', { ...doc, constraints: [{ ...doc.constraints[0], scope: { ...doc.constraints[0].scope, tags: ['write'] } }] })).rejects.toThrow('OR tags');
});

it('invalidates source approval when another source is consulted and fails closed on malformed checker output', async () => {
  const llm = new FakeLLM(); llm.script(textReply('{"ready":true,"issues":[]}'), textReply('not a source-check result'));
  const input: MigrationInput = { spec: { model: 'fixture', thinking: false }, contextTokens: 10000, readChars: 100, history: [],
    sources: { 'state/STATE.md': 'Keep commitments.', 'Additions.md': 'Keep original alternatives.' },
    tools: [{ session: 'main', tools: [{ name: 'send_text', description: 'Send authored text', parameters: {}, tags: ['speak'] }] }] };
  const worker = migrationWorkerTools(input, { llm, signal: new AbortController().signal, review: async () => ({ kind: 'reviewed', choices: { rule: 'allow' } }) });
  const call = (name: string, args: Record<string, unknown>) => worker.tools.find(tool => tool.name === name)!.handler(args, ctx);
  await call('migration_draft', { text: '', constraints: [{ id: 'rule', scope: { sessions: ['main'], tags: ['speak'] }, instruction: 'Keep commitments.', exceptions: '' }] });
  await call('migration_review', { session: 'main', tool: 'send_text', args: {}, expected: 'allow', evidence: 'Ordinary message.' });
  await call('migration_check', {}); await call('migration_sources', { path: 'Additions.md' });
  await expect(call('migration_finish', { reason: 'ready', explanation: 'done' })).rejects.toThrow();
  await expect(call('migration_check', {})).rejects.toThrow();
  await expect(call('migration_finish', { reason: 'ready', explanation: 'done' })).rejects.toThrow();
  expect(worker.candidate()).toBeUndefined();
  expect(JSON.stringify(llm.calls.at(-1)!.messages)).toContain('Keep original alternatives.');
});
