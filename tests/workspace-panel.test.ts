import { afterEach, expect, it, vi } from 'vitest';
const JSDOM_MODULE = new URL('../../Cortico/node_modules/jsdom/lib/api.js', import.meta.url).href;
const UI_MODULE = '../../Cortico/src/web/client/ui/index.ts';
const PANEL_MODULE = '../base/webui/workspace.ts';
const { JSDOM } = await import(JSDOM_MODULE);
const { createWebUi } = await import(UI_MODULE);
const { createWorkspacePanel } = await import(PANEL_MODULE);
afterEach(() => vi.unstubAllGlobals());

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it('asks before leaving unsaved edits when a new file is created', async () => {
  const { window } = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
  vi.stubGlobal('AbortController', window.AbortController);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  const controller = new window.AbortController();
  const root = window.document.getElementById('root');
  const base = createWebUi({ doc: window.document, overlayHost: window.document.body, signal: controller.signal,
    memo: { get: <T>(_key: string, fallback: T): T => fallback, set() {} } });
  const confirms: string[] = [];
  const ui = { ...base, confirm: async (opts: { title: string }) => { confirms.push(opts.title); return false; } };
  const files: Record<string, string> = { 'a.md': 'saved' };
  const invoke = async (method: string, args: unknown[] = []) => {
    if (method === 'tree') return { root: '/deploy/memory', nodes: Object.keys(files).map(path => ({ name: path, path, type: 'file', size: 1 })) };
    if (method === 'read') return { path: args[0], content: files[args[0] as string], revision: 'r', size: 1, mtime: null };
    if (method === 'write') { files[args[0] as string] = args[1] as string; return { ok: true, result: 'created', revision: 'r2' }; }
    throw new Error(`unexpected ${method}`);
  };
  createWorkspacePanel().mount({ root, ui, signal: controller.signal, invoke, guardLeave: () => ({ dispose() {} }),
    memo: { get: <T>(_key: string, fallback: T): T => fallback, set() {} } } as never);
  await settle();
  root.querySelector('.treerow[data-path="a.md"]').click();
  await settle();
  const editor = root.querySelector('textarea');
  editor.value = 'unsaved edit';
  const button = (host: any, text: string) => [...host.querySelectorAll('button')].find((item: any) => item.textContent === text);
  button(root, '新建').click();
  const drawer = window.document.body;
  const name = [...drawer.querySelectorAll('input')].find((input: any) => input.placeholder === '文件名.md');
  name.value = 'b.md';
  button(drawer, '创建').click();
  await settle(); await settle();
  expect(files['b.md']).toBe('');
  expect(confirms).toEqual(['放弃未保存的改动?']);
  expect(editor.value).toBe('unsaved edit');
  expect(root.querySelector('.ct-path').textContent).toContain('a.md');
  controller.abort();
});
