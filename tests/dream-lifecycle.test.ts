import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoreApi, ForkOptions } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { runForkLoop } from 'cortico/core/fork.ts';
import { TimerStore } from 'cortico/core/timers.ts';
import { LogBlobStore } from 'cortico/core/blobs.ts';
import type { ResponseClient } from 'cortico/core/generation.ts';
import { ResponsesProvider } from 'cortico/providers/openai-responses-compat/native.ts';
import { createServer } from 'node:http';
import { message } from 'cortico/protocol/open-responses/context.ts';
import { FakeLLM, toolReply, makeTool } from '../../Cortico/tests/core/helpers.ts';
import { composeDefaults } from '../index.ts';
import { Dream } from '../persona/subconscious/index.ts';

function createDream(dir: string, llm: ResponseClient, retry = false, delaySec = 0, log = nullLogger()) {
  const cfg = composeDefaults(); cfg.dream.maxRounds = 4; cfg.dream.softRounds = 2;
  Object.assign(cfg.dream, { maxRetries: retry ? 2 : 0, retryDelaySec: delaySec, maxBatches: 1 });
  const emergences: string[] = [];
  const timers = new TimerStore(dir); timers.start();
  const blobs = new LogBlobStore(dir);
  const dream = new Dream({ cfg, dataDir: dir, memoryDir: join(dir, 'memory'), semanticState: () => 'current STATE',
    dreamTools: () => [makeTool('probe', 'ok')], toolUsageText: () => '', log, onEmergence: (text) => emergences.push(text),
    core: { timers, blob: (handle: string) => blobs.read(handle), spawnFork: (options: ForkOptions) => runForkLoop({ ...options, tools: options.tools ?? [], llm, spec: { model: 'fixture', thinking: false },
      maxRounds: cfg.dream.maxRounds, softRounds: cfg.dream.softRounds, log: nullLogger() }), requestContextHandoff: () => true,
      sessionInfo: () => ({ snapshot: [message('system', 'live prefix'), message('user', 'ongoing waking episode')] }) } as unknown as CoreApi,
  });
  timers.onDue((entry) => dream.onRetryDue(entry));
  return { cfg, dream, emergences, timers, blobs };
}

