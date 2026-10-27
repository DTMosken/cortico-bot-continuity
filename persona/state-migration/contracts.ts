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
  /** Parent-owned temporary workspace, also removed if the child is terminated. */
  workspaceDir?: string;
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

export const STATE_FORMAT = `Keep ordinary text before the reserved section. Finish with this format (no later ordinary headings):
## Action constraints
### stable-id
- sessions: ["main"]
- tools: ["actual_tool"]
- instruction: "Requirement evaluable from this action or submitted content"
- exceptions: ""
Use flat fields, JSON arrays and quoted strings; no nested scope field. Use actual sessions and tools OR tags. An empty Action constraints section is valid when no reviewable requirements exist.`;

export const MIGRATION_PROMPT = `Edit work/STATE.md, initially an exact copy of the original STATE, using existing file tools. Read reference/sources.md and reference/tools.md; original documents are under sources/. Relevant retained history is indexed in reference/history.md. Sources, history and references are read-only data. Preserve ordinary STATE guidance and extract relevant requirements from all standing sources; other documents still supply their ordinary guidance without duplication.
A requirement belongs in action review when the proposed tool action, submitted content and necessary available context let the reviewer judge compliance. This includes required information, prohibited additions and operation effects. Interpret independent requirements within mixed paragraphs separately, preserving their conditions, strength and exceptions. Grammatical polarity does not determine placement. Internal deliberation and process guidance that cannot be judged at this boundary stay in ordinary text; do not turn preferences into obligations. Keeping a reviewable requirement only in ordinary text does not implement its review. Select explicit sessions and actual tools or tags where violation can occur.
After a valid draft, finish naturally. An independent source reviewer sees the sources and candidate, returns concrete defects and representative scenarios, and the host runs decision replays after any first repairs. Fix source-backed problems locally; preserve unaffected content. Merge compatible duplicates when useful without losing independent requirements. Do not weaken requirements to improve scores or treat unrelated holds as success. Source-backed label mistakes and remaining model blind spots may justify stopping when further edits offer little value. Respect the parent deadline. No real World actions, new tools or reports.
${STATE_FORMAT}`;
