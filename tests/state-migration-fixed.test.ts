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

it('protects source snapshots and frozen cases while using the same scenarios after a targeted candidate edit', async () => {
  const llm = new FakeLLM(), seen: unknown[] = [];
  const wrong = { ...document, constraints: [{ ...document.constraints[0], instruction: 'Everything is allowed.' }] };
  llm.script(
    toolReply([{ name: 'write_file', args: { path: 'sources/state/STATE.md', content: 'changed source' } }, { name: 'write_file', args: { path: 'work/cases.json', content: JSON.stringify(fixedCases(input.sources)) } }]),
    toolReply([{ name: 'write_file', args: { path: 'work/cases.json', content: '{"cases":[]}' } }, { name: 'write_file', args: { path: 'work/STATE.md', content: renderState(wrong) } }]),
    patch('Everything is allowed.', document.constraints[0].instruction), textReply('Ready.'), textReply('Consolidated.'), textReply(checkedSources()),
  );
  const result = await runMigrationWorker(input, services(llm, async (action, rules) => {
    seen.push(action);
    return rules[0].instruction === wrong.constraints[0].instruction ? { kind: 'reviewed', choices: { style: 'allow' } } : fixtureReview(action);
  }));
  expect(result.document).toEqual(document); expect(seen).toHaveLength(4);
  expect(JSON.stringify(seen.slice(0, 2))).toBe(JSON.stringify(seen.slice(2)));
  expect(JSON.stringify(llm.calls[1].messages)).toContain('read-only'); expect(JSON.stringify(llm.calls[2].messages)).toContain('read-only');
  expect(JSON.stringify(llm.calls[2].messages)).toContain('metadata');
  expect(llm.calls.filter(call => call.tools?.some(tool => tool.name.startsWith('migration_')))).toEqual([]);
});

it('performs one global check and then a focused repair with persistent issue IDs', async () => {
  const llm = new FakeLLM();
  const issue = { id: 'ordinary', kind: 'coverage', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'Keep the ordinary reference.' };
  llm.script(write('work/cases.json', JSON.stringify(fixedCases(input.sources))), write('work/STATE.md', renderState(document)),
    textReply('Ready.'), textReply('Consolidated.'), textReply(JSON.stringify({ ready: false, issues: [issue] })),
    patch('Ordinary guidance.', 'Ordinary guidance. Reference retained.'), textReply('Repaired.'), textReply(JSON.stringify({ ready: true, issues: [], resolved: ['ordinary'] })));
  const result = await runMigrationWorker(input, services(llm));
  expect(result.document.text).toContain('Reference retained.');
  const audits = llm.calls.filter(call => !call.tools?.length).map(call => JSON.parse(call.messages.at(-1)!.content as string));
  expect(audits.map(value => value.mode)).toEqual(['global', 'focused']); expect(audits[1].previousIssues).toEqual([issue]);
  expect(audits[1].changes.constraintIds).toEqual([]); expect(audits[1].changes.textChanged).toBe(true);
});

it('requires a source-grounded disposition for a remaining model miss before diminishing-returns completion', async () => {
  const llm = new FakeLLM();
  llm.script(write('work/cases.json', JSON.stringify(fixedCases(input.sources))), write('work/STATE.md', renderState(document)),
    textReply('Ready.'), textReply('Consolidated.'), textReply(checkedSources()), textReply('The source prohibition is preserved.'),
    textReply(JSON.stringify({ ready: true, issues: [], resolved: ['case-metadata'], caseFindings: [{ caseId: 'metadata', kind: 'model', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'The explicit marker is prohibited; the decision model missed the visible content.' }] })));
  const result = await runMigrationWorker(input, services(llm, async () => ({ kind: 'reviewed', choices: { style: 'allow' } })));
  expect(result.reason).toBe('diminishing_returns'); expect(JSON.stringify(llm.calls[5].messages)).toContain('case-metadata');
});

it('sends necessary synthetic premises with the action and never executes the World handler', async () => {
  const sample = parseMigrationCases(JSON.stringify(fixedCases(input.sources)), input)[1];
  sample.context = 'A previous transaction is still pending; the fixture supplies this necessary fact.';
  const result = await replayMigrationCase(input, sample, document, services(new FakeLLM(), async action => {
    const scenario = (action as { scenario: { text: string } }).scenario;
    return { kind: 'reviewed', choices: { style: scenario.text.includes('still pending') ? 'remind' : 'allow' } };
  }));
  expect(result.actual).toBe('remind'); expect(result.mismatch).toBe(false);
});

it('does not send another actor request after cancellation during automatic replay', async () => {
  const llm = new FakeLLM(), controller = new AbortController();
  llm.script(write('work/cases.json', JSON.stringify(fixedCases(input.sources))), write('work/STATE.md', renderState(document)), textReply('Should not run.'));
  const deps = services(llm, async action => { controller.abort(); return fixtureReview(action); }); deps.signal = controller.signal;
  await expect(runMigrationWorker(input, deps)).rejects.toThrow(); expect(llm.calls).toHaveLength(2);
});

it('validates case context, actual tools, source references and positive/negative coverage before freezing', () => {
  const bank = fixedCases(input.sources);
  expect(parseMigrationCases(JSON.stringify(bank), input)).toHaveLength(2);
  expect(() => parseMigrationCases(JSON.stringify({ cases: [bank.cases[0]] }), input)).toThrow('both');
  expect(() => parseMigrationCases(JSON.stringify({ cases: [{ ...bank.cases[0], source: { path: 'missing', quote: 'invented' } }] }), input)).toThrow('source');
  expect(() => parseMigrationCases(JSON.stringify({ cases: [{ ...bank.cases[0], context: '' }] }), input)).toThrow('context');
  expect(() => parseMigrationCases(JSON.stringify({ cases: [{ ...bank.cases[0], tool: 'missing' }] }), input)).toThrow('unavailable');
});

it('can read sources beyond ordinary worker round limits without introducing a request cap', async () => {
  const llm = new FakeLLM();
  llm.script(...Array.from({ length: 35 }, () => toolReply([{ name: 'read_file', args: { path: 'sources/state/STATE.md' } }])),
    ...migrationReplies(input.sources, document));
  const result = await runMigrationWorker(input, services(llm));
  expect(result.reason).toBe('ready'); expect(llm.calls.length).toBeGreaterThan(35);
});

it('requires repairing an unavailable candidate scope before replay or completion', async () => {
  const llm = new FakeLLM();
  const invalid = { ...document, constraints: [{ ...document.constraints[0], scope: { sessions: ['main'], tools: ['missing'] } }] };
  llm.script(write('work/cases.json', JSON.stringify(fixedCases(input.sources))), write('work/STATE.md', renderState(invalid)),
    patch('"missing"', '"chat_send"'), textReply('Ready.'), textReply('Consolidated.'), textReply(checkedSources()));
  const result = await runMigrationWorker(input, services(llm));
  expect(result.document).toEqual(document); expect(JSON.stringify(llm.calls[2].messages)).toContain('matches no tool');
});
