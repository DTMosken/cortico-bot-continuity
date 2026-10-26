import { expect, it } from 'vitest';
import { SessionTracker } from 'cortico/core/sessions.ts';
import { FakeLLM, textReply, toolReply } from '../../Cortico/tests/core/helpers.ts';
import { runMigrationWorker, type MigrationServices } from '../persona/state-migration/worker.ts';
import { generateMigrationCases, parseMigrationCases, replayMigrationCase } from '../persona/state-migration/fixtures.ts';
import type { MigrationInput } from '../persona/state-migration/contracts.ts';
import { renderState } from '../persona/state-document.ts';
import { fixedCases, fixtureReview, checkedSources, migrationReplies } from './migration-check-fixture.ts';

const input: MigrationInput = { spec: { model: 'fixture', thinking: false }, contextTokens: 100000, readChars: 100000,
  sources: { 'state/STATE.md': 'Do not emit processing metadata.' }, history: [{ id: 'run/old', text: 'Earlier source feedback.' }],
  tools: [{ session: 'main', tools: [{ name: 'chat_send', description: 'Publish a message.', parameters: { type: 'object', properties: { text: { type: 'string' } } }, tags: ['speak'] }] }] };
const document = { text: 'Ordinary guidance.', constraints: [{ id: 'style', instruction: input.sources['state/STATE.md'], exceptions: '', scope: { sessions: ['main'], tools: ['chat_send'] } }] };
const write = (path: string, content: string) => toolReply([{ name: 'write_file', args: { path, content } }]);
const patch = (old_string: string, new_string: string) => toolReply([{ name: 'edit_file', args: { path: 'work/STATE.md', old_string, new_string } }]);
const casesReply = () => textReply(JSON.stringify(fixedCases(input.sources)));
function services(llm: FakeLLM, review: MigrationServices['review'] = async action => fixtureReview(action)): MigrationServices {
  return { core: { sessions: new SessionTracker('UTC'), internBlobs: () => [] }, llm, signal: new AbortController().signal, review, progress() {} };
}

it('starts the candidate with the original STATE and waits for a valid edit before creating cases', async () => {
  const llm = new FakeLLM();
  llm.script(toolReply([{ name: 'read_file', args: { path: 'work/STATE.md' } }]), ...migrationReplies(input.sources, document));
  await runMigrationWorker(input, services(llm));
  expect(JSON.stringify(llm.calls[1].messages)).toContain(input.sources['state/STATE.md']);
  expect(JSON.stringify(llm.calls[1].messages)).not.toContain('Candidate needs a valid');
});

it('builds independent scenario batches focused on each source group', async () => {
  const sources = { ...input.sources, 'CONSTITUTION.md': 'Respect standing commitments.' };
  const llm = new FakeLLM();
  llm.script(textReply(JSON.stringify(fixedCases(sources))), textReply(JSON.stringify(fixedCases(sources, 'chat_send', 'CONSTITUTION.md'))));
  const cases = await generateMigrationCases({ ...input, sources }, llm, new AbortController().signal);
  expect(cases.map(item => item.id)).toEqual(['0:ordinary', '0:metadata', '1:ordinary', '1:metadata']);
  const requests = llm.calls.map(call => JSON.parse(call.messages.at(-1)!.content as string));
  expect(requests.map(request => request.focusSources)).toEqual([['state/STATE.md'], ['CONSTITUTION.md']]);
  expect(requests.every(request => JSON.stringify(request.sources) === JSON.stringify(sources) && !('candidate' in request))).toBe(true);
});

it('drafts immediately and keeps independently generated scenarios hidden from candidate-dependent context', async () => {
  const llm = new FakeLLM(), seen: unknown[] = [];
  const wrong = { ...document, text: 'Unique candidate marker.', constraints: [{ ...document.constraints[0], instruction: 'Everything is allowed.' }] };
  llm.script(toolReply([{ name: 'write_file', args: { path: 'sources/state/STATE.md', content: 'changed source' } },
    { name: 'write_file', args: { path: 'work/STATE.md', content: renderState(wrong) } }]), casesReply(),
    toolReply([{ name: 'write_file', args: { path: 'reference/cases.json', content: '{"cases":[]}' } },
      { name: 'edit_file', args: { path: 'work/STATE.md', old_string: 'Everything is allowed.', new_string: document.constraints[0].instruction } }]),
    textReply('Ready.'), textReply('Consolidated.'), textReply(checkedSources()));
  const result = await runMigrationWorker(input, services(llm, async (action, rules) => {
    seen.push(action); return rules[0].instruction === wrong.constraints[0].instruction ? { kind: 'reviewed', choices: { style: 'allow' } } : fixtureReview(action);
  }));
  expect(result.document.constraints).toEqual(document.constraints); expect(seen).toHaveLength(4);
  expect(JSON.stringify(seen.slice(0, 2))).toBe(JSON.stringify(seen.slice(2)));
  const request = JSON.parse(llm.calls[1].messages.at(-1)!.content as string);
  expect(request.sources).toEqual(input.sources); expect(request.tools).toEqual(input.tools);
  expect(request).not.toHaveProperty('candidate'); expect(JSON.stringify(llm.calls[1].messages)).not.toContain('Unique candidate marker.');
  expect(JSON.stringify(llm.calls[2].messages)).toContain('read-only'); expect(JSON.stringify(llm.calls[3].messages)).toContain('read-only');
  expect(llm.calls.filter(call => call.tools?.some(tool => tool.name.startsWith('migration_')))).toEqual([]);
});

