import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoreApi } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { runForkLoop } from 'cortico/core/fork.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import { FakeLLM, toolReply, makeTool } from '../../Cortico/tests/core/helpers.ts';
import { composeDefaults } from '../index.ts';
import { Dream } from '../persona/subconscious/index.ts';

function createDream(dir: string, llm: FakeLLM) {
  const cfg = composeDefaults(); cfg.dream.maxRounds = 4; cfg.dream.softRounds = 2;
  const emergences: string[] = [];
  const dream = new Dream({ cfg, dataDir: dir, memoryDir: join(dir, 'memory'), semanticState: () => 'current STATE',
    dreamTools: () => [makeTool('probe', 'ok')], toolUsageText: () => '', log: nullLogger(), onEmergence: (text) => emergences.push(text),
    core: { spawnFork: (options) => runForkLoop({ ...options, tools: options.tools ?? [], llm, spec: { model: 'fixture', thinking: false },
      maxRounds: cfg.dream.maxRounds, softRounds: cfg.dream.softRounds, log: nullLogger() }), requestContextHandoff: () => true } as CoreApi,
  });
  return { dream, emergences };
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
