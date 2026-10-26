/** Source destinations and case coverage are approved before candidate drafting. */
import type { ResponseClient } from 'cortico/core/generation.ts';
import type { MigrationInput } from './contracts.ts';
import { parseMigrationCases, type MigrationCase } from './fixtures.ts';
import { requestSourceCheck, type SourceCheck } from './source-check.ts';

export interface SourceRequirement {
  id: string; source: { path: string; quote: string }; summary: string;
  destination: 'text' | 'reference' | 'constraint'; constraintIds: string[];
}
export interface MigrationPreparation { requirements: SourceRequirement[]; cases: MigrationCase[] }
export function parseMigrationPreparation(raw: string, input: MigrationInput): MigrationPreparation {
  const value = JSON.parse(raw) as MigrationPreparation;
  const cases = parseMigrationCases(raw, input), ids = new Set<string>();
  if (!Array.isArray(value.requirements)) throw new Error('cases.json requires a requirements array with source destinations.');
  for (const item of value.requirements) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) throw new Error('Requirements need unique IDs.');
    ids.add(item.id);
    if (!item.source || typeof item.source.path !== 'string' || typeof item.source.quote !== 'string' || !item.source.quote.trim()
      || !input.sources[item.source.path]?.includes(item.source.quote)) throw new Error(`Requirement ${item.id} needs a verbatim source reference.`);
    if (!['text', 'reference', 'constraint'].includes(item.destination) || typeof item.summary !== 'string' || !item.summary.trim()
      || !Array.isArray(item.constraintIds) || item.constraintIds.some(id => typeof id !== 'string' || !id.trim())
      || (item.destination === 'constraint') !== (item.constraintIds.length > 0)) throw new Error(`Requirement ${item.id} needs a destination and planned constraint IDs only for reviewable content.`);
    if (item.destination === 'constraint') for (const expected of ['allow', 'remind'])
      if (!cases.some(sample => sample.requirements?.includes(item.id) && sample.expected === expected)) throw new Error(`Requirement ${item.id} needs both should-allow and should-remind coverage; cases may cover several requirements.`);
  }
  for (const sample of cases) if (!Array.isArray(sample.requirements) || !sample.requirements.length || sample.requirements.some(id => !ids.has(id)))
    throw new Error(`Case ${sample.id} needs existing requirement IDs.`);
  return structuredClone({ requirements: value.requirements, cases });
}
export const PREPARATION_CHECK_PROMPT = `Check the source destinations and frozen-case proposal before any candidate exists. Return JSON only: {"ready":boolean,"issues":[{"id":"stable-id","kind":"coverage|meaning|scope","source":"existing path","quote":"exact source excerpt","requirementIds":["requirement-id"],"detail":"specific defect"}],"resolved":["previous-issue-id"],"caseFindings":[]}. Cite an existing source and exact quote for each issue; preserve IDs while repairing.
Split mixed passages into independent meanings. Classify each requirement by whether a concrete proposed tool action or submitted content plus available context can violate it; grammatical polarity and a paragraph's editing/workflow theme do not settle this. Preserve conditions and exceptions. A process instruction and an observable output restriction in the same sentence can have different destinations. Do not turn every preference into a hard prohibition.
STATE's ordinary continuity and independent guidance must survive in text or an existing reference. Other standing documents continue to supply their own ordinary guidance: do not require copying it into STATE. Extract their independently reviewable hard constraints. A reference cannot replace a reviewable constraint.
Check completeness and classification against the source documents once. Require representative legitimate and violating scenarios for each reviewable requirement, including relevant content destinations and meaningful exceptions; shared scenarios are allowed. Check that premises actually supply evidence and expected judgments follow the sources. Do not accept an omitted requirement merely because all existing cases cover something else. Keep the source correspondence compact; report concrete defects, not another full table. On repair, preserve accepted decisions and resolve the previous issues, without inventing new duties.`;
export async function checkMigrationPreparation(input: MigrationInput, llm: ResponseClient, signal: AbortSignal,
  preparation: MigrationPreparation, previous?: SourceCheck): Promise<SourceCheck> {
  return requestSourceCheck(input, llm, signal, PREPARATION_CHECK_PROMPT, {
    mode: 'preparation', sources: input.sources, requirements: preparation.requirements, cases: preparation.cases,
    tools: input.tools.map(group => ({ session: group.session, tools: group.tools.filter(tool => preparation.cases.some(sample => sample.session === group.session && sample.tool === tool.name)) })),
    previousIssues: previous?.issues ?? [],
  }, input.sources, preparation.requirements.flatMap(item => item.constraintIds), preparation.cases, previous);
}