it('checks the candidate once and then only actual repairs without regenerating scenarios', async () => {
  const llm = new FakeLLM();
  const issue = { id: 'ordinary', kind: 'coverage', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'Keep the ordinary reference.' };
  llm.script(write('work/STATE.md', renderState(document)), casesReply(), textReply('Ready.'), textReply('Consolidated.'),
    textReply(JSON.stringify({ ready: false, issues: [issue] })), patch('Ordinary guidance.', 'Ordinary guidance. Reference retained.'),
    textReply('Repaired.'), textReply(JSON.stringify({ ready: true, issues: [], resolved: ['ordinary'] })));
  const result = await runMigrationWorker(input, services(llm));
  expect(result.document.text).toContain('Reference retained.');
  const audits = llm.calls.filter(call => !call.tools?.length).map(call => JSON.parse(call.messages.at(-1)!.content as string)).filter(value => value.mode);
  expect(audits.map(value => value.mode)).toEqual(['global', 'focused']); expect(audits[1].previousIssues).toEqual([issue]);
  expect(audits[1].changes.text).toEqual({ before: 'Ordinary guidance.', after: 'Ordinary guidance. Reference retained.' });
});

it('requires source-grounded disposition for a remaining model miss before diminishing-returns completion', async () => {
  const llm = new FakeLLM();
  llm.script(write('work/STATE.md', renderState(document)), casesReply(), textReply('Ready.'), textReply('Consolidated.'), textReply(checkedSources()),
    textReply('The source prohibition is preserved.'), textReply(JSON.stringify({ ready: true, issues: [], resolved: ['case-metadata'],
      caseFindings: [{ caseId: 'metadata', kind: 'model', source: 'state/STATE.md', quote: input.sources['state/STATE.md'], detail: 'The decision model missed the visible restricted content.' }] })));
  const result = await runMigrationWorker(input, services(llm, async () => ({ kind: 'reviewed', choices: { style: 'allow' } })));
  expect(result.reason).toBe('diminishing_returns'); expect(JSON.stringify(llm.calls[5].messages)).toContain('case-metadata');
});

it('sends necessary synthetic premises and individual judgments without executing World handlers', async () => {
  const sample = parseMigrationCases(JSON.stringify(fixedCases(input.sources)), input)[1];
  sample.context = 'The prior transaction is still pending; the fixture supplies this necessary fact.';
  const result = await replayMigrationCase(input, sample, document, services(new FakeLLM(), async action => ({ kind: 'reviewed', choices: {
    style: (action as { scenario: { text: string } }).scenario.text.includes('still pending') ? 'remind' : 'allow',
  } })));
  expect(result.actual).toBe('remind'); expect(result.mismatch).toBe(false);
  expect(result.judgments).toEqual([{ ...document.constraints[0], scope: undefined, choice: 'remind' }]);
});

it('does not dispatch another actor request after cancellation during automatic replay', async () => {
  const llm = new FakeLLM(), controller = new AbortController();
  llm.script(write('work/STATE.md', renderState(document)), casesReply(), textReply('Should not run.'));
  const deps = services(llm, async action => { controller.abort(); return fixtureReview(action); }); deps.signal = controller.signal;
  await expect(runMigrationWorker(input, deps)).rejects.toThrow(); expect(llm.calls).toHaveLength(2);
});

it('returns scenario source and tool errors together rather than repairing one entry per request', () => {
  const bank = fixedCases(input.sources);
  const broken = { cases: [{ ...bank.cases[0], source: { path: 'missing', quote: 'invented' } }, { ...bank.cases[1], tool: 'missing' }] };
  expect(() => parseMigrationCases(JSON.stringify(broken), input)).toThrow(/source reference[\s\S]*unavailable/);
});

it('repairs malformed independent scenarios using original sources without exposing candidate text', async () => {
  const llm = new FakeLLM(), broken = fixedCases(input.sources); broken.cases[0].tool = 'missing';
  llm.script(write('work/STATE.md', renderState({ ...document, text: 'Secret draft marker.' })), textReply(JSON.stringify(broken)), casesReply(),
    textReply('Ready.'), textReply('Consolidated.'), textReply(checkedSources()));
  await runMigrationWorker(input, services(llm));
  const request = JSON.parse(llm.calls[2].messages.at(-1)!.content as string);
  expect(request.repair.error).toContain('unavailable'); expect(JSON.stringify(llm.calls[2].messages)).not.toContain('Secret draft marker.');
});

