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
import { replayMigrationCase, type MigrationCase, type MigrationReplay } from './fixtures.ts';
import { trimMigrationReadFallback, updateMigrationTimeReminder } from './context.ts';
import { MIGRATION_PROMPT, STATE_FORMAT, type MigrationCandidate, type MigrationInput, type MigrationProgress } from './contracts.ts';

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
    const original = input.sources['state/STATE.md'] ?? '';
    memory.writeFileAtomic(CANDIDATE, original);
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
    memory.writeFileAtomic('reference/state-format.md', STATE_FORMAT);
    let cases: MigrationCase[] = [];
    let document: StateDocument | undefined, revision = original;
    let replays: MigrationReplay[] = [], previous: { document: StateDocument; check: SourceCheck; replayed?: boolean } | undefined;
    const cache = new Map<string, { key: string; replay: MigrationReplay }>();
    let context: ContextRecord[] = [message('system', MIGRATION_PROMPT), message('user', 'work/STATE.md starts as an exact copy of the original STATE. Read the sources and actual tool references, then edit this candidate. Sources, history, references and review scenarios are read-only.')];
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
    const inspect = () => {
      if (!memory.exists(CANDIDATE)) return false;
      const raw = memory.readFile(CANDIDATE);
      if (raw === revision) return !!document;
      const parsed = parseState(raw);
      if (!parsed.structured || parsed.error || parsed.needsScopeMigration) {
        feedback({ stage: 'draft', error: parsed.error ?? 'Candidate needs a valid Action constraints section with explicit scopes.', format: STATE_FORMAT }); return false;
      }
      for (const rule of parsed.constraints) for (const session of rule.scope.sessions!) {
        const available = input.tools.find(group => group.session === session)?.tools ?? [];
        if (!available.some(tool => !tool.tags.includes('flow') && appliesTo(rule, session, tool))) { feedback({ error: `Constraint ${rule.id} matches no tool in ${session}.` }); return false; }
        if (rule.scope.tools?.some(name => !input.tools.some(group => group.tools.some(tool => tool.name === name)))) { feedback({ error: `Constraint ${rule.id} has an unknown tool.` }); return false; }
      }
      document = { text: parsed.text, constraints: parsed.constraints }; revision = raw;
      return true;
    };
    const acceptCases = (check: SourceCheck) => {
      let changed = false;
      for (const sample of check.cases ?? []) {
        const index = cases.findIndex(item => item.id === sample.id);
        if (index < 0) { cases.push(sample); changed = true; }
        else if (JSON.stringify(cases[index]) !== JSON.stringify(sample)) { cases[index] = sample; cache.delete(sample.id); changed = true; }
      }
      memory.writeFileAtomic(CASES, JSON.stringify({ cases }, null, 2));
      if (document!.constraints.length && (!cases.some(item => item.expected === 'allow') || !cases.some(item => item.expected === 'remind'))) {
        (check.errors ??= []).push({ id: 'case-coverage', kind: 'reference', detail: 'Provide valid should-allow and should-remind scenarios for the reviewable requirements.' });
        check.ready = false;
      }
      return changed;
    };
    const scope = () => document!.constraints.map(rule => ({ id: rule.id, sessions: input.tools.map(group => ({ session: group.session,
      tools: group.tools.filter(tool => appliesTo(rule, group.session, tool)).map(tool => tool.name) })) }));
    // One review owns its immutable candidate, diff baseline and replay evidence until its response is valid.
    const review = async (rows: MigrationReplay[] = []) => {
      let correction: SourceCheck | undefined, newCases = false;
      while (!services.signal.aborted) {
        const check = await checkMigrationSources(input, services.llm, services.signal, document!, input.sources, scope(), [], rows, previous, cases, correction);
        newCases = acceptCases(check) || newCases;
        if (!check.errors?.some(issue => issue.kind === 'reference')) return { check, newCases };
        correction = check;
      }
      throw new Error('Migration stopped');
    };
    const repair = (check: SourceCheck) => feedback({ stage: 'focused-repair', issues: [...check.issues, ...(check.errors ?? []).filter(issue => issue.kind === 'replay')],
      next: 'Repair source-backed candidate defects with local edits, merging related same-scope rules where conditions and clause-specific exceptions remain intact; keep different scopes separate. Cases are read-only; the reviewer repairs their reported errors. Finish naturally for replay and focused review.' });
    let totalRounds = 0, runActor = true;
    while (!services.signal.aborted) {
      if (runActor) {
        let rounds = 0;
        const outcome = await runWorker({ core: services.core, llm: services.llm, spec: input.spec, messages: context, tools,
          contextTokens: input.contextTokens, signal: services.signal, label: 'STATE 迁移', log: nullLogger(),
          onBeforeRequest: async (messages, inputTokens) => { context = messages; inspect(); updateMigrationTimeReminder(messages, input.timing); trimMigrationReadFallback(messages, inputTokens); },
          stopped: () => services.signal.aborted, finished: () => false,
          progress: value => { rounds = Math.max(rounds, value.rounds); services.progress({ rounds: totalRounds + value.rounds, phase: '正在整理' }); },
        });
        totalRounds += rounds;
        if (services.signal.aborted || !['natural', 'ends_turn', 'finish'].includes(outcome.reason)) break;
        if (!inspect()) { if (!document && memory.readFile(CANDIDATE) === original) throw new Error('没有形成可验证候选'); continue; }
      }
      if (!document) throw new Error('没有形成可验证候选');
      if (!previous) {
        const { check: initial } = await review();
        previous = { document: structuredClone(document), check: initial, replayed: false };
        if (!initial.ready) { repair(initial); continue; }
        if (initial.ready && !cases.length) return { document, reason: 'ready' };
      }
      replays = [];
      for (const sample of cases) {
        if (services.signal.aborted) throw new Error('Migration stopped');
        const spec = input.tools.find(group => group.session === sample.session)!.tools.find(tool => tool.name === sample.tool)!;
        const rules = document.constraints.filter(rule => !bypassesStateReview(spec, sample.args) && appliesTo(rule, sample.session, spec));
        const key = JSON.stringify({ sample, rules }), cached = cache.get(sample.id);
        const replay = cached?.key === key ? cached.replay : await replayMigrationCase(input, sample, document, services);
        cache.set(sample.id, { key, replay }); replays.push(replay);
      }
      const { check, newCases } = await review(replays);
      if (!newCases && document.constraints.length && cases.length && !replays.some(item => item.rules.length)) check.errors!.push({ id: 'no-applicable-replay', kind: 'replay',
        source: cases[0].source.path, quote: cases[0].source.quote, detail: 'No case exercised an applicable constraint; unrelated allowed actions do not validate the rules.' });
      for (const row of replays) {
        if (!cache.has(row.id)) continue;
        const finding = check.caseFindings.find(item => item.caseId === row.id);
        if (finding?.kind === 'unrelated' || row.mismatch && (!finding || finding.kind === 'model' && !row.rules.length))
          check.errors!.push({ id: `case-${row.id}`, kind: 'replay', source: row.source.path, quote: row.source.quote, caseIds: [row.id],
            detail: finding?.kind === 'unrelated' ? `Case ${row.id} was held by an unrelated rule; the intended source requirement is not implemented.`
              : `Case ${row.id} expected ${row.expected}, got ${row.actual}. Repair the rule/scope or establish a source-backed reference error or decision-model blind spot.` });
      }
      if (check.issues.length || check.errors!.length) check.ready = false;
      previous = { document: structuredClone(document), check, replayed: !newCases };
      if (check.ready && !newCases) return { document, reason: replays.some(item => item.mismatch) ? 'diminishing_returns' : 'ready' };
      runActor = !check.ready;
      if (runActor) repair(check);
    }
    throw new Error('没有形成可提交候选：迁移已停止');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