it.each([false, true])('archives unread images after one independent continuation across restart (legacy=%s)', async legacy => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-image-expiry-'));
  const llm = new FakeLLM();
  llm.fallback = () => {
    const receipt = llm.calls.at(-1)!.messages.filter(record => record.role === 'tool').at(-1)?.content ?? '';
    if (!receipt.includes('"items"')) return toolReply([{ name: 'dream_materials', args: {} }]);
    const items = JSON.parse(receipt.split('\n', 1)[0]).items as Array<{ id: string; unreadImages?: unknown[] }>;
    const readable = items.filter(item => !item.unreadImages?.length).map(item => item.id);
    return toolReply([{ name: 'surface', args: { status: readable.length === items.length ? 'complete' : 'partial',
      processedMaterials: readable, pendingTasks: [], text: '' } }]);
  };
  let current = createDream(dir, llm, true);
  const stop = () => { current.dream.stop(); current.timers.stop(); };
  const restart = () => { stop(); current = createDream(dir, llm, true); current.cfg.dream.maxBatches = 3; };
  try {
    current.cfg.dream.maxBatches = 3;
    const bytes = Buffer.alloc(Math.floor(current.cfg.dream.maxInputBytes! * 0.9));
    const handle = current.blobs.put(bytes, 'image/png');
    await current.dream.schedule([message('system', 'prefix'), message('user', 'caption', { blobs: [
      { handle, mime: 'image/png', fallbackText: 'picture' },
    ] }), message('user', 'later material')]);
    const first = current.dream.getStatus();
    expect(first.pendingMaterials).toBe(1);
    expect(first.runs).toHaveLength(2);
    const id = first.runs[0]!.unreadImages![0]!.id;
    const rawPath = join(dir, 'continuity', 'dream', 'raw', id + '.json');
    const raw = readFileSync(rawPath, 'utf8');
    const indexPath = join(dir, 'continuity', 'dream', 'materials.json');
    if (legacy) {
      const rows = JSON.parse(readFileSync(indexPath, 'utf8'));
      for (const row of rows) delete row.deferredImages;
      writeFileSync(indexPath, JSON.stringify(rows));
    }
    restart();
    const initialBytes = current.cfg.dream.maxInputBytes;
    current.cfg.dream.maxInputBytes = 1024;
    const calls = llm.calls.length;
    expect(current.dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(current.dream.getStatus().dreaming).toBe(false));
    expect(llm.calls).toHaveLength(calls);
    expect(current.dream.getStatus().runs[0]).toMatchObject({ inputBudgetExceeded: true });
    restart();
    current.cfg.dream.maxInputBytes = initialBytes;
    llm.script({ role: 'assistant', content: 'unfinished attempt' });
    expect(current.dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(current.dream.getStatus().dreaming).toBe(false));
    expect(current.dream.getStatus()).toMatchObject({ pendingMaterials: 1, archivedUnreadMaterials: 0 });
    expect(current.dream.getStatus().runs[0]!.unreadImages).toHaveLength(1);
    restart();
    expect(current.dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(current.dream.getStatus().dreaming).toBe(false));
    expect(current.dream.getStatus()).toMatchObject({ pendingMaterials: 0, archivedUnreadMaterials: 1 });
    expect(current.dream.getStatus().runs[0]).toMatchObject({ status: 'complete', unreadImages: [],
      archivedImages: [{ id }], processedMaterials: [id] });
    const archived = JSON.parse(readFileSync(indexPath, 'utf8')).find((row: { id: string }) => row.id === id);
    expect(archived.completedAtMs).toBeNull();
    expect(archived.textCompletedAtMs).toEqual(expect.any(Number));
    expect(readFileSync(rawPath, 'utf8')).toBe(raw);
    expect(current.blobs.read(handle)?.bytes.equals(bytes)).toBe(true);
    expect(current.dream.resumePending()).toBe(false);
    await current.dream.schedule([message('system', 'prefix'), message('user', 'new material')]);
    expect(current.dream.getStatus()).toMatchObject({ pendingMaterials: 0, archivedUnreadMaterials: 1 });
    expect(current.dream.getStatus().runs[0]!.materialIds).not.toContain(id);
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});

