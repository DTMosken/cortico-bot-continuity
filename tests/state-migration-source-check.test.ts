import { expect, it } from 'vitest';
import { FakeLLM, textReply } from '../../Cortico/tests/core/helpers.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { checkMigrationSources } from '../persona/state-migration/source-check.ts';
import { migrationWorkerTools } from '../persona/state-migration/worker.ts';
import type { MigrationInput } from '../persona/state-migration/contracts.ts';
import { checkedSources } from './migration-check-fixture.ts';

const input: MigrationInput = { spec: { model: 'fixture', thinking: false }, contextTokens: 100000, readChars: 100,
  history: [], sources: { 'state/STATE.md': 'Keep identifiers and repair existing citations.' },
  tools: [{ session: 'main', tools: [{ name: 'send_text', description: 'Publish text', parameters: {}, tags: ['speak'] }] }] };
const document = { text: 'Ordinary preference.', constraints: [{ id: 'citation', scope: { sessions: ['main'], tools: ['send_text'] }, instruction: 'Keep identifiers.', exceptions: '' }] };
const valid = { source: 'state/STATE.md', quote: input.sources['state/STATE.md'], constraintIds: ['citation'] };
const issue = { kind: 'coverage', source: 'state/STATE.md', constraintIds: ['citation'], detail: 'Repairing existing citations is an independent duty; restore it.' };

it.each([
  ['quote', { ...valid, quote: 'Keep every identifier.' }],
  ['source', { ...valid, source: 'missing.md' }],
  ['constraintIds', { ...valid, constraintIds: ['unknown'] }],
  ['text', { ...valid, text: 'An invented ordinary-text excerpt.', reason: 'Preference.' }],
  ['reason', { ...valid, text: document.text }],
] as const)('retains actionable feedback and valid coverage when coverage %s is invalid', async (field, invalid) => {
  const llm = new FakeLLM(); llm.script(textReply(JSON.stringify({ ready: true, coverage: [valid, invalid], issues: [issue] })));
  const check = await checkMigrationSources(input, llm, new AbortController().signal, document, input.sources, [], []);
  expect(check.ready).toBe(false);
  expect(check.coverage).toEqual([valid]);
  expect(check.issues).toContainEqual(issue);
  expect(check.issues.some(value => value.kind === 'coverage' && value.detail.includes(`coverage[1].${field}`))).toBe(true);
});

it('keeps migration feedback usable while blocking finish until a fresh valid check and replay', async () => {
  const llm = new FakeLLM(); llm.script(
    textReply(JSON.stringify({ ready: true, coverage: [{ ...valid, quote: 'A paraphrase of the source.' }], issues: [issue] })),
    textReply(checkedSources(input.sources, ['citation'])),
  );
  const worker = migrationWorkerTools(input, { llm, signal: new AbortController().signal,
    review: async () => ({ kind: 'reviewed', choices: { citation: 'allow' } }) });
  const call = (name: string, args: Record<string, unknown>) => worker.tools.find(tool => tool.name === name)!.handler(args, { role: 'dream', log: nullLogger() });
  await call('migration_draft', document);
  await call('migration_review', { session: 'main', tool: 'send_text', args: {}, expected: 'allow', evidence: 'Valid text.' });
  const receipt = JSON.parse(String(await call('migration_check', {})));
  expect(receipt).toMatchObject({ ready: false, coverage: { items: 0 } });
  expect(receipt.issues).toContainEqual(issue);
  expect(receipt.issues.some((value: { detail: string }) => value.detail.includes('coverage[0].quote'))).toBe(true);
  for (const reason of ['ready', 'diminishing_returns']) await expect(call('migration_finish', { reason, explanation: 'done' })).rejects.toThrow();
  expect(worker.candidate()).toBeUndefined();
  await call('migration_draft', { ...document, constraints: [{ ...document.constraints[0], instruction: 'Keep identifiers and repair existing citations.' }] });
  await call('migration_check', {});
  await expect(call('migration_finish', { reason: 'ready', explanation: 'done' })).rejects.toThrow();
  await call('migration_review', { session: 'main', tool: 'send_text', args: {}, expected: 'allow', evidence: 'Valid text.' });
  await call('migration_finish', { reason: 'ready', explanation: 'Source and replay checked.' });
  expect(worker.candidate()).toBeDefined();
});
