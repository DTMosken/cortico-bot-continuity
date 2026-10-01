import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

function createDream(dir: string, llm: FakeLLM, retry = false, delaySec = 0) {
  const cfg = composeDefaults(); cfg.dream.maxRounds = 4; cfg.dream.softRounds = 2;
  Object.assign(cfg.dream, { maxRetries: retry ? 2 : 0, retryDelaySec: delaySec });
  const emergences: string[] = [];
  const timers = new TimerStore(dir); timers.start();
  const dream = new Dream({ cfg, dataDir: dir, memoryDir: join(dir, 'memory'), semanticState: () => 'current STATE',
    dreamTools: () => [makeTool('probe', 'ok')], toolUsageText: () => '', log: nullLogger(), onEmergence: (text) => emergences.push(text),
    core: { timers, spawnFork: (options: ForkOptions) => runForkLoop({ ...options, tools: options.tools ?? [], llm, spec: { model: 'fixture', thinking: false },
      maxRounds: cfg.dream.maxRounds, softRounds: cfg.dream.softRounds, log: nullLogger() }), requestContextHandoff: () => true,
      sessionInfo: () => ({ snapshot: [message('system', 'live prefix'), message('user', 'ongoing waking episode')] }) } as unknown as CoreApi,
  });
  timers.onDue((entry) => dream.onRetryDue(entry));
  return { dream, emergences, timers };
}
function closingModel(status: 'complete' | 'partial' = 'complete'): FakeLLM {
  const llm = new FakeLLM();
  llm.fallback = () => {
    const receipt = llm.calls.at(-1)!.messages.at(-1)!;
    if (receipt.role !== 'tool' || !receipt.content?.includes('"items"')) return toolReply([{ name: 'dream_materials', args: {} }]);
    const ids = JSON.parse(receipt.content).items.map((item: { id: string }) => item.id);
    return toolReply([{ name: 'surface', args: { status, processedMaterials: status === 'complete' ? ids : ids.slice(0, 1),
      pendingTasks: status === 'complete' ? [] : ['review older evidence'], text: '' } }]);
  };
  return llm;
}

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
