/** Frozen source-derived scenarios are replayed without executing World actions. */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitWorkspaceMemory } from '../../base/persona/memory.ts';
import { appliesTo, type StateDocument } from '../state-document.ts';
import { prepareStateAction, bypassesStateReview } from '../state-review.ts';
import type { MigrationInput } from './contracts.ts';
import type { MigrationServices } from './worker.ts';

export interface MigrationCase {
  id: string; source: { path: string; quote: string }; session: string; tool: string; args: Record<string, unknown>;
  expected: 'allow' | 'remind' | 'uncertain'; context: string; history?: unknown[]; dialogue?: unknown[];
  files?: Record<string, string>; draft?: Record<string, unknown>; read?: Record<string, unknown>;
}
export interface MigrationReplay {
  id: string; source: MigrationCase['source']; expected: MigrationCase['expected']; action: unknown; context: string;
  rules: string[]; judgments: Array<{ id: string; instruction: string; exceptions: string; choice: string }>;
  result: unknown; actual: 'allow' | 'remind'; mismatch: boolean;
}
export function parseMigrationCases(raw: string, input: MigrationInput, requireBoth = true): MigrationCase[] {
  const value = JSON.parse(raw) as { cases: MigrationCase[] };
  if (!value || !Array.isArray(value.cases)) throw new Error('cases.json requires a cases array.');
  const ids = new Set<string>(), errors: string[] = [];
  for (const [index, item] of value.cases.entries()) {
    try {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) throw new Error(`Case ${index} needs a unique ID.`);
    ids.add(item.id);
    if (!item.source || typeof item.source.path !== 'string' || typeof item.source.quote !== 'string' || !item.source.quote.trim()
      || !input.sources[item.source.path]?.includes(item.source.quote)) throw new Error(`Case ${item.id} needs a verbatim source reference.`);
    const tool = input.tools.find(group => group.session === item.session)?.tools.find(tool => tool.name === item.tool);
    if (!tool || tool.tags.includes('flow')) throw new Error(`Case ${item.id} has an unavailable review tool/session.`);
    if (!item.args || typeof item.args !== 'object' || Array.isArray(item.args) || !['allow', 'remind', 'uncertain'].includes(item.expected)
      || typeof item.context !== 'string' || !item.context.trim()) throw new Error(`Case ${item.id} needs arguments, expected judgment and complete scenario context.`);
    if (item.history !== undefined && !Array.isArray(item.history) || item.dialogue !== undefined && !Array.isArray(item.dialogue)) throw new Error(`Case ${item.id} history/dialogue must be arrays.`);
    if (item.files !== undefined && (!item.files || typeof item.files !== 'object' || Array.isArray(item.files) || Object.values(item.files).some(text => typeof text !== 'string'))) throw new Error(`Case ${item.id} files must contain text.`);
    for (const key of ['draft', 'read'] as const) if (item[key] !== undefined && (!item[key] || typeof item[key] !== 'object' || Array.isArray(item[key]))) throw new Error(`Case ${item.id} ${key} must be an object.`);
    } catch (error) { errors.push(String(error)); }
  }
  if (requireBoth && value.cases.length && (!value.cases.some(item => item?.expected === 'allow') || !value.cases.some(item => item?.expected === 'remind')))
    errors.push('Prepare both legitimate should-allow and deliberate should-remind scenarios.');
  if (errors.length) throw new Error(errors.join('\n'));
  return structuredClone(value.cases);
}
export async function replayMigrationCase(input: MigrationInput, sample: MigrationCase, document: StateDocument, services: MigrationServices): Promise<MigrationReplay> {
  const spec = input.tools.find(group => group.session === sample.session)!.tools.find(tool => tool.name === sample.tool)!;
  const dir = mkdtempSync(join(tmpdir(), 'continuity-migration-case-'));
  try {
    const memory = new GitWorkspaceMemory({ memoryDir: dir });
    for (const [path, text] of Object.entries(sample.files ?? {})) memory.writeFileAtomic(path, text);
    const prepared = prepareStateAction({ memory, core: () => null, readOverride: () => null,
      speechContext: () => ({ recentDialogue: sample.dialogue ?? [] }), wholeReadFallbackChars: () => input.readChars }, spec, sample.args, sample.session,
      spec.name !== 'read_file' && sample.read ? () => ({ read: sample.read!, revision: 'fixture' }) : undefined,
      sample.draft ? { args: sample.draft, revision: 'fixture' } : null);
    const rules = document.constraints.filter(rule => !bypassesStateReview(spec, sample.args) && appliesTo(rule, sample.session, spec));
    const action = { ...prepared.action, scenario: { kind: 'isolated-test-premise', text: sample.context } };
    const result = rules.length ? await services.review(action, rules, [...prepared.history, ...(sample.history ?? [])]) : { kind: 'not-reviewed' };
    if (services.signal.aborted) throw new Error('Migration stopped');
    if (rules.length && (!result || typeof result !== 'object' || !('kind' in result) || result.kind !== 'reviewed' || !('choices' in result))) throw new Error('Decision replay did not return a valid reviewed result.');
    const staged = rules.length > 0 && Object.values((result as { choices: Record<string, string> }).choices).some(choice => choice !== 'allow');
    const actual = staged ? 'remind' : 'allow';
    return { id: sample.id, source: sample.source, expected: sample.expected, action, context: sample.context,
      rules: rules.map(rule => rule.id), judgments: rules.map(rule => ({ id: rule.id, instruction: rule.instruction, exceptions: rule.exceptions,
        choice: (result as { choices: Record<string, string> }).choices[rule.id] })), result, actual, mismatch: sample.expected !== 'uncertain' && actual !== sample.expected };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
