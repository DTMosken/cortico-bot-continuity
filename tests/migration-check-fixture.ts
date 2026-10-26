/** Scripted fixtures keep migration tests on real file tools and frozen source-based cases. */
import { toolReply, textReply } from '../../Cortico/tests/core/helpers.ts';
import { renderState, type StateDocument } from '../persona/state-document.ts';
export const checkedSources = (_sources?: Record<string, string>, _ids?: string[]) => JSON.stringify({ ready: true, issues: [], resolved: [], caseFindings: [] });
export function fixedCases(sources: Record<string, string>, tool = 'chat_send') {
  const source = { path: 'state/STATE.md', quote: sources['state/STATE.md'] };
  return { cases: [
    { id: 'ordinary', source, session: 'main', tool, args: { text: 'Hello.' }, expected: 'allow', context: 'Ordinary outgoing text with no processing marker.' },
    { id: 'metadata', source, session: 'main', tool, args: { text: 'processing metadata' }, expected: 'remind', context: 'The submitted text contains an irrelevant processing marker.' },
  ] };
}
export function migrationSteps(sources: Record<string, string>, document: StateDocument, tool = 'chat_send') {
  return [
    { name: 'write_file', args: { path: 'work/STATE.md', content: renderState(document) } },
    { text: JSON.stringify(fixedCases(sources, tool)) },
    { text: 'Ready for final consolidation.' }, { text: 'No redundant rules remain.' }, { text: checkedSources() },
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
