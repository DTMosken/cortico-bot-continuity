import { expect, it } from 'vitest';
import { SessionTracker } from 'cortico/core/sessions.ts';
import { FakeLLM, textReply, toolReply } from '../../Cortico/tests/core/helpers.ts';
import { runMigrationWorker, type MigrationServices } from '../persona/state-migration/worker.ts';
import { parseMigrationCases, replayMigrationCase } from '../persona/state-migration/fixtures.ts';
import type { MigrationInput } from '../persona/state-migration/contracts.ts';
import { renderState } from '../persona/state-document.ts';
import { fixedCases, fixtureReview, checkedSources, migrationReplies } from './migration-check-fixture.ts';

const input: MigrationInput = { spec: { model: 'fixture', thinking: false }, contextTokens: 100000, readChars: 100000,
  sources: { 'state/STATE.md': 'Do not emit processing metadata.' }, history: [{ id: 'run/old', text: 'Earlier source feedback.' }],
  tools: [{ session: 'main', tools: [{ name: 'chat_send', description: 'Publish a message.', parameters: { type: 'object', properties: { text: { type: 'string' } } }, tags: ['speak'] }] }] };
const document = { text: 'Ordinary guidance.', constraints: [{ id: 'style', instruction: input.sources['state/STATE.md'], exceptions: '', scope: { sessions: ['main'], tools: ['chat_send'] } }] };
const write = (path: string, content: string) => toolReply([{ name: 'write_file', args: { path, content } }]);
const patch = (old_string: string, new_string: string) => toolReply([{ name: 'edit_file', args: { path: 'work/STATE.md', old_string, new_string } }]);
function services(llm: FakeLLM, review: MigrationServices['review'] = async action => fixtureReview(action)): MigrationServices {
  return { core: { sessions: new SessionTracker('UTC'), internBlobs: () => [] }, llm, signal: new AbortController().signal, review, progress() {} };
}

const initial = (extra = {}) => textReply(JSON.stringify({ ready: true, issues: [], ...fixedCases(input.sources), ...extra }));
const done = () => textReply('Draft ready.');
const checked = (extra = {}) => textReply(JSON.stringify({ ready: true, issues: [], ...extra }));

it('starts with the original STATE, exposes the format and checks sources before decisions', async () => {
  const llm = new FakeLLM(); let requestsAtReview = 0;
  llm.script(toolReply([{ name: 'read_file', args: { path: 'work/STATE.md' } }]), ...migrationReplies(input.sources, document));
  await runMigrationWorker(input, services(llm, async action => { requestsAtReview = llm.calls.length; return fixtureReview(action); }));
  expect(JSON.stringify(llm.calls[1].messages)).toContain(input.sources['state/STATE.md']);
  expect(JSON.stringify(llm.calls[0].messages)).toContain('no nested scope field');
  expect(requestsAtReview).toBe(4);
  const request = JSON.parse(llm.calls[3].messages.at(-1)!.content as string);
  expect(request.mode).toBe('global'); expect(request.candidate).toEqual(document); expect(request.tools).toEqual(input.tools);
});

it('repairs initial source defects before decisions and performs only a focused recheck', async () => {
  const llm = new FakeLLM(); const observed: string[] = [];
  const wrong = { ...document, constraints: [{ ...document.constraints[0], instruction: 'Everything is allowed.' }] };
  const issue = { id: 'meaning', kind: 'meaning', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'Restore the source requirement.', constraintIds: ['style'] };
  llm.script(write('work/STATE.md', renderState(wrong)), done(), initial({ ready: false, issues: [issue] }),
    patch('Everything is allowed.', document.constraints[0].instruction), done(), checked({ resolved: ['meaning'] }));
  const result = await runMigrationWorker(input, services(llm, async (action, rules) => { observed.push(rules[0].instruction); return fixtureReview(action); }));
  expect(result.document).toEqual(document); expect(observed).toEqual([document.constraints[0].instruction, document.constraints[0].instruction]);
  const audits = llm.calls.filter(call => !call.tools?.length).map(call => JSON.parse(call.messages.at(-1)!.content as string));
  expect(audits.map(item => item.mode)).toEqual(['global', 'focused']);
  expect(llm.calls.filter(call => call.tools?.some(tool => tool.name.startsWith('migration_')))).toEqual([]);
});

