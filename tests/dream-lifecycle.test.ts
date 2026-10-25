import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoreApi, ForkOptions } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { runForkLoop } from 'cortico/core/fork.ts';
import { TimerStore } from 'cortico/core/timers.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import { FakeLLM, toolReply, makeTool } from '../../Cortico/tests/core/helpers.ts';
import { composeDefaults } from '../index.ts';
import { Dream } from '../persona/subconscious/index.ts';

function createDream(dir: string, llm: FakeLLM, retry = false, delaySec = 0, log = nullLogger()) {
  const cfg = composeDefaults(); cfg.dream.maxRounds = 4; cfg.dream.softRounds = 2;
  Object.assign(cfg.dream, { maxRetries: retry ? 2 : 0, retryDelaySec: delaySec, maxBatches: 1 });
  const emergences: string[] = [];
  const timers = new TimerStore(dir); timers.start();
  const dream = new Dream({ cfg, dataDir: dir, memoryDir: join(dir, 'memory'), semanticState: () => 'current STATE',
    dreamTools: () => [makeTool('probe', 'ok')], toolUsageText: () => '', log, onEmergence: (text) => emergences.push(text),
    core: { timers, spawnFork: (options: ForkOptions) => runForkLoop({ ...options, tools: options.tools ?? [], llm, spec: { model: 'fixture', thinking: false },
      maxRounds: cfg.dream.maxRounds, softRounds: cfg.dream.softRounds, log: nullLogger() }), requestContextHandoff: () => true,
      sessionInfo: () => ({ snapshot: [message('system', 'live prefix'), message('user', 'ongoing waking episode')] }) } as unknown as CoreApi,
  });
  timers.onDue((entry) => dream.onRetryDue(entry));
  return { cfg, dream, emergences, timers };
}
function closingModel(status: 'complete' | 'partial' = 'complete'): FakeLLM {
  const llm = new FakeLLM();
  llm.fallback = () => {
    const receipt = llm.calls.at(-1)!.messages.at(-1)!;
    if (receipt.role !== 'tool' || !receipt.content?.includes('"items"')) return toolReply([{ name: 'dream_materials', args: {} }]);
    // Core can append a round-budget reminder after the single-line JSON listing.
    const ids = JSON.parse(receipt.content.split('\n', 1)[0]).items.map((item: { id: string }) => item.id);
    return toolReply([{ name: 'surface', args: { status, processedMaterials: status === 'complete' ? ids : ids.slice(0, 1),
      pendingTasks: status === 'complete' ? [] : ['review older evidence'], text: '' } }]);
  };
  return llm;
}

