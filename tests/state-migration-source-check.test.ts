import { expect, it } from 'vitest';
import { FakeLLM, textReply } from '../../Cortico/tests/core/helpers.ts';
import { checkMigrationSources } from '../persona/state-migration/source-check.ts';
import type { MigrationInput } from '../persona/state-migration/contracts.ts';

const input: MigrationInput = { spec: { model: 'fixture', thinking: false }, contextTokens: 100000, readChars: 100, history: [],
  sources: { 'state/STATE.md': 'Do not alter identifiers.' }, tools: [] };
const document = { text: '', constraints: [{ id: 'ids', instruction: 'Do not alter identifiers.', exceptions: '', scope: { sessions: ['main'], tags: ['speak' as const] } }] };
const issue = { id: 'scope', kind: 'scope', source: 'state/STATE.md', quote: 'Do not alter identifiers.', constraintIds: ['ids'], detail: 'A relevant writing tool is missing.' };

it('keeps valid issues when another issue has a bad reference and returns the specific error', async () => {
  const llm = new FakeLLM(); llm.script(textReply(JSON.stringify({ ready: true, issues: [issue, { ...issue, id: 'bad', quote: 'Invented permission.' }] })));
  const check = await checkMigrationSources(input, llm, new AbortController().signal, document, input.sources, []);
  expect(check.ready).toBe(false); expect(check.issues).toContainEqual(issue);
  expect(check.issues.some(item => item.kind === 'reference' && item.detail.includes('Invented permission.'))).toBe(true);
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
  const requirements = [
    { id: 'identifiers', source: { path: 'state/STATE.md', quote: sources['state/STATE.md'] }, summary: 'Keep identifiers.', destination: 'constraint' as const, constraintIds: ['ids'] },
    { id: 'guidance', source: { path: 'other.md', quote: sources['other.md'] }, summary: 'Retain ordinary guidance.', destination: 'text' as const, constraintIds: [] },
  ];
  const before = { ...document, text: 'Unchanged heading.\nOld guidance.\nUnchanged ending.' };
  const next = { ...before, text: 'Unchanged heading.\nNew guidance.\nUnchanged ending.' };
  const unrelated = { ...issue, id: 'unrelated', detail: 'Reconsider the unchanged identifier rule.' };
  const regression = { id: 'regression', kind: 'meaning', source: 'other.md', quote: sources['other.md'], requirementIds: ['guidance'],
    change: { text: 'New guidance.' }, detail: 'The replacement removes the stated condition.' };
  llm.script(textReply(JSON.stringify({ ready: false, issues: [unrelated, regression] })));
  const previous = { document: before, check: { ready: true, issues: [], resolved: [], caseFindings: [], checkedRequirements: ['identifiers', 'guidance'] } };
  const check = await checkMigrationSources({ ...input, sources }, llm, new AbortController().signal, next, sources, [], [], [], previous, requirements);
  expect(check.issues).toEqual([regression]); expect(check.ignoredIssues).toEqual([unrelated]); expect(check.ready).toBe(false);
  const payload = JSON.parse(llm.calls[0].messages.at(-1)!.content as string);
  expect(payload.candidate).toEqual({ text: 'New guidance.', constraints: [] });
  expect(payload.changes.text).toEqual({ before: 'Old guidance.', after: 'New guidance.' });
  expect(payload.sources).not.toHaveProperty('state/STATE.md'); expect(payload.acceptedRequirements).toContain('identifiers');
});
