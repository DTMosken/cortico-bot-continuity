import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from 'cortico/core/core.ts';
import type { CoreApi } from 'cortico/core/types.ts';
import { message, record } from 'cortico/protocol/open-responses/context.ts';
import { FakeLLM, makeCfg, makeFakeHarnessApi, makeTool, textReply, toolReply } from '../../Cortico/tests/core/helpers.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { DREAM } from '../persona/subconscious/index.ts';
import { createDreamRuntime } from '../persona/subconscious/runtime.ts';

class ObservedPersona extends ContinuityPersona {
  observedApi!: CoreApi;
  override attach(api: CoreApi): void { this.observedApi = api; super.attach(api); }
}

it.each(['complete', 'failed', 'context overflow', 'stopped'])('counts a running Dream and releases the count after %s', async outcome => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-running-count-'));
  const cfg = makeCfg(); Object.assign(cfg.dream, { maxRetries: 0 });
  const persona = new ObservedPersona({ memoryDir: join(dir, 'memory'), cfg, worlds: [] });
  const llm = new FakeLLM();
  const running: number[] = [];
  llm.fallback = () => {
    running.push(persona.observedApi.sessionInfo(DREAM).running);
    if (outcome === 'failed') throw new Error('fixture failure');
    if (outcome === 'context overflow') throw new Error('context_length_exceeded');
    if (outcome === 'stopped') persona.dream.stop();
    return toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
  };
  const core = new Core({ config: cfg, rootDir: dir, memoryDir: persona.memoryDir, dataDir: join(dir, 'data'), secret: () => '' },
    { persona, worlds: [], llm });
  persona.setSubagentsRuntime(core);
  try {
    expect(persona.observedApi.sessionInfo(DREAM).running).toBe(0);
    await persona.dream.schedule([message('user', 'material')]);
    expect(running).toEqual([1]);
    expect(persona.observedApi.sessionInfo(DREAM).running).toBe(0);
    expect(persona.observedApi.sessionInfo('main').running).toBe(0);
    expect(core.sessions.list().find(session => session.role === DREAM)!.endedAt).not.toBeNull();
    expect(persona.dream.getStatus().runs[0].status).toBe(outcome === 'complete' ? 'complete' : 'interrupted');
  } finally { await core.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it('adds Dream execution to an existing native fork count and releases each independently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-concurrent-count-'));
  const cfg = makeCfg(); Object.assign(cfg.dream, { maxRetries: 0 });
  const persona = new ObservedPersona({ memoryDir: join(dir, 'memory'), cfg, worlds: [] });
  const llm = new FakeLLM();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const respond = llm.respond.bind(llm);
  let first = true;
  llm.respond = async (request, options) => {
    if (first) { first = false; await held; }
    return respond(request, options);
  };
  const core = new Core({ config: cfg, rootDir: dir, memoryDir: persona.memoryDir, dataDir: join(dir, 'data'), secret: () => '' },
    { persona, worlds: [], llm });
  persona.setSubagentsRuntime(core);
  const native = persona.observedApi.spawnFork({ id: DREAM, messages: [message('user', 'native material')], tools: [] });
  const running: number[] = [];
  llm.fallback = () => {
    running.push(persona.observedApi.sessionInfo(DREAM).running);
    return toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
  };
  try {
    expect(persona.observedApi.sessionInfo(DREAM).running).toBe(1);
    await persona.dream.schedule([message('user', 'material')]);
    expect(running).toEqual([2]);
    expect(persona.observedApi.sessionInfo(DREAM).running).toBe(1);
    llm.fallback = () => textReply('finished');
    release(); await native;
    expect(persona.observedApi.sessionInfo(DREAM).running).toBe(0);
  } finally { llm.fallback = () => textReply('finished'); release(); await native; await core.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  { maxRounds: 3, softRounds: 3, warnings: [0, 0, 2] },
  { maxRounds: 4, softRounds: 1, warnings: [0, 2, 2, 2] },
  { maxRounds: 1, softRounds: 1, warnings: [0] },
])('warns on every receipt in the clamped soft round without an extra model round ($maxRounds/$softRounds)', async ({ maxRounds, softRounds, warnings }) => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-wrap-up-'));
  const cfg = makeCfg(); Object.assign(cfg.dream, { maxRounds, softRounds });
  const llm = new FakeLLM();
  llm.fallback = () => toolReply([{ name: 'probe', args: {} }, { name: 'probe', args: {} }]);
  const api = makeFakeHarnessApi({ llm });
  const memory = new GitWorkspaceMemory({ memoryDir: dir });
  try {
    await createDreamRuntime(api, cfg, memory.blobs, () => null, () => 'Fixture consolidation').fork({
      id: DREAM, messages: [message('user', 'material')], tools: [makeTool('probe', 'read result')], wrapUpHint: 'Finish this consolidation.',
    }, () => {});
    expect(llm.calls).toHaveLength(maxRounds);
    expect(llm.calls.map(call => call.messages.filter(entry => entry.role === 'tool' && entry.content?.includes('Finish this consolidation.')).length)).toEqual(warnings);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([false, true])('uses the declared Dream label in session telemetry (custom=%s)', async custom => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-session-label-'));
  const cfg = makeCfg(); Object.assign(cfg.dream, { maxRetries: 0 });
  const persona = new ContinuityPersona({ memoryDir: join(dir, 'memory'), cfg, worlds: [] });
  if (custom) {
    const declarations = persona.declareSessions.bind(persona);
    persona.declareSessions = () => declarations().map(session => session.id === DREAM ? { ...session, label: 'Fixture consolidation' } : session);
  }
  const llm = new FakeLLM();
  llm.script(toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]));
  const core = new Core({ config: cfg, rootDir: dir, memoryDir: persona.memoryDir, dataDir: join(dir, 'data'), secret: () => '' },
    { persona, worlds: [], llm });
  persona.setSubagentsRuntime(core);
  try {
    await persona.dream.schedule([message('user', 'material')]);
    const session = core.sessions.list().find(session => session.role === DREAM)!;
    expect(session.label).toBe(persona.declareSessions().find(session => session.id === DREAM)!.label);
    expect(session.calls).toBeGreaterThan(0);
    expect(session.endedAt).not.toBeNull();
    expect(persona.dream.getStatus().runs[0]).toMatchObject({ status: 'complete' });
  } finally { await core.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([false, true])('runs Dream after attaching CoreApi without a Bot onStart hook (image=%s)', async image => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-attached-api-'));
  const cfg = makeCfg(); Object.assign(cfg.dream, { maxRetries: 0 });
  const memory = new GitWorkspaceMemory({ memoryDir: dir });
  const llm = new FakeLLM();
  llm.fallback = () => {
    const receipt = llm.calls.at(-1)!.messages.filter(entry => entry.role === 'tool').at(-1)?.content ?? '';
    if (!receipt.includes('"items"')) {
      if (receipt.includes('[blob ')) return toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
      return toolReply([{ name: 'dream_materials', args: {} }]);
    }
    const items = JSON.parse(receipt.split('\n', 1)[0]).items;
    if (image) return toolReply([{ name: 'read_file', args: { path: items[0].unreadImages[0].handle.slice(4) } }]);
    return toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
  };
  const persona = new ContinuityPersona({ memoryDir: dir, cfg, worlds: [] });
  try {
    persona.attach(makeFakeHarnessApi({ llm, blob: handle => memory.blobs.get(handle) }));
    const source = image ? record({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'caption' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
    ] }) : message('user', 'material');
    await persona.dream.schedule([source]);
    expect(persona.dream.getStatus()).toMatchObject({ pendingMaterials: 0 });
    expect(persona.dream.getStatus().runs[0]).toMatchObject({ status: 'complete', unreadImages: [] });
    expect(llm.calls.length).toBeGreaterThan(0);
  } finally { persona.dream.stop(); persona.stopSubagents(); await persona.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
