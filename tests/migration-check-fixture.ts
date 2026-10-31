/** Scripted fixtures keep migration tests on real file tools and frozen source-based cases. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { toolReply, textReply } from '../../Cortico/tests/core/helpers.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { renderState, type StateDocument } from '../persona/state-document.ts';
import { migrationFileTools, writeMigrationSources, type SourceReader } from '../persona/state-migration/files.ts';
import { checkMigrationSources } from '../persona/state-migration/source-check.ts';
import type { MigrationReplay } from '../persona/state-migration/fixtures.ts';
export const checkedSources = (_sources?: Record<string, string>, _ids?: string[]) => JSON.stringify({ ready: true, issues: [], resolved: [], caseFindings: [] });
export function fixedCases(sources: Record<string, string>, tool = 'chat_send', path = 'state/STATE.md') {
  const source = { path, quote: sources[path] };
  return { cases: [
    { id: 'ordinary', source, session: 'main', tool, args: { text: 'Hello.' }, expected: 'allow', context: 'Ordinary outgoing text with no processing marker.' },
    { id: 'metadata', source, session: 'main', tool, args: { text: 'processing metadata' }, expected: 'remind', context: 'The submitted text contains an irrelevant processing marker.' },
  ] };
}
export function migrationSteps(sources: Record<string, string>, document: StateDocument, tool = 'chat_send') {
  return [
    { name: 'write_file', args: { path: 'work/STATE.md', content: renderState(document) } },
    { text: 'Draft ready.' },
    { text: JSON.stringify({ ready: true, issues: [], ...fixedCases(sources, tool) }) },
    { text: checkedSources() },
  ];
}
export function migrationReplies(sources: Record<string, string>, document: StateDocument, tool = 'chat_send') {
  return migrationSteps(sources, document, tool).map(item => 'name' in item ? toolReply([{ name: item.name!, args: item.args! }]) : textReply(item.text!));
}
export function fixtureReview(action: unknown) {
  const text = (action as { args?: { text?: string } }).args?.text ?? '';
  return { kind: 'reviewed', choices: { style: text.includes('processing metadata') ? 'remind' : 'allow' } };
}
export const fixtureSystemOne = async (state: unknown) => ({ answers: { rule0: { choice: JSON.parse(String(state)).action.args?.text?.includes('processing metadata') ? 'remind' : 'allow' } } });

/** A read-only copy of the sources, as the drafting workspace provides; removed when the test finishes. */
export function sourceReader(sources: Record<string, string>, readChars: number): SourceReader {
  const dir = mkdtempSync(join(tmpdir(), 'continuity-review-test-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const memory = new GitWorkspaceMemory({ memoryDir: dir });
  writeMigrationSources(memory, sources);
  return { core: { sessions: { open: () => ({ id: 'state-migration-source-check', recordAttempts: () => {}, close: () => {} }) },
    internBlobs: () => { throw new Error('Migration tools cannot produce binary attachments'); } }, tools: migrationFileTools(memory, readChars) };
}
/** Standalone checks get the reader that the migration worker would pass. */
export const checkWithReader: typeof checkMigrationSources = (input, llm, signal, document, scope, replays, previous, cases, correction, reader) =>
  checkMigrationSources(input, llm, signal, document, scope, replays, previous, cases, correction, reader ?? sourceReader(input.sources, input.readChars));
/** A replay row with neutral values for the fields a test does not exercise. */
export const replayRow = (row: Partial<MigrationReplay> & Pick<MigrationReplay, 'id'>): MigrationReplay => ({
  source: { path: 'state/STATE.md', quote: '' }, expected: 'allow', action: null, context: '', rules: [], judgments: [], result: null,
  actual: 'allow', mismatch: false, ...row });
