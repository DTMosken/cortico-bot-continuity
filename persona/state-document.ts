/** STATE.md owns both the continuity text and the readable action constraints. */
import { createHash } from 'node:crypto';
import type { ToolSpec, ToolTag } from 'cortico/core/types.ts';
import type { GitWorkspaceMemory } from '../base/persona/memory.ts';

export const STATE_PATH = 'state/STATE.md';
const HEADING = '## Action constraints';
const TAGS: ToolTag[] = ['read', 'write', 'speak', 'act', 'flow', 'snapshot'];
export interface StateScope { sessions?: string[]; tools?: string[]; tags?: ToolTag[] }
export interface StateConstraint { id: string; scope: StateScope; instruction: string; exceptions: string }
export interface StateDocument { text: string; constraints: StateConstraint[] }
export interface StateSnapshot extends StateDocument { raw: string; revision: string; structured: boolean; error?: string }

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${name} must be a nonempty string array`);
  return [...new Set(value)] as string[];
}

export function validateState(value: unknown): StateDocument {
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
    return { raw, revision, ...validateState({ text, constraints }), structured: true };
  } catch (error) {
    return { raw, revision, text: raw, constraints: [], structured: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function appliesTo(constraint: StateConstraint, role: string, tool: { name: string; tags: readonly ToolTag[] }): boolean {
  const scope = constraint.scope;
  return (scope.sessions ?? ['main', 'dream']).includes(role)
    && (!scope.tools || scope.tools.includes(tool.name))
    && (scope.tags ?? (scope.tools ? TAGS : ['write', 'speak', 'act'])).some(tag => tool.tags.includes(tag as ToolTag));
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
  description: 'Dream only. Replace the continuity text and action constraints in STATE.md. Preserve meaning when structuring legacy notes. Read STATE.md to obtain expectedRevision. Empty constraints explicitly finish migration.',
  parameters: { type: 'object', properties: {
    text: { type: 'string' }, expectedRevision: { type: 'string' },
    constraints: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, instruction: { type: 'string', minLength: 1 }, exceptions: { type: 'string' },
      scope: { type: 'object', properties: { sessions: { type: 'array', items: { type: 'string' } },
        tools: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string', enum: TAGS } } } },
    }, required: ['id', 'instruction', 'exceptions'] } },
  }, required: ['text', 'constraints', 'expectedRevision'] },
};
