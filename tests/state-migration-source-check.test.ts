import { expect, it } from 'vitest';
import { FakeLLM, textReply } from '../../Cortico/tests/core/helpers.ts';
import { checkMigrationSources } from '../persona/state-migration/source-check.ts';
import type { MigrationInput } from '../persona/state-migration/contracts.ts';

const input: MigrationInput = { spec: { model: 'fixture', thinking: false }, contextTokens: 100000, readChars: 100, history: [],
  sources: { 'state/STATE.md': 'Do not alter identifiers.' }, tools: [] };
const document = { text: '', constraints: [{ id: 'ids', instruction: 'Do not alter identifiers.', exceptions: '', scope: { sessions: ['main'], tags: ['speak' as const] } }] };
const issue = { id: 'scope', kind: 'scope', source: 'state/STATE.md', quote: 'Do not alter identifiers.', constraintIds: ['ids'], detail: 'A relevant writing tool is missing.' };

it('retains missed-rule and unrelated-hold evidence while removing repeated allowed judgments', async () => {
  const llm = new FakeLLM(); llm.script(textReply('{"ready":true,"issues":[]}'));
  const allowed = { id: 'ids', instruction: 'Keep identifiers.', choice: 'allow' };
  const held = { id: 'other', instruction: 'Other rule.', choice: 'remind' };
  const rows = [
    { id: 'miss', expected: 'remind', actual: 'allow', judgments: [allowed], result: { duplicate: true } },
    { id: 'hold', expected: 'remind', actual: 'remind', judgments: [allowed, held], result: { duplicate: true } },
    { id: 'safe', expected: 'allow', actual: 'allow', judgments: [allowed], action: { text: 'safe' } },
  ];
  await checkMigrationSources(input, llm, new AbortController().signal, document, input.sources, [], [], rows);
  const payload = JSON.parse(llm.calls[0].messages.at(-1)!.content as string);
  expect(payload).not.toHaveProperty('sourceChanges');
  expect(payload.replays.map((row: { judgments: unknown }) => row.judgments)).toEqual([[allowed], [held], []]);
  expect(payload.replays[0]).not.toHaveProperty('result'); expect(payload.replays[2].action).toEqual({ text: 'safe' });
});

it('keeps valid issues when another issue has a bad reference and returns the specific error', async () => {
  const llm = new FakeLLM(); llm.script(textReply(JSON.stringify({ ready: true, issues: [issue, { ...issue, id: 'bad', quote: 'Invented permission.' }] })));
  const check = await checkMigrationSources(input, llm, new AbortController().signal, document, input.sources, []);
  expect(check.ready).toBe(false); expect(check.issues).toContainEqual(issue);
  expect(check.issues.map(item => item.id)).toEqual(['scope']);
  expect(check.errors?.some(item => item.kind === 'reference' && item.detail.includes('Invented permission.'))).toBe(true);
});

it('retains an unresolved issue unless a focused check explicitly resolves it and includes only changed rule versions', async () => {
  const llm = new FakeLLM(); llm.script(textReply('{"ready":true,"issues":[]}'), textReply('{"ready":true,"issues":[],"resolved":["scope"]}'));
  const previous = { document, check: { ready: false, issues: [issue], resolved: [], caseFindings: [] } };
  const next = { ...document, text: 'Updated ordinary guidance.' };
  const first = await checkMigrationSources(input, llm, new AbortController().signal, next, input.sources, [], [], [], previous);
  expect(first.ready).toBe(false); expect(first.issues).toContainEqual(issue);
  const second = await checkMigrationSources(input, llm, new AbortController().signal, next, input.sources, [], [], [], previous);
  expect(second.ready).toBe(true);
  const payload = JSON.parse(llm.calls.at(-1)!.messages.at(-1)!.content as string);
  expect(payload).toMatchObject({ mode: 'focused', previousIssues: [issue], changes: { constraintIds: [], textChanged: true } });
  expect(payload).not.toHaveProperty('coverage');
});

