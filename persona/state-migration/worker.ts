/** Migration uses the existing file tools in a private workspace; the host schedules checks. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResponseClient } from 'cortico/core/generation.ts';
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { GitWorkspaceMemory } from '../../base/persona/memory.ts';
import { workspaceTools } from '../../base/persona/workspaceTools.ts';
import { appliesTo, parseState, type StateDocument } from '../state-document.ts';
import { bypassesStateReview } from '../state-review.ts';
import { runWorker, type WorkerHost } from '../subagents/runtime.ts';
import { checkMigrationSources, type SourceCheck } from './source-check.ts';
import { generateMigrationCases, replayMigrationCase, type MigrationCase, type MigrationReplay } from './fixtures.ts';
import { trimMigrationReadFallback, updateMigrationTimeReminder } from './context.ts';
import { MIGRATION_PROMPT, type MigrationCandidate, type MigrationInput, type MigrationProgress } from './contracts.ts';

export interface MigrationServices {
  core: WorkerHost; llm: ResponseClient; signal: AbortSignal;
  review(action: unknown, constraints: StateDocument['constraints'], history: unknown[]): Promise<unknown>;
  progress(value: MigrationProgress): void;
}
const CASES = 'reference/cases.json', CANDIDATE = 'work/STATE.md';
export async function runMigrationWorker(input: MigrationInput, services: MigrationServices): Promise<MigrationCandidate> {
  const dir = input.workspaceDir ?? mkdtempSync(join(tmpdir(), 'continuity-migration-'));
  try {
    const memory = new GitWorkspaceMemory({ memoryDir: dir });
    for (const [path, text] of Object.entries(input.sources)) memory.writeFileAtomic('sources/' + path, text);
    memory.writeFileAtomic('reference/sources.md', Object.entries(input.sources).map(([path, text]) => `sources/${path} (${text.length} characters)`).join('\n'));
    const refs: string[] = []; let toolNumber = 0;
    for (const group of input.tools) for (const tool of group.tools) {
      const path = `reference/tools/${toolNumber++}.json`; memory.writeFileAtomic(path, JSON.stringify({ session: group.session, ...tool }, null, 2));
      refs.push(`${group.session} ${tool.name} [${tool.tags.join(',')}] ${tool.description.split('\n')[0]} -> ${path}`);
    }
    memory.writeFileAtomic('reference/tools.md', refs.join('\n'));
    const historyIndex: string[] = [];
    input.history.forEach((entry, index) => { const path = `history/${index}.md`; memory.writeFileAtomic(path, entry.text); historyIndex.push(`${path} ${entry.id} (${entry.text.length} characters)`); });
    memory.writeFileAtomic('reference/history.md', historyIndex.join('\n') || 'No retained history. Construct source-based scenarios.');
    memory.writeFileAtomic('reference/state-format.md', 'Ordinary continuity text, then ## Action constraints. Each rule: ### stable-id\n- sessions: ["main"]\n- tools: ["actual_tool"]\n- instruction: "observable prohibition"\n- exceptions: ""\nUse tools OR tags, not both. Use exact available tools; keep process guidance in ordinary text.');
    let cases: MigrationCase[] | undefined;
    let document: StateDocument | undefined, revision: string | undefined;
    let replays: MigrationReplay[] = [], previous: { document: StateDocument; check: SourceCheck } | undefined;
    let context: ContextRecord[] = [message('system', MIGRATION_PROMPT), message('user', 'Read the original sources and actual tool references, then write work/STATE.md directly. Sources, history, references and independently generated scenarios are read-only.')];
    const tools = workspaceTools({ memory, prefixResidentFiles: () => [], wholeReadFallbackChars: () => input.readChars,
      readOverride: () => null,
      writeGuard: (_op, path) => path === CANDIDATE ? null : 'Only work/STATE.md is writable; sources, history, references and scenarios are read-only.',
    }).filter(tool => ['read_file', 'list_files', 'glob_files', 'grep_files', 'write_file', 'edit_file', 'append_file'].includes(tool.name));
    const feedback = (value: unknown) => {
      const prefix = '[migration feedback]';
      for (let i = context.length - 1; i >= 0; i--) {
        const item = context[i].item;
        if (item.type === 'message' && item.role === 'user' && textOf(context[i]).startsWith(prefix)) context.splice(i, 1);
      }
      context.push(message('user', prefix + '\n' + JSON.stringify(value)));
    };
    const inspect = async () => {
      if (!memory.exists(CANDIDATE)) return;
      const raw = memory.readFile(CANDIDATE);
      if (raw === revision) return;
      const parsed = parseState(raw);
      if (!parsed.structured || parsed.error || parsed.needsScopeMigration) { feedback({ stage: 'draft', error: parsed.error ?? 'Candidate needs a valid Action constraints section with explicit scopes.' }); return; }
      for (const rule of parsed.constraints) for (const session of rule.scope.sessions!) {
        const available = input.tools.find(group => group.session === session)?.tools ?? [];
        if (!available.some(tool => !tool.tags.includes('flow') && appliesTo(rule, session, tool))) { feedback({ error: `Constraint ${rule.id} matches no tool in ${session}.` }); return; }
        if (rule.scope.tools?.some(name => !input.tools.some(group => group.tools.some(tool => tool.name === name)))) { feedback({ error: `Constraint ${rule.id} has an unknown tool.` }); return; }
      }
      if (!cases) {
        cases = await generateMigrationCases(input, services.llm, services.signal);
        memory.writeFileAtomic(CASES, JSON.stringify({ cases }, null, 2));
      }
      if (parsed.constraints.length && !cases.length) throw new Error('没有生成可用于验证审核约束的来源场景');
      const next: MigrationReplay[] = [];
      for (const sample of cases) {
        if (services.signal.aborted) return;
        const spec = input.tools.find(group => group.session === sample.session)!.tools.find(tool => tool.name === sample.tool)!;
        const applicable = (value: StateDocument) => value.constraints.filter(rule => !bypassesStateReview(spec, sample.args) && appliesTo(rule, sample.session, spec));
        const cached = replays.find(row => row.id === sample.id);
        next.push(cached && document && JSON.stringify(applicable(document)) === JSON.stringify(applicable(parsed))
          ? cached : await replayMigrationCase(input, sample, parsed, services));
      }
      document = { text: parsed.text, constraints: parsed.constraints }; revision = raw; replays = next;
      feedback({ stage: 'revise', cases: replays.length, mismatches: replays.filter(item => item.mismatch),
        outcomes: replays.map(item => ({ id: item.id, source: item.source, expected: item.expected, actual: item.actual, judgments: item.judgments })),
        issues: previous?.check.issues ?? [], next: 'Patch only affected passages with edit_file. Keep source conditions and exceptions. Once usable, consolidate once and finish naturally; the host performs final source checking.' });
    };
    let totalRounds = 0, consolidated = false;
    while (!services.signal.aborted) {
      let rounds = 0;
      const outcome = await runWorker({ core: services.core, llm: services.llm, spec: input.spec, messages: context, tools,
        contextTokens: input.contextTokens, signal: services.signal, label: 'STATE 迁移', log: nullLogger(),
        onBeforeRequest: async (messages, inputTokens) => { context = messages; await inspect(); updateMigrationTimeReminder(messages, input.timing); trimMigrationReadFallback(messages, inputTokens); },
        stopped: () => services.signal.aborted, finished: () => false,
        progress: value => { rounds = Math.max(rounds, value.rounds); services.progress({ rounds: totalRounds + value.rounds, phase: '正在整理' }); },
      });
      totalRounds += rounds;
      if (services.signal.aborted || !['natural', 'ends_turn', 'finish'].includes(outcome.reason)) break;
      await inspect();
      if (!document || !cases || !revision || memory.readFile(CANDIDATE) !== revision) throw new Error('没有形成可验证候选');
      if (!consolidated) { consolidated = true; feedback({ next: 'Perform the one final consolidation now: merge duplicate prohibitions, move workflow guidance to ordinary text, and keep observable content restrictions even when their source uses affirmative wording. If no edit is justified, finish naturally. Modified candidates are replayed automatically.' }); continue; }
      const scope = document.constraints.map(rule => ({ id: rule.id, sessions: input.tools.map(group => ({ session: group.session,
        tools: group.tools.filter(tool => appliesTo(rule, group.session, tool)).map(tool => tool.name) })) }));
      const check = await checkMigrationSources(input, services.llm, services.signal, document, input.sources, scope, [], replays, previous);
      if (document.constraints.length && !replays.some(item => item.rules.length)) check.issues.push({ id: 'no-applicable-replay', kind: 'replay',
        source: cases[0].source.path, quote: cases[0].source.quote, detail: 'No frozen case exercised an applicable constraint in this candidate. Passing unrelated actions does not validate the rules.' });
      for (const row of replays) {
        const finding = check.caseFindings.find(item => item.caseId === row.id);
        if (finding?.kind === 'unrelated' || row.mismatch && (!finding || finding.kind === 'model' && !row.rules.length))
          check.issues.push({ id: `case-${row.id}`, kind: 'replay', source: row.source.path, quote: row.source.quote, caseIds: [row.id],
            detail: finding?.kind === 'unrelated' ? `Case ${row.id} was held by an unrelated rule; the intended source restriction is not implemented.`
              : `Case ${row.id} expected ${row.expected}, got ${row.actual}. Repair the rule/scope or establish a source-backed reference error or decision-model blind spot.` });
      }
      if (check.issues.length) check.ready = false;
      previous = { document: structuredClone(document), check };
      if (check.ready) return { document, reason: replays.some(item => item.mismatch) ? 'diminishing_returns' : 'ready' };
      feedback({ stage: 'focused-repair', issues: check.issues, ignoredIssues: check.ignoredIssues, next: 'Repair these specific source-backed defects using file edits. Cases remain frozen. Finish naturally for a focused recheck of the unresolved issues and changed sections; do not restart a full audit.' });
    }
    throw new Error('没有形成可提交候选：迁移已停止');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
