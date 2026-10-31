import { afterEach, expect, it, vi } from 'vitest';
const JSDOM_MODULE = new URL('../../Cortico/node_modules/jsdom/lib/api.js', import.meta.url).href;
const UI_MODULE = '../../Cortico/src/web/client/ui/index.ts';
const CHECKPOINTS_MODULE = '../webui/checkpoints.ts';
const RESET_MODULE = '../webui/reset.ts';
const { JSDOM } = await import(JSDOM_MODULE);
const { createWebUi } = await import(UI_MODULE);
const { checkpointsPanel } = await import(CHECKPOINTS_MODULE);
const { resetPanel } = await import(RESET_MODULE);
afterEach(() => vi.unstubAllGlobals());

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const status = { available: true, repo: true, dirty: false, head: 'abc', lastCommit: null, tags: ['checkpoint0'] };
const checkpoints = [{ name: 'checkpoint0', message: 'base', hash: 'abc', date: '' }, { name: 'cp1', message: '', hash: 'def', date: '' }];
const partial = {
  ok: false, persona: 'persona 已回滚到 checkpoint「cp1」',
  results: [{ key: 'events', ok: false, result: 'disk full' }, { key: 'session', ok: true, result: 'ok' }],
};

function mount(panel: { mount(ctx: unknown): void }, invoke: (method: string, args?: unknown[]) => Promise<unknown>) {
  const { window } = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
  vi.stubGlobal('AbortController', window.AbortController);
  const controller = new window.AbortController();
  const root = window.document.getElementById('root');
  const base = createWebUi({ doc: window.document, overlayHost: window.document.body, signal: controller.signal,
    memo: { get: <T>(_key: string, fallback: T): T => fallback, set() {} } });
  const drawers: string[] = [];
  const ui = { ...base, confirm: async () => true, drawer: (_title: string, body: string) => { drawers.push(body); return { dispose() {} }; } };
  let loads = 0;
  panel.mount({ root, ui, signal: controller.signal, invoke: (method: string, args?: unknown[]) => {
    if (method === 'state') loads++;
    return invoke(method, args);
  } } as never);
  const button = (text: string, at = 0) => [...root.querySelectorAll('button')].filter((item: any) => item.textContent === text)[at];
  return { root, button, drawers, loads: () => loads, abort: () => controller.abort() };
}

it('keeps a partial rollback failure visible after the checkpoint list reloads', async () => {
  const view = mount(checkpointsPanel, async (method) => {
    if (method === 'state') return { status, checkpoints };
    if (method === 'rollback') return partial;
    throw new Error(`unexpected ${method}`);
  });
  await settle();
  view.button('回滚到此', 1).click();
  await settle();
  expect(view.loads()).toBe(2);
  const msg = view.root.querySelector('.bad');
  expect(msg?.textContent).toContain('部分失败');
  expect(msg?.textContent).toContain('events');
  expect(view.drawers[0]).toContain('✗ events: disk full');
  view.abort();
});

it('keeps create and delete results after the checkpoint list reloads', async () => {
  const view = mount(checkpointsPanel, async (method) => {
    if (method === 'state') return { status, checkpoints };
    if (method === 'create') return { ok: true, result: 'checkpoint「cp2」已创建', state: {} };
    if (method === 'remove') return { ok: true, result: 'checkpoint「cp1」已删除', state: {} };
    throw new Error(`unexpected ${method}`);
  });
  await settle();
  const name = view.root.querySelector('input.mono');
  name.value = 'cp2';
  view.button('创建').click();
  await settle();
  expect(view.root.textContent).toContain('checkpoint「cp2」已创建');
  view.button('删除').click();
  await settle();
  expect(view.loads()).toBe(3);
  expect(view.root.textContent).toContain('checkpoint「cp1」已删除');
  view.abort();
});

it('keeps the reset panel result after it reloads', async () => {
  const view = mount(resetPanel, async (method) => {
    if (method === 'state') return { status, checkpoints, parts: [], ready: true, reason: null };
    if (method === 'run') return partial;
    throw new Error(`unexpected ${method}`);
  });
  await settle();
  view.button('回滚并清空').click();
  await settle();
  expect(view.loads()).toBe(2);
  expect(view.root.querySelector('.bad')?.textContent).toContain('部分失败');
  view.abort();
});