it('does not add a consolidation request when no edit is needed', async () => {
  const llm = new FakeLLM(); llm.script(...migrationReplies(input.sources, document));
  expect((await runMigrationWorker(input, services(llm))).reason).toBe('ready');
  expect(llm.calls).toHaveLength(4);
});

it('keeps empty constraints and ordinary guidance without invoking the decision service', async () => {
  const llm = new FakeLLM(); const plain = { text: input.sources['state/STATE.md'], constraints: [] }; let reviews = 0;
  llm.script(write('work/STATE.md', renderState(plain)), done(), initial({ cases: [] }));
  const result = await runMigrationWorker(input, services(llm, async () => { reviews++; throw new Error('Unexpected decision request'); }));
  expect(result.document).toEqual(plain); expect(reviews).toBe(0);
});

it('requires source-grounded disposition for remaining model misses', async () => {
  const llm = new FakeLLM();
  llm.script(write('work/STATE.md', renderState(document)), done(), initial(), checked(), done(),
    checked({ caseFindings: [{ caseId: 'metadata', kind: 'model', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'The faithful rule missed the submitted restricted text.' }] }));
  expect((await runMigrationWorker(input, services(llm, async () => ({ kind: 'reviewed', choices: { style: 'allow' } })))).reason).toBe('diminishing_returns');
});

it('sends necessary premises and retains individual rule judgments', async () => {
  const sample = parseMigrationCases(JSON.stringify(fixedCases(input.sources)), input)[1];
  const result = await replayMigrationCase(input, sample, document, services(new FakeLLM()));
  expect(result.actual).toBe('remind'); expect(result.judgments[0]).toMatchObject({ id: 'style', choice: 'remind' });
});

it('stops on service failure without retrying or accepting a candidate', async () => {
  const llm = new FakeLLM(); let reviews = 0;
  llm.script(write('work/STATE.md', renderState(document)), done(), initial());
  await expect(runMigrationWorker(input, services(llm, async () => { reviews++; return { kind: 'unavailable', reason: 'HTTP 429' }; }))).rejects.toThrow('valid reviewed result');
  expect(reviews).toBe(1); expect(llm.calls).toHaveLength(3);
});

it('stops without another request when cancelled during replay', async () => {
  const llm = new FakeLLM(), controller = new AbortController();
  llm.script(write('work/STATE.md', renderState(document)), done(), initial());
  const deps = services(llm, async action => { controller.abort(); return fixtureReview(action); }); deps.signal = controller.signal;
  await expect(runMigrationWorker(input, deps)).rejects.toThrow(); expect(llm.calls).toHaveLength(3);
});

it('returns source and tool errors together', () => {
  const bank = fixedCases(input.sources);
  expect(() => parseMigrationCases(JSON.stringify({ cases: [{ ...bank.cases[0], source: { path: 'missing', quote: 'invented' } }, { ...bank.cases[1], tool: 'missing' }] }), input)).toThrow(/source reference[\s\S]*unavailable/);
});

it('permits source reading without a fixed round cap', async () => {
  const llm = new FakeLLM();
  llm.script(...Array.from({ length: 35 }, () => toolReply([{ name: 'read_file', args: { path: 'sources/state/STATE.md' } }])), ...migrationReplies(input.sources, document));
  expect((await runMigrationWorker(input, services(llm))).reason).toBe('ready');
});

it('requires valid scope before source checking or replay', async () => {
  const llm = new FakeLLM(), invalid = { ...document, constraints: [{ ...document.constraints[0], scope: { sessions: ['main'], tools: ['missing'] } }] };
  llm.script(write('work/STATE.md', renderState(invalid)), patch('"missing"', '"chat_send"'), done(), initial(), checked());
  expect((await runMigrationWorker(input, services(llm))).document).toEqual(document); expect(JSON.stringify(llm.calls[1].messages)).toContain('matches no tool');
});

