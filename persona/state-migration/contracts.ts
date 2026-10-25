/** Migration options belong to Persona; the duration covers generation only. */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { ToolSpec, ModelSpec } from 'cortico/core/types.ts';
import type { StateDocument } from '../state-document.ts';

export const MIGRATION_DEFAULT_MINUTES = 10;
export const MIGRATION_MIN_MINUTES = 5;
export const MIGRATION_MAX_MINUTES = 30;
export const MIGRATION_OPTIONS_GROUP: ConfigGroup = {
  id: 'continuity-state-migration', owner: 'persona', schema: { type: 'object', title: '迁移旧约束', properties: {
    maxMinutes: { type: 'integer', title: '最长整理时间', minimum: MIGRATION_MIN_MINUTES,
      maximum: MIGRATION_MAX_MINUTES, multipleOf: 1, 'x-suffix': '分钟' },
  } },
};
export function migrationMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIGRATION_MIN_MINUTES || value > MIGRATION_MAX_MINUTES)
    throw new Error('整理时间须为 5–30 分钟的整数');
  return value;
}
export interface ToolGroup { session: string; tools: ToolSpec[] }
export interface MigrationTiming { deadlineAtMs: number; finishingReserveMs: number }
export interface MigrationInput {
  spec: ModelSpec; contextTokens: number; readChars: number; tools: ToolGroup[];
  sources: Record<string, string>; history: Array<{ id: string; text: string }>;
  /** Parent-enforced timing for bounded runs; standalone checks may omit it. */
  timing?: MigrationTiming;
}
export interface MigrationProgress { rounds: number; phase: string }
export interface MigrationCandidate { document: StateDocument; reason: 'ready' | 'diminishing_returns' }
export interface MigrationState {
  status: 'idle' | 'running' | 'waiting' | 'applying' | 'complete' | 'failed';
  reason?: string; id?: string; rounds?: number;
}
export type ChildRequest = { kind: 'request'; id: number; method: 'generate' | 'review'; args: unknown };
export type ToChild = { kind: 'init'; input: MigrationInput } | { kind: 'reply'; id: number; value?: unknown; error?: string };
export type FromChild = ChildRequest | { kind: 'progress'; value: MigrationProgress }
  | { kind: 'candidate'; value: MigrationCandidate } | { kind: 'failed'; error: string };

export const MIGRATION_PROMPT = `Organize existing action constraints into a usable STATE, then test and improve it.
Read STATE.md, CONSTITUTION.md and relevant source documents. Preserve ordinary current-state text, references and every requirement's meaning, conditions and exceptions. Constraints are source-backed prohibitions on observable proposed tool actions or content. Put how-to instructions, procedures and positive duties in ordinary text; do not merely negate guidance to make it a constraint. Do not invent commitments or exceptions, or turn soft preferences and records into prohibitions.
Use migration_tools to inspect this deployment's actual tools, parameters, tags and main/dream availability. Each constraint needs explicit sessions and tools or tags. Select the action where a violation occurs, not a later outcome; avoid unrelated tools. Use tools OR tags in a draft; use the actual matched-tool list in its receipt to check coverage. If sessions need different action types, retain coverage in each. When a source intentionally combines filters, preserve its effective tools explicitly. A tool may be available in only one session.
Use migration_history to find relevant dialogue, tool calls and user feedback across retained runs. Historical behavior is not an answer key. When evidence is sparse, construct ordinary, conflicting, exception and boundary cases from the rules and tool contracts. Test independent duties separately: one can fail while all the others hold. Test each exception's boundary; it must not excuse unrelated obligations.
Maintain a compact candidate with migration_draft. Preserve all independent clauses from the sources, including duties to repair earlier records; checking new content is a different obligation. Group requirements with compatible scope and evidence rather than making one rule per sentence. Mechanical permissions, tool protocols, this migration task and its version/read checks are not new permanent commitments. Do not repeat them as constraints. After saving, call migration_check in its independent context to audit complete source coverage, meaning and effective scopes. Fix substantive findings and check again after edits; do this before spending many calls on replay. For each representative case, judge whether the current requirements call for allow, remind or uncertain; then call migration_review using the real proposed tool arguments, relevant recent dialogue/history and any files needed to reconstruct the action. Files are fixtures in isolation. Nothing is executed.
Compare the decision result with your judgment. A mismatch invalidates source-check approval: call migration_check with the accumulated replay evidence before finishing, even if you propose no wording change. Resolve real omissions, changes of meaning, scope mistakes and false positives; revise your reference judgment if the evidence warrants it. Rerun representative cases after edits. Do not delete valid requirements or add unsupported exceptions to improve scores. Discussed or quoted rules are not necessarily instances of violating them. Keep wording concise without losing requirements.
Once meaning, scope and replay have converged, consolidate once before finishing: merge duplicate prohibitions with compatible scope and exceptions, and move how-to guidance into ordinary text. Inspect each rule's scope matches and reminders on deliberate violations, legitimate actions and exception cases; check false positives as well as missed violations. A rule with no source-backed, tool-level violation belongs in text; low observed frequency alone does not make a valid prohibition redundant. Recheck and replay affected boundaries after edits.
When the candidate is usable and no worthwhile corrections remain, call migration_finish. You may finish with diminishing_returns when the candidate faithfully covers the sources and remaining errors cannot reasonably improve through STATE wording, or further changes would damage meaning. Model blind spots need not all disappear. Do not use early stopping to excuse known document defects.
Only finish a candidate with a successful migration_check for the current draft and actual decision replay of applicable constraints. Passing a case outside every scope does not test the draft. Aim for concise source-faithful rules, not a target count, verbosity or maximum coverage of every tool. A deadline alone is not success. Return no candidate if none is usable. The parent process enforces the time limit. No fixed round or request budget applies. Do not write reports or perform real World actions.`;