it('rejects malformed source-check output and invalid blind-spot references', async () => {
  const llm = new FakeLLM(); llm.script(textReply('invalid JSON'), textReply('{"ready":true,"issues":[],"caseFindings":[{"caseId":"x","kind":"model","source":"missing","quote":"x","detail":"blind spot"}]}'));
  await expect(checkMigrationSources(input, llm, new AbortController().signal, document, input.sources, [])).rejects.toThrow();
  const check = await checkMigrationSources(input, llm, new AbortController().signal, document, input.sources, []);
  expect(check.ready).toBe(false); expect(check.caseFindings).toEqual([]);
});

it('sends actual text edits and relevant sources without reopening accepted unchanged rules', async () => {
  const llm = new FakeLLM();
  const sources: Record<string, string> = { ...input.sources, 'other.md': 'Do not reveal protected content.' };
  const before = { ...document, text: 'Unchanged heading.\nOld guidance.\nUnchanged ending.' };
  const next = { ...before, text: 'Unchanged heading.\nNew guidance.\nUnchanged ending.' };
  const unrelated = { ...issue, id: 'unrelated', detail: 'Reconsider the unchanged identifier rule.' };
  const regression = { id: 'regression', kind: 'meaning', source: 'other.md', quote: sources['other.md'],
    change: { text: 'New guidance.' }, detail: 'The replacement removes the stated condition.' };
  llm.script(textReply(JSON.stringify({ ready: false, issues: [unrelated, regression] })));
  const previous = { document: before, check: { ready: true, issues: [], resolved: [], caseFindings: [] } };
  const check = await checkMigrationSources({ ...input, sources }, llm, new AbortController().signal, next, sources, [], [], [], previous);
  expect(check.issues).toEqual([regression]); expect(check.ignoredIssues).toEqual([unrelated]); expect(check.ready).toBe(false);
  const payload = JSON.parse(llm.calls[0].messages.at(-1)!.content as string);
  expect(payload.candidate).toEqual({ text: 'New guidance.', constraints: [] });
  expect(payload.changes.text).toEqual({ before: 'Old guidance.', after: 'New guidance.' });
  expect(payload.sources).not.toHaveProperty('state/STATE.md'); expect(payload).not.toHaveProperty('acceptedRequirements');
});


it('keeps valid cases and source issues when a case has an invalid tool reference', async () => {
  const available = { ...input, tools: [{ session: 'main', tools: [{ name: 'chat_send', tags: ['speak' as const], description: 'Send text.', parameters: { type: 'object' as const, properties: {} } }] }] };
  const good = { id: 'valid', source: { path: 'state/STATE.md', quote: input.sources['state/STATE.md'] }, session: 'main', tool: 'chat_send', args: { text: 'value' }, expected: 'allow', context: 'Valid identifier.' };
  const llm = new FakeLLM(); llm.script(textReply(JSON.stringify({ ready: true, issues: [issue], cases: [good, { ...good, id: 'bad', tool: 'missing' }] })));
  const check = await checkMigrationSources(available, llm, new AbortController().signal, document, input.sources, []);
  expect(check.cases).toEqual([good]); expect(check.issues).toContainEqual(issue);
  expect(check.errors?.some(item => item.kind === 'reference' && item.detail.includes('unavailable'))).toBe(true);
  expect(check.ready).toBe(false);
});