it('rechecks body repairs while reusing unaffected decision results', async () => {
  const llm = new FakeLLM(); let reviews = 0;
  const issue = { id: 'body', kind: 'meaning', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'Repair the changed body.', change: { text: 'Ordinary guidance.' } };
  llm.script(write('work/STATE.md', renderState(document)), done(), initial({ ready: false, issues: [issue] }),
    patch('Ordinary guidance.', 'Intermediate guidance.'), done(), checked({ ready: false, issues: [issue] }),
    patch('Intermediate guidance.', 'Repaired guidance.'), done(), checked({ resolved: ['body'] }));
  const result = await runMigrationWorker(input, services(llm, async action => { reviews++; return fixtureReview(action); }));
  expect(result.document.text).toBe('Repaired guidance.'); expect(reviews).toBe(2);
});

it('replays a source-backed corrected case while retaining other cases', async () => {
  const llm = new FakeLLM(); let reviews = 0;
  const modified = { ...fixedCases(input.sources).cases[0], context: 'Updated evidence: an ordinary greeting.' };
  llm.script(write('work/STATE.md', renderState(document)), done(), initial(), checked({ cases: [modified], caseReasons: { ordinary: 'Clarify the supplied evidence without changing the source requirement.' } }), checked());
  await runMigrationWorker(input, services(llm, async action => { reviews++; return fixtureReview(action); }));
  expect(reviews).toBe(3); expect(llm.calls).toHaveLength(5);
});

it('rejects an unrelated hold even when its aggregate label matches', async () => {
  const llm = new FakeLLM(), wrong = { ...document, constraints: [{ ...document.constraints[0], instruction: 'Everything is allowed.' }, { ...document.constraints[0], id: 'other', instruction: 'Other requirement.' }] };
  llm.script(write('work/STATE.md', renderState(wrong)), done(), initial(), checked({ caseFindings: [{ caseId: 'metadata', kind: 'unrelated', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'The unrelated rule caused the hold.' }] }),
    patch('Everything is allowed.', document.constraints[0].instruction), done(), checked());
  const result = await runMigrationWorker(input, services(llm, async (action, rules) => {
    const bad = rules[0].instruction === 'Everything is allowed.', restricted = JSON.stringify(action).includes('processing metadata');
    return { kind: 'reviewed', choices: { style: restricted && !bad ? 'remind' : 'allow', other: restricted && bad ? 'insufficient' : 'allow' } };
  }));
  expect(result.document.constraints[0].instruction).toBe(document.constraints[0].instruction);
});

it('repairs rejected scenarios directly before replay without another actor request', async () => {
  const llm = new FakeLLM(); let firstReplayAt = 0;
  const bank = fixedCases(input.sources).cases;
  llm.script(write('work/STATE.md', renderState(document)), done(), initial({ cases: [bank[0], { ...bank[1], tool: 'missing' }] }),
    checked({ cases: [bank[1]] }), checked());
  const result = await runMigrationWorker(input, services(llm, async action => { firstReplayAt ||= llm.calls.length; return fixtureReview(action); }));
  expect(result.document).toEqual(document); expect(firstReplayAt).toBe(4);
  expect(llm.calls.filter(call => call.tools?.length)).toHaveLength(2);
  const correction = JSON.parse(llm.calls[3].messages.at(-1)!.content as string);
  expect(correction.mode).toBe('correction'); expect(correction.sources).toEqual(input.sources); expect(correction.tools).toEqual(input.tools);
  expect(correction.candidate).toEqual(document); expect(correction.cases).toEqual([bank[0]]);
  expect(correction.errors.map((error: { id: string }) => error.id)).toEqual(['case-format-1', 'case-coverage']);
});

