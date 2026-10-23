/** STATE.md owns both the continuity text and the readable action constraints. */
import { createHash } from 'node:crypto';
import type { ToolSpec, ToolTag } from 'cortico/core/types.ts';
import type { GitWorkspaceMemory } from '../base/persona/memory.ts';

export const STATE_PATH = 'state/STATE.md';
const STATE_CONSTRAINT_GUIDANCE = `Author constraints from existing commitments:
* Extract existing requirements in their original wording, both in text and in instruction. Split a clause only as needed to separate actions; do not paraphrase it into a new rule. Preserve logical operators, order, subject and range: "read the original or ask its author" must keep the alternative, not become "read, then ask". A requirement about recording in general must not acquire a list of directories, document types, people or sessions that the source never limited it to. A general rule to separate facts, reports and inferences must not become a speech-only rule that drops Memory writing. Before removing a source clause from ordinary text, ensure the structured entries cover its whole original range. If reviewing only part of it, retain the original clause in text for the remainder. When unsure how to split faithfully, keep the original clause in ordinary text. Compare your complete replacement against each source clause before writing, including requirements retained in text.
* Before drafting, identify every independent obligation in each source clause, including short commands joined by commas or semicolons. Match each to its destination in text or constraints, then check none disappeared. Positive duties count as much as prohibitions: verifying dates does not preserve a separate duty to correct the recorded timeline. Checking a future claim and repairing an existing record are different obligations. Keep any obligation you cannot safely structure in text in its original wording. Prefer the source clause's own wording for instruction; do not turn a prerequisite into a different prohibition or replace a conditional rule with an absolute one. Migration reorganizes commitments; it does not grant permissions or weaken prohibitions. Leave exceptions as an empty string unless the source explicitly supplies an exception. Convenience, common practice, assumed consent, public availability, preserving a quotation, archiving a document, or treating an edit as minor do not themselves authorize exceptions. Preserve source qualifications and limits; do not replace them with broader permissions.
* Each constraint checks one proposed tool action. Memory tools supply arguments and available file changes, not conversation history. Speech tools supply arguments/drafts and limited relevant dialogue. Other tools supply arguments and available read-size metadata. None supplies the whole workspace, past tool receipts or a record of prior checks. Requirements to read, verify, delegate, obtain approval or retry only after a check belong in ordinary text when they need that missing history. A rule routing large reads/searches to another worker can instead concern the pending action itself; do not reject it just for being a process rule. Use the available size metadata, preserve its source conditions without inventing thresholds, and select only sessions with that worker capability. For example, a file edit cannot establish who originally authorized it or whether a person earlier said not to record something; a trade call cannot establish whether a balance was checked. Keep those original obligations in text. Reviewing a send call cannot check whether assistant prose was emitted elsewhere.
* Choose scope by naming an actual violating call and what in the review input would establish the violation. A claim made in a message belongs to the tool that conveys that message, not to a read or trade tool merely mentioned by the claim. Writing private Memory is not itself disclosure to another person. A read limit applies to reads; a message-format rule applies to outgoing text. Scope follows the effect, not a verb in the rule: a rule forbidding removal can also be violated by replacing a file or editing a paragraph to nothing. For Memory-content or document-preservation rules use tags:["write"] and put the relevant paths/content conditions in instruction. Do not restrict them to delete_file/move_file or another partial list. Cover both main and dream unless the source really limits the session. For other tool-specific rules choose exact available names; include every applicable draft/confirm or mixed-purpose tool that carries the constrained content. Fields intersect; values within a field are alternatives.
* Before writing, test each candidate in your reasoning: identify its source clause, an actual violating call, and the visible evidence proving that violation. If that evidence requires missing earlier reads, receipts, permission or internal thought, keep the requirement in ordinary text. Then check both directions: every original requirement remains, and every new sentence is supported by a source. Split disclosures, reporting and writing rules when their evidence differs. Keep soft preferences, identity, facts, plans, and uncheckable obligations in ordinary text. Preserve existing ordinary text, references and current-status facts; missing referenced files and temporary task instructions are not changes to persistent Memory. Check scope against the entire tool catalogue and compare entries about outgoing text: a posting tool that can violate a wording rule can also disclose forbidden content. A narrower tool set needs a restriction in the source, not just a shorter list. A spoken identity or factual claim can violate the same commitment as a written one. Empty constraints are valid.`;
const HEADING = '## Action constraints';
const TAGS: ToolTag[] = ['read', 'write', 'speak', 'act', 'flow', 'snapshot'];
export interface StateScope { sessions?: string[]; tools?: string[]; tags?: ToolTag[] }
export interface StateConstraint { id: string; scope: StateScope; instruction: string; exceptions: string }
export interface StateDocument { text: string; constraints: StateConstraint[] }
export interface StateSnapshot extends StateDocument { raw: string; revision: string; structured: boolean; needsScopeMigration?: boolean; error?: string }
const completeScope = (scope: StateScope): boolean => !!scope.sessions?.length && !!(scope.tools?.length || scope.tags?.length);

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${name} must be a nonempty string array`);
  return [...new Set(value)] as string[];
}

export function validateState(value: unknown, allowLegacyScope = false): StateDocument {
  const doc = value as StateDocument;
  if (!doc || typeof doc.text !== 'string' || !Array.isArray(doc.constraints)) throw new Error('text and constraints are required');
  if (/^## Action constraints\s*$/m.test(doc.text)) throw new Error('Action constraints is a reserved heading');
  const seen = new Set<string>();
  const constraints = doc.constraints.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.id) || seen.has(item.id)) throw new Error('Constraint IDs must be unique ASCII identifiers');
    seen.add(item.id);
    if (typeof item.instruction !== 'string' || !item.instruction.trim() || typeof item.exceptions !== 'string') throw new Error(`Invalid constraint ${item.id}`);
    const scope: StateScope = {};
    if (item.scope !== undefined) {
      if (!item.scope || typeof item.scope !== 'object' || Object.keys(item.scope).some(key => !['sessions', 'tools', 'tags'].includes(key))) throw new Error(`Invalid scope ${item.id}`);
      for (const key of ['sessions', 'tools', 'tags'] as const) if (item.scope[key] !== undefined) {
        const list = strings(item.scope[key], key);
        if (key === 'tags') {
          if (list.some(tag => !TAGS.includes(tag as ToolTag))) throw new Error(`Unknown tool tag in ${item.id}`);
          scope.tags = list as ToolTag[];
        } else scope[key] = list;
      }
    }
    if (!allowLegacyScope && !completeScope(scope)) throw new Error(`Constraint ${item.id} requires scope.sessions and scope.tools or scope.tags`);
    if (scope.sessions?.some(session => session !== 'main' && session !== 'dream')) throw new Error(`Unknown session in ${item.id}`);
    return { id: item.id, scope, instruction: item.instruction, exceptions: item.exceptions };
  });
  return { text: doc.text, constraints };
}

export function renderState(value: StateDocument): string {
  const doc = validateState(value);
  return doc.text + '\n' + HEADING + '\n' + doc.constraints.map(item => [
    '', `### ${item.id}`,
    ...(['sessions', 'tools', 'tags'] as const).flatMap(key => item.scope[key] ? [`- ${key}: ${JSON.stringify(item.scope[key])}`] : []),
    `- instruction: ${JSON.stringify(item.instruction)}`, `- exceptions: ${JSON.stringify(item.exceptions)}`,
  ].join('\n')).join('\n') + '\n';
}