it.each([0, 1])('confirms a partial dream when the material listing reaches the budget warning after %i earlier tools', async earlierTools => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-listing-warning-'));
  const llm = closingModel('partial');
  if (earlierTools) llm.script(toolReply([{ name: 'probe' }]));
  const { cfg, dream, timers } = createDream(dir, llm);
  cfg.dream.softRounds = earlierTools + 1;
  try {
    await dream.schedule([message('system', 'prefix'), message('user', 'one'), message('user', 'two')]);
    expect(dream.getStatus()).toMatchObject({ pendingMaterials: 1, runs: [{
      status: 'partial', processedMaterials: [expect.any(String)], pendingTasks: ['review older evidence'],
    }] });
  } finally { dream.stop(); timers.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ['continuity/dream/runs.json', '{broken'],
  ['continuity/dream/context.json', '{broken'],
  ['memory/note/dream-pending.json', '{broken'],
  ['continuity/dream/runs.json', '[null]'],
  ['continuity/dream/context.json', '{"system":null,"background":7}'],
  ['memory/note/dream-pending.json', '{"pendingTasks":null}'],
])('recovers from damaged %s and keeps its original contents (%s)', async (relative, damaged) => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-damaged-'));
  const errors: unknown[] = [];
  const log = nullLogger(); log.error = (message, data) => { errors.push({ message, data }); };
  const first = createDream(dir, closingModel('partial'), false, 0, log);
  let restarted: ReturnType<typeof createDream> | undefined;
  try {
    await first.dream.schedule([message('system', 'inherited prefix'), message('user', 'one'), message('user', 'two')]);
    const initial = first.dream.getStatus();
    expect(initial, JSON.stringify({ initial, errors }, null, 2)).toMatchObject({
      pendingMaterials: 1, runs: [{ status: 'partial', processedMaterials: [expect.any(String)] }],
    });
    first.dream.stop(); first.timers.stop();
    const file = join(dir, relative);
    writeFileSync(file, damaged);
    restarted = createDream(dir, closingModel());
    expect(restarted.dream.getStatus().pendingMaterials).toBe(1);
    const parent = join(file, '..');
    const name = relative.split('/').at(-1)!;
    const backups = readdirSync(parent).filter((entry) => entry.startsWith(name + '.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(parent, backups[0]!), 'utf8')).toBe(damaged);
    expect(restarted.dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(restarted!.dream.getStatus().dreaming).toBe(false));
    expect(restarted.dream.getStatus()).toMatchObject({ pendingMaterials: 0, pendingTasks: [], runs: [
      expect.objectContaining({ status: 'complete' }),
      ...(relative.endsWith('runs.json') ? [] : [expect.objectContaining({ status: 'partial' })]),
    ] });
  } finally {
    first.dream.stop(); first.timers.stop(); restarted?.dream.stop(); restarted?.timers.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['continuity/dream/runs.json', 'continuity/dream/context.json', 'memory/note/dream-pending.json'])(
  'logs unreadable %s without blocking construction or removing the path', (relative) => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-unreadable-'));
    try {
      const file = join(dir, relative);
      mkdirSync(file, { recursive: true });
      const warnings: unknown[] = [];
      const log = nullLogger(); log.warn = (_message, data) => { warnings.push(data); };
      const { dream, timers } = createDream(dir, closingModel(), false, 0, log);
      expect(dream.getStatus()).toMatchObject({ runs: [], pendingTasks: [] });
      expect(warnings).toEqual([expect.objectContaining({ file, err: expect.any(String) })]);
      expect(readdirSync(file)).toEqual([]);
      dream.stop(); timers.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);

it('complete closure accepts all and retains explicit completed IDs across restart without waking main', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-surface-all-'));
  try {
    const llm = new FakeLLM();
    llm.script(toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]));
    const { dream, emergences } = createDream(dir, llm);
    await dream.schedule([message('system', 'prefix'), message('user', 'one'), message('user', 'two')]);
    const state = dream.getStatus();
    expect(state).toMatchObject({ pendingMaterials: 0, pendingTasks: [] });
    expect(state.runs[0]!.status).toBe('complete');
    expect(state.runs[0]!.processedMaterials).toHaveLength(2);
    expect(state.runs[0]!.processedMaterials).toEqual(state.runs[0]!.materialIds);
    expect(emergences).toEqual([]);
    const restarted = createDream(dir, closingModel());
    expect(restarted.dream.getStatus()).toMatchObject({ pendingMaterials: 0, runs: [{
      status: 'complete', processedMaterials: state.runs[0]!.materialIds,
    }] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  { name: 'complete progress with remaining tasks', status: 'complete', processedMaterials: 'all', pendingTasks: ['unfinished review'] },
  { name: 'an unknown material shorthand', status: 'complete', processedMaterials: 'everything', pendingTasks: [] },
])('rejects $name without completing materials or waking main', async ({ status, processedMaterials, pendingTasks }) => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-surface-invalid-'));
  try {
    const llm = new FakeLLM();
    llm.script(toolReply([{ name: 'surface', args: { status, processedMaterials, pendingTasks, text: 'unconfirmed summary' } }]));
    const { dream, emergences } = createDream(dir, llm);
    await dream.schedule([message('system', 'prefix'), message('user', 'one'), message('user', 'two')]);
    expect(dream.getStatus()).toMatchObject({ pendingMaterials: 2, pendingTasks: [], runs: [{
      status: 'interrupted', processedMaterials: [],
    }] });
    expect(emergences).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  { name: 'missing status', change: () => ({ status: undefined }), reason: 'status must be "complete" or "partial"' },
  { name: 'invalid status', change: () => ({ status: 'done' }), reason: 'status must be "complete" or "partial"' },
  { name: 'missing materials', change: () => ({ processedMaterials: undefined }), reason: 'processedMaterials must be an array of full material IDs' },
  { name: 'invalid shorthand', change: () => ({ processedMaterials: 'everything' }), reason: 'processedMaterials must be an array of full material IDs' },
  { name: 'non-string ID', change: () => ({ processedMaterials: [7] }), reason: 'processedMaterials[0] must be a string' },
  { name: 'unknown ID', change: () => ({ processedMaterials: ['unknown-material'] }), reason: 'processedMaterials[0] "unknown-material" is outside this dream' },
  { name: 'missing tasks', change: () => ({ pendingTasks: undefined }), reason: 'pendingTasks must be an array of strings describing only unfinished Memory consolidation work; use [] when no consolidation work remains' },
  { name: 'too many tasks', change: () => ({ pendingTasks: Array(201).fill('remaining') }), reason: 'pendingTasks has 201 items; maximum is 200' },
  { name: 'non-string task', change: () => ({ pendingTasks: [7] }), reason: 'pendingTasks[0] must be a string' },
  { name: 'long task', change: () => ({ pendingTasks: ['x'.repeat(2001)] }), reason: 'pendingTasks[0] has 2001 characters; maximum is 2000' },
  { name: 'missing text', change: () => ({ text: undefined }), reason: 'text must be a string; use "" for no emergence' },
  { name: 'long text', change: () => ({ text: 'x'.repeat(8001) }), reason: 'text has 8001 characters; maximum is 8000' },
  { name: 'incomplete material coverage', change: (ids: string[]) => ({ processedMaterials: [ids[0], ids[0]] }), reason: 'complete requires all 2 materials; processed 1, missing 1' },
  { name: 'remaining tasks on complete', change: () => ({ pendingTasks: ['unfinished review'] }), reason: 'complete requires pendingTasks: []; received entries: 1. pendingTasks is only for unfinished Memory consolidation work. Use [] when none remains; use status "partial" while consolidation work remains' },
])('explains $name and allows corrected closure without losing materials', async ({ change, reason }) => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-surface-repair-'));
  let dream: Dream | undefined;
  let timers: TimerStore | undefined;
  try {
    const llm = new FakeLLM();
    let rejection = '';
    llm.script(toolReply([{ name: 'dream_materials', args: {} }]));
    llm.fallback = () => {
      const receipt = llm.calls.at(-1)!.messages.filter((msg) => msg.role === 'tool').at(-1)!;
      if (llm.calls.length === 2) {
        const ids: string[] = JSON.parse(receipt.content!).items.map((item: { id: string }) => item.id);
        return toolReply([{ name: 'surface', args: {
          status: 'complete', processedMaterials: 'all', pendingTasks: [], text: 'unconfirmed summary', ...change(ids),
        } }]);
      }
      rejection = receipt.content!;
      expect(dream!.getStatus()).toMatchObject({ pendingMaterials: 2, pendingTasks: [] });
      const materials: Array<{ completedAtMs: number | null }> = JSON.parse(readFileSync(join(dir, 'continuity', 'dream', 'materials.json'), 'utf8'));
      expect(materials.every((item) => item.completedAtMs === null)).toBe(true);
      return toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
    };
    const fixture = createDream(dir, llm);
    ({ dream, timers } = fixture);
    await dream.schedule([message('system', 'prefix'), message('user', 'one'), message('user', 'two')]);
    expect(rejection).toContain('[bad input] ' + reason);
    expect(dream.getStatus()).toMatchObject({ pendingMaterials: 0, pendingTasks: [], runs: [{ status: 'complete' }] });
    expect(fixture.emergences).toEqual([]);
  } finally { dream?.stop(); timers?.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it('all completes only the active dream materials while waiting handoffs remain for the next dream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-surface-queue-'));
  let release!: () => void;
  let scheduled: Promise<void>[] = [];
  let dream: Dream | undefined;
  try {
    const llm = new FakeLLM();
    llm.fallback = () => toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = new Promise<void>((resolve) => { started = resolve; });
    const chat = llm.chat.bind(llm); let first = true;
    llm.chat = async (...args) => { if (first) { first = false; started(); await gate; } return chat(...args); };
    const fixture = createDream(dir, llm);
    fixture.cfg.dream.maxBatches = 3;
    ({ dream } = fixture);
    scheduled.push(dream.schedule([message('system', 'prefix'), message('user', 'one')]));
    await running;
    scheduled.push(dream.schedule([message('system', 'prefix'), message('user', 'two')]));
    scheduled.push(dream.schedule([message('system', 'prefix'), message('user', 'three')]));
    release(); await Promise.all(scheduled);
    const state = dream.getStatus();
    expect(state.pendingMaterials).toBe(0);
    expect(state.runs.map((run) => ({ status: run.status, processed: run.processedMaterials.length, materials: run.materialIds.length })))
      .toEqual([{ status: 'complete', processed: 2, materials: 2 }, { status: 'complete', processed: 1, materials: 1 }]);
    for (const run of state.runs) expect(run.processedMaterials).toEqual(run.materialIds);
    expect(state.runs[0]!.processedMaterials).not.toContain(state.runs[1]!.materialIds[0]);
  } finally {
    release?.(); dream?.stop(); await Promise.all(scheduled);
    rmSync(dir, { recursive: true, force: true });
  }
});

it('drains bounded oldest batches after confirmed progress and leaves later work pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-drain-'));
  const llm = new FakeLLM();
  llm.fallback = () => toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
  const { cfg, dream, timers } = createDream(dir, llm);
  Object.assign(cfg.dream, { maxInputTokens: 8000, maxBatches: 2 });
  try {
    await dream.schedule([message('system', 'prefix'), ...['old', 'middle', 'new'].map(label => message('user', label + ' episode '.repeat(1800)))]);
    const runs = [...dream.getStatus().runs].reverse();
    expect(runs).toHaveLength(cfg.dream.maxBatches!);
    expect(runs.map(run => run.materialIds.length)).toEqual([1, 1]);
    expect(runs.every(run => run.status === 'complete' && run.processedMaterials.length === 1)).toBe(true);
    const materials = JSON.parse(readFileSync(join(dir, 'continuity', 'dream', 'materials.json'), 'utf8'));
    expect(runs.map(run => run.materialIds[0])).toEqual(materials.slice(0, 2).map((item: { id: string }) => item.id));
    expect(dream.getStatus().pendingMaterials).toBe(1);
    expect(dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(dream.getStatus().dreaming).toBe(false));
    expect(dream.getStatus().pendingMaterials).toBe(0);
  } finally { dream.stop(); timers.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it('accepts all batch materials with remaining tasks and stops continuation without progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-partial-all-'));
  const llm = new FakeLLM();
  llm.fallback = () => toolReply([{ name: 'surface', args: { status: 'partial', processedMaterials: 'all', pendingTasks: ['consolidate older notes'], text: '' } }]);
  const { cfg, dream, timers } = createDream(dir, llm);
  cfg.dream.maxBatches = 3;
  try {
    await dream.schedule([message('system', 'prefix'), message('user', 'one'), message('user', 'two')]);
    expect(dream.getStatus()).toMatchObject({ pendingMaterials: 0, pendingTasks: ['consolidate older notes'], runs: [{ status: 'partial' }] });
    llm.fallback = () => toolReply([{ name: 'surface', args: { status: 'partial', processedMaterials: [], pendingTasks: ['need more time'], text: '' } }]);
    await dream.schedule([message('system', 'prefix'), message('user', 'three')]);
    expect(dream.getStatus()).toMatchObject({ pendingMaterials: 1, runs: [{ processedMaterials: [] }, { status: 'partial' }] });
  } finally { dream.stop(); timers.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it('partial closure survives restart, retains pending materials and does not automatically continue or wake main', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-resume-'));
  try {
    const first = createDream(dir, closingModel('partial'));
    await first.dream.schedule([message('system', 'prefix'), message('user', 'older episode'), message('user', 'recent episode')]);
    expect(first.dream.getStatus()).toMatchObject({ dreaming: false, pendingMaterials: 1, pendingTasks: ['review older evidence'] });
    expect(first.dream.getStatus().runs).toHaveLength(1); expect(first.emergences).toEqual([]);
    const restarted = createDream(dir, closingModel());
    expect(restarted.dream.getStatus().pendingTasks).toEqual(['review older evidence']);
    await restarted.dream.schedule([message('system', 'prefix'), message('user', 'next episode')]);
    expect(restarted.dream.getStatus()).toMatchObject({ pendingMaterials: 0, pendingTasks: [] });
    expect(restarted.dream.getStatus().runs[0]!.status).toBe('complete'); expect(restarted.emergences).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'memory', 'note', 'dream-pending.json'), 'utf8')).pendingTasks).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('retries an unconfirmed fork using the same originals and records the interrupted attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-retry-'));
  try {
    const llm = closingModel();
    llm.script({ role: 'assistant', content: 'stopped before consolidation' });
    const { dream, emergences } = createDream(dir, llm, true);
    await dream.schedule([message('system', 'prefix'), message('user', 'episode')]);
    const state = dream.getStatus();
    expect(state).toMatchObject({ dreaming: false, pendingMaterials: 0 });
    expect(state.runs.map((run) => run.status)).toEqual(['complete', 'interrupted']);
    expect(state.runs[0]!.materialIds).toEqual(state.runs[1]!.materialIds);
    expect(state.runs[0]).toMatchObject({ retryOf: state.runs[1]!.id, retryAttempt: 1 });
    expect(emergences).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('limits repeated interruptions, retains materials and resumes them after restart without adding waking messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-retry-cap-'));
  try {
    const interrupted = new FakeLLM(); interrupted.fallback = () => ({ role: 'assistant', content: 'no confirmation' });
    const first = createDream(dir, interrupted, true);
    await first.dream.schedule([message('system', 'inherited prefix'), message('user', 'original episode')]);
    expect(first.dream.getStatus().runs).toHaveLength(3);
    expect(first.dream.getStatus().pendingMaterials).toBe(1);
    const ids = first.dream.getStatus().runs[0]!.materialIds;
    const llm = closingModel(); const resumed = createDream(dir, llm);
    expect(resumed.dream.resumePending()).toBe(true);
    expect(resumed.dream.resumePending()).toBe(false);
    await vi.waitFor(() => expect(resumed.dream.getStatus().dreaming).toBe(false));
    expect(resumed.dream.getStatus().runs[0]).toMatchObject({ status: 'complete', materialIds: ids });
    expect(llm.calls[0]!.messages[0]!.content).toBe('inherited prefix');
    expect(JSON.stringify(llm.calls)).not.toContain('ongoing waking episode');
    expect(resumed.dream.getStatus().pendingMaterials).toBe(0);
    expect(resumed.dream.resumePending()).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('cancels a delayed retry on shutdown and keeps the unconfirmed originals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-retry-stop-'));
  try {
    const llm = new FakeLLM(); llm.fallback = () => ({ role: 'assistant', content: 'no confirmation' });
    const { dream } = createDream(dir, llm, true, 60);
    const scheduled = dream.schedule([message('system', 'prefix'), message('user', 'episode')]);
    await vi.waitFor(() => expect(dream.getStatus().retryAt).toEqual(expect.any(String)));
    dream.stop(); await scheduled;
    expect(llm.calls).toHaveLength(1);
    expect(dream.getStatus()).toMatchObject({ dreaming: false, retryAt: null, pendingMaterials: 1 });
    expect(dream.resumePending()).toBe(false);
    await dream.schedule([message('system', 'prefix'), message('user', 'after shutdown')]);
    expect(dream.getStatus().pendingMaterials).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('does not start a retry while Core timers are stopped before the Persona stop hook', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'dream-core-stop-'));
  try {
    const llm = new FakeLLM(); llm.fallback = () => ({ role: 'assistant', content: 'no confirmation' });
    const { dream, timers } = createDream(dir, llm, true, 60);
    const scheduled = dream.schedule([message('system', 'prefix'), message('user', 'episode')]);
    await vi.waitFor(() => expect(dream.getStatus().retryAt).toEqual(expect.any(String)));
    timers.stop();
    await vi.advanceTimersByTimeAsync(61000);
    expect(llm.calls).toHaveLength(1);
    dream.stop(); await scheduled;
    expect(timers.list()).toEqual([]);
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('returns to idle with materials retained when the shared wake timers are cleared', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'dream-timers-cleared-'));
  try {
    const llm = closingModel(); llm.script({ role: 'assistant', content: 'no confirmation' });
    const { dream, timers } = createDream(dir, llm, true, 60);
    const scheduled = dream.schedule([message('system', 'prefix'), message('user', 'episode')]);
    await vi.waitFor(() => expect(dream.getStatus().retryAt).toEqual(expect.any(String)));
    timers.clearAll();
    await vi.advanceTimersByTimeAsync(1000); await scheduled;
    expect(llm.calls).toHaveLength(1);
    expect(dream.getStatus()).toMatchObject({ dreaming: false, retryAt: null, pendingMaterials: 1 });
    expect(dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(dream.getStatus().dreaming).toBe(false));
    expect(dream.getStatus().pendingMaterials).toBe(0);
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('retries provider exceptions but does not retry confirmed partial progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-retry-error-'));
  try {
    const llm = closingModel('partial');
    const chat = llm.chat.bind(llm); let first = true;
    llm.chat = async (...args) => { if (first) { first = false; throw new Error('connection interrupted'); } return chat(...args); };
    const { dream } = createDream(dir, llm, true);
    await dream.schedule([message('system', 'prefix'), message('user', 'one'), message('user', 'two')]);
    expect(dream.getStatus().runs.map((run) => run.status)).toEqual(['partial', 'interrupted']);
    expect(dream.getStatus().runs[1]!.error).toContain('connection interrupted');
    expect(dream.getStatus().pendingMaterials).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('merges two waiting handoffs into one later dream without changing the active material set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-queue-'));
  try {
    const llm = closingModel();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = new Promise<void>((resolve) => { started = resolve; });
    const chat = llm.chat.bind(llm); let first = true;
    llm.chat = async (...args) => { if (first) { first = false; started(); await gate; } return chat(...args); };
    const { dream } = createDream(dir, llm);
    const one = dream.schedule([message('system', 'prefix'), message('user', 'one')]);
    await running;
    expect(dream.getStatus().runs[0]!.elapsedMs).toEqual(expect.any(Number));
    const two = dream.schedule([message('system', 'prefix'), message('user', 'two')]);
    const three = dream.schedule([message('system', 'prefix'), message('user', 'three')]);
    expect(dream.getStatus().queued).toBe(2);
    release(); await Promise.all([one, two, three]);
    expect(dream.getStatus().runs.map((run) => run.materialIds.length)).toEqual([2, 1]);
    expect(dream.getStatus().runs.map((run) => run.status)).toEqual(['complete', 'complete']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('hard cap executes no extra summary request and keeps unconfirmed originals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-cap-'));
  try {
    const llm = new FakeLLM(); llm.fallback = () => toolReply([{ name: 'probe' }]);
    const { dream } = createDream(dir, llm);
    await dream.schedule([message('system', 'prefix'), message('user', 'episode')]);
    expect(llm.calls).toHaveLength(4);
    expect(llm.calls[2]!.messages.at(-1)!.content).toContain('Budget warning');
    expect(dream.getStatus()).toMatchObject({ pendingMaterials: 1 });
    expect(dream.getStatus().runs[0]!.status).toBe('interrupted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