it('retains replay rules and contracts with no candidate edit and accepts replay-backed defects', async () => {
  const available = { ...input, tools: [{ session: 'main', tools: [{ name: 'chat_send', tags: ['speak' as const], description: 'Send text.', parameters: { type: 'object' as const, properties: { text: { type: 'string' } } } }] }] };
  const sample = { id: 'boundary', source: { path: 'state/STATE.md', quote: input.sources['state/STATE.md'] }, session: 'main', tool: 'chat_send', args: { text: 'value' }, expected: 'uncertain' as const, context: 'An ambiguous identifier.' };
  const row = { ...sample, rules: ['ids'], actual: 'allow', mismatch: false, judgments: [] };
  const defect = { ...issue, id: 'replay-scope', caseIds: [sample.id] };
  const llm = new FakeLLM(); llm.script(textReply(JSON.stringify({ ready: false, issues: [defect] })));
  const previous = { document, check: { ready: true, issues: [], resolved: [], caseFindings: [] }, replayed: false };
  const check = await checkMigrationSources(available, llm, new AbortController().signal, document, input.sources, [{ id: 'ids' }], [], [row], previous, [sample]);
  const payload = JSON.parse(llm.calls[0].messages.at(-1)!.content as string);
  expect(payload.candidate.constraints).toEqual(document.constraints);
  expect(payload.tools[0].tools[0]).toMatchObject({ name: 'chat_send', parameters: [{ name: 'text', type: 'string' }] });
  expect(payload.effectiveScope).toEqual([{ id: 'ids' }]);
  expect(check.issues).toEqual([defect]); expect(check.ready).toBe(false);
});

it('keeps the tested tool and case-backed omission when no rule applies', async () => {
  const available = { ...input, tools: [{ session: 'dream', tools: [{ name: 'note_write', tags: ['write' as const], description: 'Write a note.', parameters: { type: 'object' as const, properties: { content: { type: 'string' } } } }] }] };
  const sample = { id: 'missing-scope', source: { path: 'state/STATE.md', quote: input.sources['state/STATE.md'] }, session: 'dream', tool: 'note_write', args: {}, expected: 'remind' as const, context: 'An identifier is altered.' };
  const defect = { ...issue, caseIds: [sample.id], constraintIds: [] };
  const llm = new FakeLLM(); llm.script(textReply(JSON.stringify({ ready: false, issues: [defect] })));
  const previous = { document, check: { ready: true, issues: [], resolved: [], caseFindings: [] }, replayed: false };
  const check = await checkMigrationSources(available, llm, new AbortController().signal, document, input.sources, [], [], [{ ...sample, rules: [], mismatch: true }], previous, [sample]);
  const payload = JSON.parse(llm.calls[0].messages.at(-1)!.content as string);
  expect(payload.tools[0].tools[0].name).toBe('note_write');
  expect(check.issues).toEqual([defect]); expect(check.ready).toBe(false);
});

it('repairs invalid response data with source and tool context without preserving stale host errors', async () => {
  const llm = new FakeLLM();
  llm.script(textReply(JSON.stringify({ ready: true, issues: [{ ...issue, id: 'bad', quote: 'Not in the source.' }], cases: 'invalid' })), textReply('{"ready":true,"issues":[],"cases":[]}'));
  const first = await checkMigrationSources(input, llm, new AbortController().signal, document, input.sources, []);
  expect(first.issues).toEqual([]); expect(first.errors).toHaveLength(2);
  const second = await checkMigrationSources(input, llm, new AbortController().signal, document, input.sources, [], [], [], { document, check: first });
  const payload = JSON.parse(llm.calls[1].messages.at(-1)!.content as string);
  expect(payload.sources).toEqual(input.sources); expect(payload.candidate).toEqual(document); expect(payload.errors).toEqual(first.errors);
  expect(second.errors).toEqual([]); expect(second.ready).toBe(true);
});

it('accepts a corrected issue reference without letting the invalid opinion reach the actor', async () => {
  const llm = new FakeLLM();
  llm.script(textReply(JSON.stringify({ ready: false, issues: [{ ...issue, quote: 'Bad quote.' }] })), textReply(JSON.stringify({ ready: false, issues: [issue] })));
  const first = await checkMigrationSources(input, llm, new AbortController().signal, document, input.sources, []);
  expect(first.issues).toEqual([]);
  const second = await checkMigrationSources(input, llm, new AbortController().signal, document, input.sources, [], [], [], { document, check: first });
  expect(second.issues).toEqual([issue]); expect(second.errors).toEqual([]); expect(second.ready).toBe(false);
});