export function parseState(raw: string): StateSnapshot {
  const revision = createHash('sha256').update(raw).digest('hex');
  const match = /(?:^|\n)## Action constraints[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!match) return { raw, revision, text: raw, constraints: [], structured: false };
  try {
    const text = raw.slice(0, match.index);
    const section = raw.slice(match.index + match[0].length);
    const blocks = section.split(/^### /m);
    if (blocks.shift()!.trim()) throw new Error('Unexpected content in Action constraints');
    const constraints = blocks.map(block => {
      const [id, ...lines] = block.split(/\r?\n/);
      const values: Record<string, unknown> = {};
      for (const line of lines.filter(line => line.trim())) {
        const field = /^- (sessions|tools|tags|instruction|exceptions): (.+)$/.exec(line);
        if (!field || field[1] in values) throw new Error(`Invalid field in constraint ${id}`);
        values[field[1]] = JSON.parse(field[2]);
      }
      return { id, instruction: values.instruction, exceptions: values.exceptions,
        scope: Object.fromEntries(['sessions', 'tools', 'tags'].filter(key => key in values).map(key => [key, values[key]])) };
    });
    const doc = validateState({ text, constraints }, true);
    return { raw, revision, ...doc, structured: true,
      ...(doc.constraints.some(rule => !completeScope(rule.scope)) ? { needsScopeMigration: true } : {}) };
  } catch (error) {
    return { raw, revision, text: raw, constraints: [], structured: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function appliesTo(constraint: StateConstraint, role: string, tool: { name: string; tags: readonly ToolTag[] }): boolean {
  const scope = constraint.scope;
  return completeScope(scope) && scope.sessions!.includes(role)
    && (!scope.tools || scope.tools.includes(tool.name))
    && (scope.tags ?? TAGS).some(tag => tool.tags.includes(tag as ToolTag));
}

export class StateDocuments {
  constructor(private readonly memory: GitWorkspaceMemory) {}
  read(): StateSnapshot { return parseState(this.memory.exists(STATE_PATH) ? this.memory.readFile(STATE_PATH) : ''); }
  update(value: unknown, expectedRevision: unknown): StateSnapshot {
    const doc = validateState(value);
    if (typeof expectedRevision !== 'string' || this.read().revision !== expectedRevision) throw new Error('STATE changed. Read it again and use its current revision.');
    this.memory.writeFileAtomic(STATE_PATH, renderState(doc));
    return this.read();
  }
}

export const UPDATE_STATE_SPEC: ToolSpec = {
  name: 'update_state', tags: ['write'],
  description: 'Dream only. Replace the continuity text and action constraints in STATE.md. Read the full STATE.md first; the last read version is checked automatically. Preserve meaning when structuring legacy notes. Empty constraints explicitly finish migration. ' + STATE_CONSTRAINT_GUIDANCE,
  parameters: { type: 'object', properties: {
    text: { type: 'string', description: 'Ordinary continuity text. Preserve the original wording of retained requirements, including alternatives, order and applicability; migration does not authorize rewriting them.' }, expectedRevision: { type: 'string', description: 'Optional explicit version for existing callers; otherwise use the last full STATE read in this session.' },
    constraints: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, instruction: { type: 'string', minLength: 1, description: 'One requirement observable in the proposed action, extracted in the source wording without narrowing its subjects or range. Prior checks needing unavailable receipts stay in ordinary text.' }, exceptions: { type: 'string', description: 'Only exceptions explicitly present in the source commitment; otherwise an empty string.' },
      scope: { type: 'object', description: 'Required call filter for where the violation occurs. Cover all relevant tools and sessions; use category tags for category-wide rules. Reporting a trade and performing a trade are different actions.', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'string', enum: ['main', 'dream'] } },
        tools: { type: 'array', minItems: 1, description: 'Exact names from the available tools; use tags for categories.', items: { type: 'string' } }, tags: { type: 'array', minItems: 1, items: { type: 'string', enum: TAGS } } }, required: ['sessions'], anyOf: [{ required: ['tools'] }, { required: ['tags'] }] },
    }, required: ['id', 'scope', 'instruction', 'exceptions'] } },
  }, required: ['text', 'constraints'] },
};