it('retains a restored image after an unconfirmed dream and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-image-restored-'));
  const llm = new FakeLLM();
  llm.fallback = () => toolReply([{ name: 'surface', args: { status: 'partial', processedMaterials: [], pendingTasks: [], text: '' } }]);
  let current = createDream(dir, llm);
  const stop = () => { current.dream.stop(); current.timers.stop(); };
  try {
    const handle = current.blobs.put(Buffer.alloc(Math.floor(current.cfg.dream.maxInputBytes! * 0.9)), 'image/png');
    await current.dream.schedule([message('system', 'prefix'), message('user', 'caption', { blobs: [
      { handle, mime: 'image/png', fallbackText: 'picture' },
    ] })]);
    expect(current.dream.getStatus().runs[0]!.unreadImages).toHaveLength(1);
    current.cfg.dream.maxInputBytes = current.cfg.dream.maxRequestBytes;
    llm.script({ role: 'assistant', content: 'unfinished attempt' });
    expect(current.dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(current.dream.getStatus().dreaming).toBe(false));
    expect(current.dream.getStatus().runs[0]).toMatchObject({ status: 'interrupted', unreadImages: [] });
    stop(); current = createDream(dir, llm);
    current.cfg.dream.maxInputBytes = current.cfg.dream.maxRequestBytes;
    llm.script(toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]));
    expect(current.dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(current.dream.getStatus().dreaming).toBe(false));
    expect(current.dream.getStatus().runs[0]).toMatchObject({ status: 'complete', unreadImages: [], archivedImages: [] });
    expect(current.dream.getStatus()).toMatchObject({ pendingMaterials: 0, archivedUnreadMaterials: 0 });
    expect(JSON.stringify(llm.calls.at(-1)!.messages)).toContain(handle);
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ['hard-limit', false], ['hard-limit', true], ['provider-error', false], ['provider-error', true],
] as const)('does not backfill an unobserved first image omission (%s, legacy=%s)', async (failure, legacy) => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-unobserved-image-'));
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new ResponsesProvider({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  const llm = new FakeLLM();
  llm.fallback = () => toolReply([{ name: 'surface', args: { status: 'partial', processedMaterials: [], pendingTasks: [], text: '' } }]);
  let current = createDream(dir, failure === 'hard-limit' ? provider : llm);
  const stop = () => { current.dream.stop(); current.timers.stop(); };
  try {
    if (failure === 'hard-limit') current.cfg.dream.maxRequestBytes = 1024;
    else llm.throwNext = new Error('fixture failed before response');
    const bytes = Buffer.alloc(Math.floor(current.cfg.dream.maxInputBytes! * 0.9));
    const handle = current.blobs.put(bytes, 'image/png');
    await current.dream.schedule([message('system', 'prefix'), message('user', 'caption', { blobs: [
      { handle, mime: 'image/png', fallbackText: 'picture' },
    ] })]);
    const first = current.dream.getStatus().runs[0]!;
    expect(first.status).toBe('interrupted');
    expect(first.tools).toEqual([]);
    expect(first.unreadImages).toHaveLength(1);
    if (failure === 'hard-limit') expect(first.requestBodyLimit).toMatchObject({ limitBytes: 1024 });
    else expect(first.error).toContain('fixture failed before response');
    expect(requests).toBe(0);
    const id = first.materialIds[0]!;
    const rawPath = join(dir, 'continuity', 'dream', 'raw', id + '.json');
    const raw = readFileSync(rawPath, 'utf8');
    const indexPath = join(dir, 'continuity', 'dream', 'materials.json');
    if (legacy) {
      const rows = JSON.parse(readFileSync(indexPath, 'utf8'));
      for (const row of rows) delete row.deferredImages;
      writeFileSync(indexPath, JSON.stringify(rows));
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      stop(); current = createDream(dir, llm);
      llm.script(toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]));
      expect(current.dream.resumePending()).toBe(true);
      await vi.waitFor(() => expect(current.dream.getStatus().dreaming).toBe(false));
      expect(current.dream.getStatus()).toMatchObject({ pendingMaterials: 1, archivedUnreadMaterials: 0 });
      expect(current.dream.getStatus().runs[0]).toMatchObject({ status: 'partial', processedMaterials: [],
        unreadImages: [{ id }], archivedImages: [] });
    }
    stop(); current = createDream(dir, llm);
    llm.script(toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]));
    expect(current.dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(current.dream.getStatus().dreaming).toBe(false));
    expect(current.dream.getStatus()).toMatchObject({ pendingMaterials: 0, archivedUnreadMaterials: 1 });
    expect(current.dream.getStatus().runs[0]).toMatchObject({ status: 'complete', archivedImages: [{ id }] });
    const row = JSON.parse(readFileSync(indexPath, 'utf8')).find((row: { id: string }) => row.id === id);
    expect(row.completedAtMs).toBeNull();
    expect(row.textCompletedAtMs).toEqual(expect.any(Number));
    expect(readFileSync(rawPath, 'utf8')).toBe(raw);
    expect(current.blobs.read(handle)?.bytes.equals(bytes)).toBe(true);
    expect(current.dream.resumePending()).toBe(false);
  } finally {
    stop(); rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each(['prefix-bytes', 'prefix-tokens'])('retains materials without retrying an initial %s budget rejection and allows manual resume', async kind => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-input-budget-'));
  const llm = closingModel();
  const { cfg, dream, timers, blobs } = createDream(dir, llm, true);
  const original = { ...cfg.dream };
  try {
    dream.addPendingTask('unfinished consolidation');
    const bytes = Buffer.alloc(Math.floor(cfg.dream.maxInputBytes! * 0.9));
    const handle = blobs.put(bytes, 'image/png');
    const refs: [] = [];
    if (kind === 'prefix-bytes') cfg.dream.maxInputBytes = 1024;
    if (kind === 'prefix-tokens') cfg.dream.maxInputTokens = 8000;
    await dream.schedule([message('system', kind === 'prefix-tokens' ? '前'.repeat(20000) : 'prefix'),
      message('user', 'unconfirmed material', { blobs: refs })]);
    const status = dream.getStatus();
    expect(status).toMatchObject({ pendingMaterials: 1, pendingTasks: ['unfinished consolidation'], retryAt: null,
      runs: [{ status: 'interrupted', processedMaterials: [], inputBudgetExceeded: true }] });
    expect(status.runs).toHaveLength(1);
    expect(llm.calls).toHaveLength(0);
    expect(timers.list()).toEqual([]);
    const raw = JSON.parse(readFileSync(join(dir, 'continuity', 'dream', 'raw', status.runs[0]!.materialIds[0] + '.json'), 'utf8'));
    expect(raw[0].context.blobs).toEqual(refs);
    expect(blobs.read(handle)?.bytes.equals(bytes)).toBe(true);
    Object.assign(cfg.dream, original, { maxInputBytes: original.maxRequestBytes });
    expect(dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(dream.getStatus().dreaming).toBe(false));
    expect(dream.getStatus()).toMatchObject({ pendingMaterials: 0, pendingTasks: [], runs: [
      { status: 'complete' }, { status: 'interrupted' },
    ] });
  } finally { dream.stop(); timers.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it('retains materials at the serialized body hard limit without sending or scheduling a retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-body-hard-limit-'));
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new ResponsesProvider({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
  const { cfg, dream, timers } = createDream(dir, provider, true);
  try {
    cfg.dream.maxRequestBytes = 1024;
    await dream.schedule([message('system', 'prefix'), message('user', 'unconfirmed material')]);
    expect(dream.getStatus()).toMatchObject({ pendingMaterials: 1, retryAt: null, runs: [{
      status: 'interrupted', processedMaterials: [], requestBodyLimit: { limitBytes: cfg.dream.maxRequestBytes },
    }] });
    expect(dream.getStatus().runs).toHaveLength(1);
    expect(dream.getStatus().runs[0]!.error).toContain('hard byte limit');
    expect(requests).toBe(0);
  } finally {
    dream.stop(); timers.stop(); rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('batches persisted image materials and resumes the remaining images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-image-batches-'));
  const llm = closingModel();
  const first = createDream(dir, llm);
  let resumed: ReturnType<typeof createDream> | undefined;
  try {
    first.cfg.dream.maxInputBytes = 2 * 1024 * 1024;
    const handle = first.blobs.put(Buffer.alloc(1024 * 1024), 'image/png');
    const refs = [{ handle, mime: 'image/png', fallbackText: 'picture' }];
    await first.dream.schedule([message('system', 'prefix'), message('user', 'first', { blobs: refs }),
      message('user', 'second', { blobs: refs })]);
    expect(first.dream.getStatus()).toMatchObject({ pendingMaterials: 1, runs: [{ included: 1, omitted: 1 }] });
    const firstIds = first.dream.getStatus().runs[0]!.processedMaterials;
    resumed = createDream(dir, closingModel());
    resumed.cfg.dream.maxInputBytes = first.cfg.dream.maxInputBytes;
    expect(resumed.dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(resumed!.dream.getStatus().dreaming).toBe(false));
    expect(resumed.dream.getStatus()).toMatchObject({ pendingMaterials: 0 });
    expect(resumed.dream.getStatus().runs[0]!.processedMaterials).not.toEqual(firstIds);
    expect(first.blobs.read(handle)?.bytes.byteLength).toBe(1024 * 1024);
  } finally {
    first.dream.stop(); first.timers.stop(); resumed?.dream.stop(); resumed?.timers.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(['all', 'explicit'])('protects omitted images against %s confirmation, processes later material and resumes originals after restart', async confirmation => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-image-omission-'));
  const llm = new FakeLLM();
  let listing: Array<{ id: string; unreadImages?: Array<{ handle?: string }> }> = [];
  const rejections: string[] = [];
  let tried = false;
  let readRequested = false;
  let readImages: unknown;
  llm.fallback = () => {
    const receipt = llm.calls.at(-1)!.messages.filter(message => message.role === 'tool').at(-1)?.content ?? '';
    if (receipt.includes('"items"')) listing = JSON.parse(receipt.split('\n', 1)[0]).items;
    else if (receipt.includes('"totalChars"')) readImages = JSON.parse(receipt.split('\n', 1)[0]).unreadImages;
    else if (receipt.startsWith('[bad input]')) rejections.push(receipt);
    else return toolReply([{ name: 'dream_materials', args: {} }]);
    const unread = listing.filter(item => item.unreadImages?.length);
    const readable = listing.filter(item => !item.unreadImages?.length).map(item => item.id);
    if (!readRequested && unread.length && readable.length) {
      readRequested = true;
      return toolReply([{ name: 'dream_read_material', args: { id: unread[0]!.id, maxChars: 100 } }]);
    }
    if (!tried && unread.length && readable.length) {
      tried = true;
      return toolReply([{ name: 'surface', args: { status: confirmation === 'all' ? 'complete' : 'partial',
        processedMaterials: confirmation === 'all' ? 'all' : [unread[0]!.id], pendingTasks: [], text: '' } }]);
    }
    return toolReply([{ name: 'surface', args: { status: 'partial', processedMaterials: readable, pendingTasks: [], text: '' } }]);
  };
  const { cfg, dream, timers, blobs } = createDream(dir, llm, true);
  let resumed: ReturnType<typeof createDream> | undefined;
  try {
    cfg.dream.maxBatches = 3;
    const bytes = Buffer.alloc(Math.floor(cfg.dream.maxInputBytes! * 0.9));
    const handle = blobs.put(bytes, 'image/png');
    await dream.schedule([message('system', 'prefix'), message('user', 'picture caption', { blobs: [
      { handle, mime: 'image/png', fallbackText: 'picture' },
    ] }), message('user', 'later material')]);
    const status = dream.getStatus();
    expect(status.pendingMaterials).toBe(1);
    expect(status.runs).toHaveLength(2);
    expect(status.runs.every(run => run.status === 'partial' && !run.retryOf)).toBe(true);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain('has unread images');
    const unread = status.runs[0]!.unreadImages![0]!;
    expect(unread.images).toEqual([{ handle, recordIndex: 0 }]);
    expect(readImages).toEqual(unread.images);
    expect(status.runs.flatMap(run => run.processedMaterials)).toEqual([status.runs[1]!.materialIds[1]]);
    expect(status.runs.flatMap(run => run.processedMaterials)).not.toContain(unread.id);
    expect(JSON.stringify(llm.calls[0]!.messages)).toContain('[image not read]');
    expect(llm.calls[0]!.messages.flatMap(message => message.blobs ?? [])).toEqual([]);
    const rawPath = join(dir, 'continuity', 'dream', 'raw', unread.id + '.json');
    const raw = readFileSync(rawPath, 'utf8');
    expect(JSON.parse(raw)[0].context.blobs[0].handle).toBe(handle);
    expect(blobs.read(handle)?.bytes.equals(bytes)).toBe(true);
    expect(timers.list()).toEqual([]);
    resumed = createDream(dir, closingModel());
    expect(resumed.dream.getStatus().pendingMaterials).toBe(1);
    resumed.cfg.dream.maxInputBytes = resumed.cfg.dream.maxRequestBytes;
    expect(resumed.dream.resumePending()).toBe(true);
    await vi.waitFor(() => expect(resumed!.dream.getStatus().dreaming).toBe(false));
    expect(resumed.dream.getStatus().pendingMaterials).toBe(0);
    expect(resumed.dream.getStatus().runs[0]).toMatchObject({ status: 'complete', unreadImages: [] });
    expect(readFileSync(rawPath, 'utf8')).toBe(raw);
  } finally {
    dream.stop(); timers.stop(); resumed?.dream.stop(); resumed?.timers.stop(); rmSync(dir, { recursive: true, force: true });
  }
});
it.each(['filled-caption-budget', 'directory-before-paged-text'])('advances later material past unread images (%s) without confirming images or retrying', async scenario => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-unread-progress-'));
  const llm = new FakeLLM();
  let listing: Array<{ id: string; unreadImages?: unknown[] }> = [];
  const pages = new Map<string, { next: number; total: number; text: string }>();
  const rejections: string[] = [];
  let triedAll = false;
  llm.fallback = () => {
    const receipt = llm.calls.at(-1)!.messages.filter(message => message.role === 'tool').at(-1)?.content ?? '';
    if (receipt.includes('"items"')) listing = JSON.parse(receipt.split('\n', 1)[0]).items;
    else if (receipt.includes('"totalChars"')) {
      const page = JSON.parse(receipt.split('\n', 1)[0]);
      pages.set(page.id, { next: page.next, total: page.totalChars, text: (pages.get(page.id)?.text ?? '') + page.text });
    } else if (receipt.startsWith('[bad input]')) rejections.push(receipt);
    else return toolReply([{ name: 'dream_materials', args: {} }]);
    if (!triedAll && listing.some(item => item.unreadImages?.length)) {
      triedAll = true;
      return toolReply([{ name: 'surface', args: { status: 'complete', processedMaterials: 'all', pendingTasks: [], text: '' } }]);
    }
    const readable = listing.filter(item => !item.unreadImages?.length);
    const next = readable.find(item => !pages.has(item.id) || pages.get(item.id)!.next < pages.get(item.id)!.total);
    if (next) return toolReply([{ name: 'dream_read_material', args: { id: next.id, start: pages.get(next.id)?.next ?? 0, maxChars: 12000 } }]);
    return toolReply([{ name: 'surface', args: { status: 'partial', processedMaterials: readable.map(item => item.id), pendingTasks: [], text: '' } }]);
  };
  const { cfg, dream, timers, blobs } = createDream(dir, llm, true);
  try {
    Object.assign(cfg.dream, { maxBatches: 3, maxRounds: 40, softRounds: 35 });
    const filled = scenario === 'filled-caption-budget';
    if (!filled) cfg.dream.maxInputBytes = 100000;
    const bytes = Buffer.alloc(filled ? 9 * 1024 * 1024 : 100000);
    const handle = blobs.put(bytes, 'image/png');
    const refs = [{ handle, mime: 'image/png', fallbackText: 'image' }];
    const textA = 'A'.repeat(filled ? 300000 : 160000);
    const textB = 'B'.repeat(150000);
    await dream.schedule([message('system', 'prefix'), message('user', textA, { blobs: refs }),
      message('user', textB, { blobs: filled ? refs : [] }), message('user', 'readable C')]);
    const status = dream.getStatus();
    const indexFile = join(dir, 'continuity', 'dream', 'materials.json');
    const materials: Array<{ id: string; completedAtMs: number | null }> = JSON.parse(readFileSync(indexFile, 'utf8'));
    const unread = materials.slice(0, filled ? 2 : 1);
    const readable = materials.slice(filled ? 2 : 1);
    expect(status.pendingMaterials).toBe(unread.length);
    expect(unread.every(material => material.completedAtMs === null)).toBe(true);
    expect(readable.every(material => material.completedAtMs !== null)).toBe(true);
    expect(new Set(status.runs.flatMap(run => run.processedMaterials))).toEqual(new Set(readable.map(material => material.id)));
    expect(status.runs).toHaveLength(filled ? 2 : 3);
    expect(status.runs.every(run => run.status === 'partial' && !run.retryOf)).toBe(true);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain('has unread images');
    if (!filled) expect(pages.get(materials[1]!.id)!.text).toContain(textB);
    expect(pages.get(materials[2]!.id)!.text).toContain('readable C');
    expect(blobs.read(handle)?.bytes.equals(bytes)).toBe(true);
    for (const material of unread) {
      const raw = JSON.parse(readFileSync(join(dir, 'continuity', 'dream', 'raw', material.id + '.json'), 'utf8'));
      expect(raw[0].context.blobs[0].handle).toBe(handle);
    }
    await dream.schedule([message('user', 'new later D')]);
    const updated: Array<{ id: string; completedAtMs: number | null }> = JSON.parse(readFileSync(indexFile, 'utf8'));
    expect(updated.at(-1)!.completedAtMs).not.toBeNull();
    expect(dream.getStatus().pendingMaterials).toBe(unread.length);
    expect(dream.getStatus().runs.every(run => !run.retryOf)).toBe(true);
    expect(timers.list()).toEqual([]);
  } finally { dream.stop(); timers.stop(); rmSync(dir, { recursive: true, force: true }); }
});

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
