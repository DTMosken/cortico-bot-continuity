import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { FakeLLM, textReply, makeFakeHarnessApi } from '../../Cortico/tests/core/helpers.ts';
import { composeDefaults } from '../index.ts';
import { Dream } from '../persona/subconscious/index.ts';
import { DreamMaterials, prepareDreamInput, reviewSignals } from '../persona/subconscious/materials.ts';
import { checkMigrationSources } from '../persona/state-migration/source-check.ts';
import { migrationWorkerTools } from '../persona/state-migration/worker.ts';
import { checkedSources } from './migration-check-fixture.ts';
import { trimMigrationReadFallback } from '../persona/state-migration/context.ts';
import { runWorker } from '../persona/subagents/runtime.ts';
import { SessionTracker } from 'cortico/core/sessions.ts';

it('continues a read-heavy worker without discarding original telemetry, the current draft or the latest evidence', async () => {
  const oldBody = 'old history '.repeat(6000);
  const records = [message('system', 'Keep source obligations.'), functionCall('empty', 'migration_history', '{"query":"missing"}'), functionResult('empty', 'No matches.'),
    functionCall('old', 'migration_history', '{"id":"earlier"}'), functionResult('old', oldBody),
    functionCall('draft', 'migration_draft', '{"text":"preserved finding"}'), functionResult('draft', '[draft saved]'),
    functionCall('recent', 'migration_history', '{"id":"recent"}'), functionResult('recent', 'Relevant recent evidence.')];
  const llm = new FakeLLM(); llm.script(textReply('Finished reading.'));
  const result = await runWorker({ core: { sessions: new SessionTracker('UTC'), internBlobs: () => [] }, llm, spec: { model: 'fixture', thinking: false },
    messages: records, tools: [], contextTokens: 4000, signal: new AbortController().signal, label: 'fixture', log: nullLogger(),
    stopped: () => false, finished: () => false, progress() {}, onBeforeRequest: trimMigrationReadFallback });
  expect(result.reason).toBe('natural');
  expect(JSON.stringify(llm.calls[0].messages)).toContain('preserved finding'); expect(JSON.stringify(llm.calls[0].messages)).toContain('Relevant recent evidence.');
  expect(JSON.stringify(llm.calls[0].messages)).not.toContain(oldBody); expect(JSON.stringify(records)).toContain(oldBody);
  expect(JSON.stringify(llm.calls[0].messages)).toContain('No matches.');
});

it('keeps authoritative sources and relevant replay evidence without duplicating bulk history in source review', async () => {
  const sources = { 'state/STATE.md': 'Keep identifiers.' }, llm = new FakeLLM(); llm.script(textReply(checkedSources(sources, ['ids'])));
  const input = { spec: { model: 'fixture', thinking: false }, contextTokens: 10000, readChars: 100, sources, history: [], tools: [] };
  await checkMigrationSources(input, llm, new AbortController().signal, { text: '', constraints: [{ id: 'ids', instruction: 'Keep identifiers.', exceptions: '', scope: { sessions: ['main'], tags: ['write'] } }] },
    sources, [], [{ id: 'older', text: 'unrelated-history '.repeat(20000) }], [{ evidence: 'Relevant recent dialogue.', mismatch: true }]);
  const payload = JSON.parse(llm.calls[0].messages.at(-1)!.content as string);
  expect(payload.sources).toEqual(sources); expect(payload.historySources).toEqual(['older']); expect(payload.historyBodiesOmitted).toBe(true);
  expect(payload.replays[0].evidence).toBe('Relevant recent dialogue.'); expect(JSON.stringify(payload)).not.toContain('unrelated-history');
});

it.each([['allow', 'remind'], ['remind', 'allow']] as const)('rechecks %s reference against %s replay without forcing a rule relaxation', async (expected, choice) => {
  const sources = { 'state/STATE.md': 'Keep identifiers unchanged.' };
  const llm = new FakeLLM(); llm.script(textReply(checkedSources(sources, ['ids'])), textReply(checkedSources(sources, ['ids'])));
  const input = { spec: { model: 'fixture', thinking: false }, contextTokens: 20000, readChars: 100, sources, history: [],
    tools: [{ session: 'main', tools: [{ name: 'publish', description: 'Publish text.', parameters: {}, tags: ['speak' as const] }] }] };
  const worker = migrationWorkerTools(input, { llm, signal: new AbortController().signal, review: async () => ({ kind: 'reviewed', choices: { ids: choice } }) });
  const call = (name: string, args: Record<string, unknown>) => worker.tools.find(tool => tool.name === name)!.handler(args, { role: 'dream', log: nullLogger() });
  await call('migration_draft', { text: '', constraints: [{ id: 'ids', instruction: sources['state/STATE.md'], exceptions: '', scope: { sessions: ['main'], tags: ['speak'] } }] });
  await call('migration_check', {});
  expect(String(await call('migration_review', { session: 'main', tool: 'publish', args: { text: 'Entry Q-17.' }, expected, evidence: 'Original identifier Q-17.' }))).toContain('sourceCheckRequired');
  await expect(call('migration_finish', { reason: 'diminishing_returns', explanation: 'Model blind spot.' })).rejects.toThrow();
  await call('migration_check', {});
  const payload = JSON.parse(llm.calls.at(-1)!.messages.at(-1)!.content as string);
  expect(payload.replays[0]).toMatchObject({ action: { tool: 'publish', args: { text: 'Entry Q-17.' } }, mismatch: true, expected, result: { choices: { ids: choice } } });
  await call('migration_finish', { reason: 'diminishing_returns', explanation: 'Sources remain faithful; no justified wording change.' });
  expect(worker.candidate()?.document.constraints[0].instruction).toBe(sources['state/STATE.md']);
});