it('can read sources beyond ordinary worker round limits without introducing a request cap', async () => {
  const llm = new FakeLLM();
  llm.script(...Array.from({ length: 35 }, () => toolReply([{ name: 'read_file', args: { path: 'sources/state/STATE.md' } }])), ...migrationReplies(input.sources, document));
  expect((await runMigrationWorker(input, services(llm))).reason).toBe('ready'); expect(llm.calls.length).toBeGreaterThan(35);
});

it('requires repairing an unavailable candidate scope before scenarios or replay', async () => {
  const llm = new FakeLLM(), invalid = { ...document, constraints: [{ ...document.constraints[0], scope: { sessions: ['main'], tools: ['missing'] } }] };
  llm.script(write('work/STATE.md', renderState(invalid)), patch('"missing"', '"chat_send"'), casesReply(), textReply('Ready.'), textReply('Consolidated.'), textReply(checkedSources()));
  expect((await runMigrationWorker(input, services(llm))).document).toEqual(document); expect(JSON.stringify(llm.calls[1].messages)).toContain('matches no tool');
});

it('reuses decision results after body-only repairs', async () => {
  const llm = new FakeLLM(); let reviews = 0;
  llm.script(write('work/STATE.md', renderState(document)), casesReply(), patch('Ordinary guidance.', 'Ordinary guidance. Added reference.'),
    textReply('Ready.'), textReply('Consolidated.'), textReply(checkedSources()));
  const result = await runMigrationWorker(input, services(llm, async action => { reviews++; return fixtureReview(action); }));
  expect(result.document.text).toContain('Added reference.'); expect(reviews).toBe(2);
});

it('replays only scenarios whose applicable rules changed', async () => {
  const llm = new FakeLLM(), counts: Record<string, number> = {};
  const expanded: MigrationInput = { ...input, tools: [{ session: 'main', tools: [...input.tools[0].tools,
    { ...input.tools[0].tools[0], name: 'record_put', tags: ['write'] }] }] };
  const draft = { ...document, constraints: [...document.constraints,
    { ...document.constraints[0], id: 'record', instruction: 'Record rule.', scope: { sessions: ['main'], tools: ['record_put'] } }] };
  const bank = { cases: [...fixedCases(input.sources).cases,
    ...fixedCases(input.sources, 'record_put').cases.map(sample => ({ ...sample, id: 'record-' + sample.id }))] };
  llm.script(write('work/STATE.md', renderState(draft)), textReply(JSON.stringify(bank)), patch('Record rule.', 'Record rule tightened.'),
    textReply('Ready.'), textReply('Consolidated.'), textReply(checkedSources()));
  await runMigrationWorker(expanded, services(llm, async (action, rules) => {
    const value = action as { tool: string; args: { text: string } }; counts[value.tool] = (counts[value.tool] ?? 0) + 1;
    return { kind: 'reviewed', choices: Object.fromEntries(rules.map(rule => [rule.id, value.args.text.includes('processing metadata') ? 'remind' : 'allow'])) };
  }));
  expect(counts).toEqual({ chat_send: 2, record_put: 4 });
});

it('rejects an accidental hold by an unrelated rule even when the aggregate label matches', async () => {
  const llm = new FakeLLM(), wrong = { ...document, constraints: [{ ...document.constraints[0], instruction: 'Everything is allowed.' },
    { ...document.constraints[0], id: 'other', instruction: 'A separate source restriction.' }] };
  llm.script(write('work/STATE.md', renderState(wrong)), casesReply(), textReply('Ready.'), textReply('Consolidated.'),
    textReply(JSON.stringify({ ready: true, issues: [], caseFindings: [{ caseId: 'metadata', kind: 'unrelated', source: 'state/STATE.md',
      quote: input.sources['state/STATE.md'], detail: 'The intended rule allows the restricted content; the unrelated rule returned insufficient.' }] })),
    patch('Everything is allowed.', document.constraints[0].instruction), textReply('Repaired.'), textReply(JSON.stringify({ ready: true, issues: [], resolved: ['case-metadata'] })));
  const result = await runMigrationWorker(input, services(llm, async (action, rules) => {
    const bad = rules[0].instruction === 'Everything is allowed.', restricted = JSON.stringify(action).includes('processing metadata');
    return { kind: 'reviewed', choices: { style: restricted && !bad ? 'remind' : 'allow', other: restricted && bad ? 'insufficient' : 'allow' } };
  }));
  expect(result.document.constraints[0].instruction).toBe(document.constraints[0].instruction);
  expect(JSON.stringify(llm.calls[5].messages)).toContain('unrelated rule');
});
