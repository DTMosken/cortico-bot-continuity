/** Dream queries current tool contracts when choosing STATE review scopes. */
import type { ToolDef, ToolSpec } from 'cortico/core/types.ts';

export const STATE_REVIEW_TOOLS_SPEC: ToolSpec = {
  name: 'state_review_tools', tags: ['read'],
  description: 'Dream only. List current main/Dream tool names, tags, sessions and short descriptions. Supply names to read their full descriptions and parameter schemas before choosing STATE review scopes. This reads tool definitions, not conversation, configuration or credentials.',
  parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: 'Omit to list tools; supply exact names for their full contracts.' } } },
};

export function stateReviewTools(read: () => Array<{ session: string; tools: readonly ToolSpec[] }>): ToolDef {
  return { ...STATE_REVIEW_TOOLS_SPEC, handler: async (args, context) => {
    if (context.role !== 'dream') return '[state tools failed] Dream only.';
    if (args.names !== undefined && (!Array.isArray(args.names) || args.names.some(name => typeof name !== 'string'))) return '[state tools failed] names must be an array of tool names.';
    const names = args.names as string[] | undefined;
    const entries = new Map<string, { spec: ToolSpec; sessions: string[] }>();
    for (const group of read()) for (const spec of group.tools) {
      const entry = entries.get(spec.name) ?? { spec, sessions: [] };
      if (!entry.sessions.includes(group.session)) entry.sessions.push(group.session);
      entries.set(spec.name, entry);
    }
    return JSON.stringify({ tools: [...entries.values()].filter(({ spec }) => !names || names.includes(spec.name)).map(({ spec, sessions }) => ({
      name: spec.name, tags: spec.tags, sessions,
      description: names ? spec.description : spec.description.split('\n')[0],
      ...(names ? { parameters: spec.parameters } : {}),
    })), ...(names ? { unavailable: names.filter(name => !entries.has(name)) } : {}) });
  } };
}