it('does not accept a ready claim with an explicitly uncovered independent obligation', async () => {
  const llm = new FakeLLM(); llm.script(textReply(JSON.stringify({ ready: true, issues: [], coverage: [
    { source: 'state/STATE.md', quote: 'Preserve serials', constraintIds: ['serials'] },
    { source: 'state/STATE.md', quote: 'repair citations', constraintIds: [] },
  ] })));
  const document = { text: '', constraints: [{ id: 'serials', instruction: 'Preserve serials.', exceptions: '', scope: { sessions: ['main'], tags: ['write' as const] } }] };
  const sources = { 'state/STATE.md': 'Preserve serials and repair citations.' };
  const input = { spec: { model: 'fixture', thinking: false }, contextTokens: 10000, readChars: 100, tools: [], sources, history: [] };
  const result = await checkMigrationSources(input, llm, new AbortController().signal, document, sources, [], []);
  expect(result.ready).toBe(false); expect(result.issues.some(issue => issue.detail.includes('repair citations'))).toBe(true);
});

it('reports invented source references without accepting a coverage claim', async () => {
  const llm = new FakeLLM(); llm.script(textReply(JSON.stringify({ ready: true, issues: [], coverage: [
    { source: 'state/STATE.md', quote: 'Invented permission', constraintIds: [] },
  ] })));
  const sources = { 'state/STATE.md': 'Keep commitments.' };
  const input = { spec: { model: 'fixture', thinking: false }, contextTokens: 10000, readChars: 100, tools: [], sources, history: [] };
  const check = await checkMigrationSources(input, llm, new AbortController().signal, { text: '', constraints: [] }, sources, [], []);
  expect(check).toMatchObject({ ready: false, coverage: [] });
  expect(check.issues.some(issue => issue.detail.includes('coverage[0].quote') && issue.detail.includes('Invented permission'))).toBe(true);
});

const records = () => [message('user', 'Keep sensitive content out of shared notes.'),
  functionCall('write', 'write_file', '{"path":"note/shared.md","content":"restricted content"}'),
  functionResult('write', '[state review staged] write_file 已暂存，尚未执行。'),
  functionCall('override', 'state_review_resolve', '{"id":"pending","decision":"proceed","reason":"I think this is harmless."}'),
  functionResult('override', '[state review failed] target changed'),
  functionCall('normal', 'write_file', '{"path":"note/other.md","content":"a successful action also needs inspection"}'),
  functionResult('normal', '[written] note/other.md')];

it('restores review signals with raw reasons and successful actions without labeling overrides correct', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-materials-'));
  try {
    const store = new DreamMaterials(dir); store.add(records());
    const restored = new DreamMaterials(dir), item = restored.pending()[0];
    expect(reviewSignals(item.records)).toEqual({ staged: 1, proceed: 1, cancel: 0 });
    const input = prepareDreamInput([item], { maxInputTokens: 10000, maxBackgroundTokens: 0, system: [], state: '', guide: '', background: '', reviewFeedback: true });
    expect(JSON.stringify(input.messages)).toContain('not confirmed misjudgments');
    const original = restored.read(item.id, 0, 12000);
    expect(original).toContain('I think this is harmless'); expect(original).toContain('target changed'); expect(original).toContain('successful action also needs inspection');
    expect(reviewSignals([functionCall('bad', 'state_review_resolve', 'invalid')])).toEqual({ staged: 0, proceed: 0, cancel: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([true, false])('exposes review locations only when enabled (%s) and retains original actions', async enabled => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-review-')); const log = nullLogger();
  try {
    let read = '';
    const core = makeFakeHarnessApi({ spawnFork: async fork => {
      const call = (name: string, args: Record<string, unknown>) => fork.tools!.find(tool => tool.name === name)!.handler(args, { role: 'dream', log });
      const page = JSON.parse(await call('dream_materials', {}) as string);
      if (enabled) expect(page.items[0].stateReview).toEqual({ staged: 1, proceed: 1, cancel: 0 });
      else expect(page.items[0]).not.toHaveProperty('stateReview');
      read = await call('dream_read_material', { id: page.items[0].id, maxChars: 12000 }) as string;
      expect(JSON.stringify(fork.messages).includes('Independently inspect successful actions')).toBe(enabled);
      await call('surface', { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' });
      return '';
    } });
    const cfg = composeDefaults(); cfg.cognition!.stateReview = { enabled };
    const dream = new Dream({ cfg, core, dataDir: dir, dreamTools: () => [], toolUsageText: () => '', log, onEmergence() {} });
    await dream.schedule(records());
    expect(read).toContain('restricted content'); expect(read).toContain('successful action also needs inspection');
    expect(dream.getStatus().pendingMaterials).toBe(0); dream.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