it('retains a new replay defect when a case was added without editing the candidate', async () => {
  const llm = new FakeLLM(); let reviews = 0;
  const extra = { ...fixedCases(input.sources).cases[0], id: 'boundary', expected: 'uncertain' };
  const defect = { id: 'new-boundary', kind: 'scope', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], caseIds: ['boundary'], constraintIds: ['style'], detail: 'Clarify the affected scope.' };
  llm.script(write('work/STATE.md', renderState(document)), done(), initial(), checked({ cases: [extra] }),
    checked({ ready: false, issues: [defect] }), patch('Ordinary guidance.', 'Clarified guidance.'), done(), checked({ resolved: ['new-boundary'] }));
  const result = await runMigrationWorker(input, services(llm, async action => { reviews++; return fixtureReview(action); }));
  expect(result.document.text).toBe('Clarified guidance.'); expect(reviews).toBe(3);
  expect(JSON.stringify(llm.calls[5].messages)).toContain(defect.detail);
});

it('corrects a replay disposition before invoking the actor and finishes without another review', async () => {
  const llm = new FakeLLM();
  const finding = { caseId: 'metadata', kind: 'model', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'The faithful rule is a decision-model limitation.' };
  llm.script(write('work/STATE.md', renderState(document)), done(), initial(),
    checked({ caseFindings: [{ ...finding, quote: 'Invalid excerpt.' }] }), checked({ caseFindings: [finding] }));
  const result = await runMigrationWorker(input, services(llm, async () => ({ kind: 'reviewed', choices: { style: 'allow' } })));
  expect(result.reason).toBe('diminishing_returns'); expect(llm.calls).toHaveLength(5);
  expect(llm.calls.filter(call => call.tools?.length)).toHaveLength(2);
  const first = JSON.parse(llm.calls[3].messages.at(-1)!.content as string);
  const correction = JSON.parse(llm.calls[4].messages.at(-1)!.content as string);
  expect(correction.replays).toEqual(first.replays); expect(correction.changes).toEqual(first.changes);
});

it('corrects mixed initial errors before one actor repair and retains the actual edit baseline', async () => {
  const llm = new FakeLLM(), bank = fixedCases(input.sources).cases;
  const issue = { id: 'body', kind: 'meaning', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'Repair ordinary guidance.' };
  llm.script(write('work/STATE.md', renderState(document)), done(), initial({ ready: false, issues: [issue], cases: [bank[0], { ...bank[1], tool: 'missing' }] }),
    checked({ cases: [bank[1]] }), patch('Ordinary guidance.', 'Repaired guidance.'), done(), checked({ resolved: ['body'] }));
  const result = await runMigrationWorker(input, services(llm));
  expect(result.document.text).toBe('Repaired guidance.'); expect(llm.calls).toHaveLength(7);
  expect(llm.calls[3].tools).toHaveLength(0);
  const last = JSON.parse(llm.calls[6].messages.at(-1)!.content as string);
  expect(last.changes.text).toEqual({ before: 'Ordinary guidance.', after: 'Repaired guidance.' });
  expect(last.previousIssues).toEqual([issue]);
});

it('preserves edited-body context across a post-replay response correction', async () => {
  const llm = new FakeLLM(), bank = fixedCases(input.sources).cases;
  const issue = { id: 'body', kind: 'meaning', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'Repair ordinary guidance.' };
  const regression = { ...issue, id: 'regression', detail: 'The edit lost meaning.', change: { text: 'Intermediate guidance.' } };
  llm.script(write('work/STATE.md', renderState(document)), done(), initial({ ready: false, issues: [issue] }),
    patch('Ordinary guidance.', 'Intermediate guidance.'), done(), checked({ resolved: ['body'], cases: [{ ...bank[0], id: 'invalid', tool: 'missing' }] }),
    checked({ ready: false, issues: [regression] }), patch('Intermediate guidance.', 'Repaired guidance.'), done(), checked({ resolved: ['regression'] }));
  const result = await runMigrationWorker(input, services(llm));
  expect(result.document.text).toBe('Repaired guidance.');
  const original = JSON.parse(llm.calls[5].messages.at(-1)!.content as string), correction = JSON.parse(llm.calls[6].messages.at(-1)!.content as string);
  expect(correction.changes).toEqual(original.changes); expect(correction.replays).toEqual(original.replays);
  expect(JSON.stringify(llm.calls[7].messages)).toContain(regression.detail);
});
