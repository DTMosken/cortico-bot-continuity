import { expect, it } from 'vitest';
import { SessionTracker } from 'cortico/core/sessions.ts';
import { FakeLLM, textReply, toolReply } from '../../Cortico/tests/core/helpers.ts';
import { runMigrationWorker, type MigrationServices } from '../persona/state-migration/worker.ts';
import { checkMigrationSources } from '../persona/state-migration/source-check.ts';
import type { MigrationInput } from '../persona/state-migration/contracts.ts';
import { renderState } from '../persona/state-document.ts';
import { checkedSources, fixedCases, fixtureReview } from './migration-check-fixture.ts';

const rule = 'Omit processing metadata from outgoing text.', onlyInFile = 'Recorded by the operator in note/rule.md.';
const handoff = Array.from({ length: 60000 }, (_, index) => `HANDOFF-BODY-${index} earlier conversation detail.`).join('\n');
const sources = { 'state/STATE.md': 'Current concern.', 'CONSTITUTION.md': 'Preserve commitments.', 'note/rule.md': `${rule} ${onlyInFile}`, 'handoffs/long.md': handoff };
const input = (extra: Partial<MigrationInput> = {}): MigrationInput => ({ spec: { model: 'fixture', thinking: false }, contextTokens: 128000, readChars: 2000, history: [], sources,
  tools: [{ session: 'main', tools: [{ name: 'chat_send', tags: ['speak'], description: 'Send text.', parameters: { type: 'object', properties: { text: { type: 'string' } } } }] }], ...extra });
const document = { text: 'Current concern.', constraints: [{ id: 'style', scope: { sessions: ['main'], tools: ['chat_send'] }, instruction: rule, exceptions: '' }] };
const readTools = ['glob_files', 'grep_files', 'list_files', 'read_file'];
const services = (llm: FakeLLM): MigrationServices => ({ core: { sessions: new SessionTracker('UTC'), internBlobs: () => [] }, llm,
  signal: new AbortController().signal, progress() {}, review: async action => fixtureReview(action) });
const text = (call: FakeLLM['calls'][number]) => JSON.stringify(call.messages);

it('completes a global review of a workspace far beyond the model context and sees only sources it read', async () => {
  expect(handoff.length / 4).toBeGreaterThan(input().contextTokens);
  const llm = new FakeLLM();
  llm.script(toolReply([{ name: 'write_file', args: { path: 'work/STATE.md', content: renderState(document) } }]), textReply('Draft ready.'),
    toolReply([{ name: 'read_file', args: { path: 'sources/note/rule.md' } }]),
    textReply(JSON.stringify({ ready: true, issues: [], ...fixedCases(sources, 'chat_send', 'note/rule.md') })), textReply(checkedSources()));
  const result = await runMigrationWorker(input(), services(llm));
  expect(result).toMatchObject({ document, reason: 'ready' });
  const [first, afterRead] = [llm.calls[2], llm.calls[3]];
  const payload = JSON.parse(first.messages.at(-1)!.content as string);
  expect(payload.mode).toBe('global');
  expect(payload.sources).toEqual({ 'state/STATE.md': sources['state/STATE.md'], 'CONSTITUTION.md': sources['CONSTITUTION.md'] });
  expect(payload.sourceFiles).toContain(`sources/handoffs/long.md (${handoff.length} characters)`);
  expect(first.tools!.map(tool => tool.name).sort()).toEqual(readTools);
  expect(text(first)).not.toContain(onlyInFile); expect(text(afterRead)).toContain(onlyInFile);
  for (const call of llm.calls) expect(text(call)).not.toContain('HANDOFF-BODY-1000 ');
});

it('validates a quote from a source read on demand and still rejects a fabricated quote', async () => {
  const issue = { id: 'scope', kind: 'scope', source: 'note/rule.md', quote: rule, constraintIds: ['style'], detail: 'A writing tool is missing.' };
  const llm = new FakeLLM();
  llm.script(toolReply([{ name: 'read_file', args: { path: 'sources/note/rule.md' } }]),
    textReply(JSON.stringify({ ready: false, issues: [issue, { ...issue, id: 'invented', quote: 'Never share anything.' }] })));
  const check = await checkMigrationSources(input(), llm, new AbortController().signal, document, sources, []);
  expect(check.issues).toEqual([issue]); expect(check.ready).toBe(false);
  expect(check.errors).toEqual([expect.objectContaining({ kind: 'reference', relatedIssueId: 'invented' })]);
  expect(text(llm.calls[0])).not.toContain(onlyInFile); expect(text(llm.calls[1])).toContain(onlyInFile);
});

it('fails before drafting when STATE and CONSTITUTION alone exceed the model context', async () => {
  const llm = new FakeLLM();
  const oversized = { ...sources, 'CONSTITUTION.md': 'Keep every commitment in full. '.repeat(4000) };
  await expect(runMigrationWorker(input({ sources: oversized, contextTokens: 8000 }), services(llm))).rejects.toThrow('超出模型上下文');
  expect(llm.calls).toEqual([]);
});
