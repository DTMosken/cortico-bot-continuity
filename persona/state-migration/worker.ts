/** Isolated drafting and replay tools. Source text is a launch-time snapshot; fixture writes stay temporary. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDef } from 'cortico/core/types.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import type { ResponseClient } from 'cortico/core/generation.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { GitWorkspaceMemory } from '../../base/persona/memory.ts';
import { appliesTo, validateState, renderState, type StateDocument } from '../state-document.ts';
import { prepareStateAction, bypassesStateReview } from '../state-review.ts';
import { runWorker, type WorkerHost } from '../subagents/runtime.ts';
import { checkMigrationSources } from './source-check.ts';
import { MIGRATION_PROMPT, type MigrationCandidate, type MigrationInput, type MigrationProgress } from './contracts.ts';

export interface MigrationServices {
  core: WorkerHost; llm: ResponseClient; signal: AbortSignal;
  review(action: unknown, constraints: StateDocument['constraints'], history: unknown[]): Promise<unknown>;
  progress(value: MigrationProgress): void;
}
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function migrationWorkerTools(input: MigrationInput, services: Pick<MigrationServices, 'review' | 'signal' | 'llm'>) {
  let document: StateDocument | undefined, candidate: MigrationCandidate | undefined, reviewed = false, checked = false, finished = false;
  const consulted = new Set(Object.keys(input.sources).filter(path => /(?:^|\/)STATE\.md$|(?:^|\/)CONSTITUTION\.md$/iu.test(path)));
  const historyEvidence: unknown[] = [];
  const effectiveScope = (doc: StateDocument) => doc.constraints.map(rule => ({ id: rule.id, sessions: input.tools.map(group => ({ session: group.session,
    tools: group.tools.filter(tool => !tool.tags.includes('flow') && appliesTo(rule, group.session, tool)).map(tool => tool.name) })).filter(group => group.tools.length) }));
  const make = (name: string, description: string, parameters: Record<string, unknown>, handler: ToolDef['handler']): ToolDef =>
    ({ name, description, parameters, tags: ['read'], handler });
  const page = (text: string, args: Record<string, unknown>) => {
    const start = args.start ?? 0, max = args.maxChars ?? 12000;
    if (!Number.isInteger(start) || Number(start) < 0 || !Number.isInteger(max) || Number(max) < 1 || Number(max) > 32000) throw new Error('Invalid character range');
    return JSON.stringify({ text: text.slice(Number(start), Number(start) + Number(max)), start,
      next: Number(start) + Number(max) < text.length ? Number(start) + Number(max) : null, totalChars: text.length });
  };
  const paging = { start: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 32000 } };
  const tools: ToolDef[] = [
    make('migration_sources', 'List available source documents or read a character page by path.', schema({ path: { type: 'string' }, ...paging }), async args => {
      if (args.path === undefined) return JSON.stringify(Object.entries(input.sources).map(([path, text]) => ({ path, chars: text.length })));
      if (typeof args.path !== 'string' || !(args.path in input.sources)) throw new Error('Source not found');
      if (!consulted.has(args.path)) checked = false;
      consulted.add(args.path);
      return page(input.sources[args.path], args);
    }),
    make('migration_history', 'Search retained dialogue, tool calls and feedback across runs. Read a page by id; query returns matching excerpts.',
      schema({ id: { type: 'string' }, query: { type: 'string' }, ...paging }), async args => {
        if (typeof args.id === 'string') {
          const entry = input.history.find(entry => entry.id === args.id);
          if (!entry) throw new Error('History not found');
          const result = page(entry.text, args);
          historyEvidence.push({ id: entry.id, ...JSON.parse(result) });
          return result;
        }
        const query = String(args.query ?? '').toLowerCase();
        const matches = input.history.filter(entry => entry.text.toLowerCase().includes(query));
        const offset = Number(args.start ?? 0), count = 20;
        if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid history offset');
        const selected = matches.slice(offset, offset + count).map(entry => { const at = Math.max(0, entry.text.toLowerCase().indexOf(query) - 200);
          return { id: entry.id, chars: entry.text.length, excerpt: entry.text.slice(at, at + 1200) }; });
        historyEvidence.push(...selected);
        return JSON.stringify({ total: matches.length, next: offset + count < matches.length ? offset + count : null,
          items: selected });
      }),
    make('migration_tools', 'Read actual tool contracts and session availability. Omit names for the catalogue; supply names for parameter schemas.',
      schema({ names: { type: 'array', items: { type: 'string' } } }), async args => {
        if (args.names !== undefined && (!Array.isArray(args.names) || args.names.some(name => typeof name !== 'string'))) throw new Error('Invalid names');
        return JSON.stringify(input.tools.map(group => ({ session: group.session, tools: group.tools.filter(tool => !args.names || (args.names as string[]).includes(tool.name))
          .map(tool => args.names ? tool : { name: tool.name, tags: tool.tags, description: tool.description.split('\n')[0] }) })));
      }),
    make('migration_draft', 'Replace the temporary STATE. Use exact tools OR tags, not both. Group compatible source requirements. The receipt lists actual matched tools per session; inspect it before source checking and replay.',
      schema({ text: { type: 'string' }, constraints: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string' }, instruction: { type: 'string' }, exceptions: { type: 'string' }, scope: { type: 'object', properties: {
          sessions: { type: 'array', description: 'Sessions with directly relevant actions. Use main and/or dream according to actual availability.', items: { type: 'string', enum: ['main', 'dream'] } }, tools: { type: 'array', description: 'Exact tools where the violation occurs. Omit tags when selecting tools.', items: { type: 'string' } },
          tags: { type: 'array', description: 'Tool categories instead of explicit tool names. This does not extend a tools list.', items: { type: 'string', enum: ['read', 'write', 'speak', 'act', 'flow'] } },
        }, required: ['sessions'], oneOf: [{ required: ['tools'], not: { required: ['tags'] } }, { required: ['tags'], not: { required: ['tools'] } }] },
      }, required: ['id', 'scope', 'instruction', 'exceptions'] } } }, ['text', 'constraints']), async args => {
        const next = validateState(args);
        if (next.constraints.some(rule => rule.scope.tools && rule.scope.tags)) throw new Error('Choose tools OR tags. Tags do not extend explicit tools; preserve intentional intersections using the effective tool names.');
        for (const rule of next.constraints) for (const session of rule.scope.sessions!) {
          const available = input.tools.find(group => group.session === session)?.tools ?? [];
          if (!available.some(tool => !tool.tags.includes('flow') && appliesTo(rule, session, tool))) throw new Error(`Constraint ${rule.id} matches no tool in ${session}`);
          if (rule.scope.tools?.some(name => !input.tools.some(group => group.tools.some(tool => tool.name === name)))) throw new Error('Unknown scoped tool');
        }
        document = next; reviewed = next.constraints.length === 0; checked = false; candidate = undefined;
        return '[draft saved] ' + JSON.stringify({ chars: renderState(next).length, rules: next.constraints.length, effectiveScope: effectiveScope(next), next: 'Inspect actual coverage, call migration_check, then replay representative actions.' });
      }),
    make('migration_check', 'Independently check the current draft against complete consulted sources and effective tool coverage. Reports omissions, altered meaning, scope mistakes, procedural rules and redundancy. Required before finishing; edits invalidate the result.', schema({}), async () => {
      if (!document) throw new Error('Save a draft first');
      checked = false;
      const check = await checkMigrationSources(input, services.llm, services.signal, document,
        Object.fromEntries([...consulted].map(path => [path, input.sources[path]])), effectiveScope(document), historyEvidence);
      checked = check.ready;
      return JSON.stringify(check);
    }),
    make('migration_review', 'Replay a proposed tool call against the current candidate without executing it. Supply reference judgment, fixture files, and relevant history/dialogue. qq_confirm also needs its draft.',
      schema({ session: { type: 'string', enum: ['main', 'dream'] }, tool: { type: 'string' }, args: { type: 'object' },
        expected: { type: 'string', enum: ['allow', 'remind', 'uncertain'] }, evidence: { type: 'string' },
        files: { type: 'object', additionalProperties: { type: 'string' } }, history: { type: 'array', items: {} },
        dialogue: { type: 'array', items: {} }, context: { type: 'object', description: 'Relevant scene/recipient metadata for this replay.' },
        read: { type: 'object', description: 'Known read-result metadata for non-file tools, such as chars and lines; omit when unknown.' }, draft: { type: 'object' },
      }, ['session', 'tool', 'args', 'expected', 'evidence']), async args => {
        if (!document) throw new Error('Save a draft first');
        const spec = input.tools.find(group => group.session === args.session)?.tools.find(tool => tool.name === args.tool);
        if (!spec || !args.args || typeof args.args !== 'object' || Array.isArray(args.args)) throw new Error('Unknown tool or invalid arguments');
        if (!['allow', 'remind', 'uncertain'].includes(String(args.expected)) || typeof args.evidence !== 'string') throw new Error('Supply reference judgment and evidence');
        const dir = mkdtempSync(join(tmpdir(), 'continuity-migration-case-'));
        try {
          const memory = new GitWorkspaceMemory({ memoryDir: dir });
          if (args.files !== undefined && (!args.files || typeof args.files !== 'object' || Array.isArray(args.files))) throw new Error('Invalid fixture files');
          for (const [path, text] of Object.entries(args.files ?? {})) {
            if (typeof text !== 'string') throw new Error('Fixture text must be a string');
            memory.writeFileAtomic(path, text);
          }
          const draft = args.draft && typeof args.draft === 'object' && !Array.isArray(args.draft)
            ? { args: args.draft as Record<string, unknown>, revision: 'fixture' } : null;
          const prepared = prepareStateAction({ memory, core: () => null, readOverride: () => null,
            speechContext: () => ({ ...(args.context && typeof args.context === 'object' && !Array.isArray(args.context) ? args.context : {}), recentDialogue: Array.isArray(args.dialogue) ? args.dialogue : [] }), wholeReadFallbackChars: () => input.readChars },
          spec, args.args as Record<string, unknown>, String(args.session),
          spec.name !== 'read_file' && args.read && typeof args.read === 'object' && !Array.isArray(args.read)
            ? () => ({ read: args.read as Record<string, unknown>, revision: 'fixture' }) : undefined, draft);
          const constraints = document.constraints.filter(rule => !bypassesStateReview(spec, args.args as Record<string, unknown>) && appliesTo(rule, String(args.session), spec));
          const result = constraints.length ? await services.review(prepared.action, constraints, [...prepared.history, ...(Array.isArray(args.history) ? args.history : [])])
            : { kind: 'not-reviewed', reason: 'No applicable constraints or action bypasses review.' };
          if (services.signal.aborted) throw new Error('Migration stopped');
          if (constraints.length && result && typeof result === 'object' && (result as { kind?: string }).kind === 'reviewed') reviewed = true;
          return JSON.stringify({ expected: args.expected, evidence: args.evidence, result });
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }),
    make('migration_finish', 'Submit the current usable candidate after semantic checks and representative replays, or stop without a candidate.',
      schema({ reason: { type: 'string', enum: ['ready', 'diminishing_returns', 'failed'] }, explanation: { type: 'string' } }, ['reason', 'explanation']), async args => {
        if (services.signal.aborted) throw new Error('Migration stopped');
        if (args.reason === 'failed') { finished = true; return '[migration ended without candidate] ' + String(args.explanation || 'No usable candidate'); }
        if (!document || !reviewed || !checked || !['ready', 'diminishing_returns'].includes(String(args.reason)) || typeof args.explanation !== 'string' || !args.explanation.trim())
          throw new Error('Save a valid candidate, pass migration_check and applicable decision replays for this version, and give a completion reason');
        renderState(document);
        finished = true;
        candidate = { document, reason: args.reason as MigrationCandidate['reason'] };
        return '[candidate accepted]';
      }),
  ];
  return { tools, candidate: () => candidate, finished: () => finished };
}

export async function runMigrationWorker(input: MigrationInput, services: MigrationServices): Promise<MigrationCandidate> {
  const worker = migrationWorkerTools(input, services);
  const outcome = await runWorker({ core: services.core, llm: services.llm, spec: input.spec,
    messages: [message('system', MIGRATION_PROMPT), message('user', 'Start by reading the source documents and inspecting available tools. Select relevant retained history, or construct scenarios if it is absent.')],
    tools: worker.tools, contextTokens: input.contextTokens, signal: services.signal, label: 'STATE 迁移', log: nullLogger(),
    stopped: () => services.signal.aborted, finished: worker.finished, progress: progress => services.progress({ rounds: progress.rounds, phase: '正在整理' }),
  });
  const candidate = worker.candidate();
  if (!candidate || services.signal.aborted) throw new Error('没有形成可提交候选：' + outcome.reason);
  return candidate;
}
