import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from 'cortico/core/types.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { composeDefaults } from '../index.ts';

const JSDOM_MODULE = new URL('../../Cortico/node_modules/jsdom/lib/api.js', import.meta.url).href;
const UI_MODULE = '../../Cortico/src/web/client/ui/index.ts';
const PANEL_MODULE = '../console/subagents.ts';
const { JSDOM } = await import(JSDOM_MODULE);
const { createConsoleUi } = await import(UI_MODULE);
const { subagentsPanel } = await import(PANEL_MODULE);
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

async function mount() {
  const dir = mkdtempSync(join(tmpdir(), 'continuity-subagent-panel-'));
  writeFileSync(join(dir, 'config.json'), '{}\n');
  const cfg = composeDefaults();
  const world: World = { id: 'probe', start: async () => {}, stop: async () => {}, envPromptVars: () => null,
    console: () => ({ label: '测试 World' }),
    tools: () => [
      { name: 'probe_read', description: 'Read a record.', parameters: {}, tags: ['read'], handler: async () => 'record' },
      { name: 'probe_roll', description: 'Perform a roll.', parameters: {}, tags: ['act'], handler: async () => 'roll' },
      { name: 'probe_send', description: 'Send a message.', parameters: {}, tags: ['speak'], handler: async () => 'sent' },
    ],
  };
  const sendingOnly: World = { id: 'sending-only', start: async () => {}, stop: async () => {}, envPromptVars: () => null,
    console: () => ({ label: '仅发送 World' }),
    tools: () => [{ name: 'sending_only_send', description: 'Send a message.', parameters: {}, tags: ['speak'], handler: async () => 'sent' }],
  };
  const persona = new ContinuityPersona({ memoryDir: join(dir, 'memory'), deploymentDir: dir, cfg, worlds: [world, sendingOnly] });
  const { window } = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
  const controller = new window.AbortController(); const root = window.document.getElementById('root')!;
  const ui = createConsoleUi({ doc: window.document, overlayHost: window.document.body, signal: controller.signal,
    memo: { get: <T>(_key: string, fallback: T): T => fallback, set: () => {} } });
  let poll = () => {}; let leave = (): string | null => null;
  let beforeSave = async () => {};
  await subagentsPanel.mount({ root, ui, signal: controller.signal,
    invoke: async (method: string, args: unknown[] = []) => { if (method === 'saveDraft') await beforeSave(); return persona.subagentsInvoke(method, args); },
    interval: (fn: () => void) => { poll = fn; return { dispose() {} }; },
    guardLeave: (fn: () => string | null) => { leave = fn; return { dispose() {} }; },
  } as never);
  cleanups.push(() => { controller.abort(); persona.dispose(); window.close(); rmSync(dir, { recursive: true, force: true }); });
  const button = (label: string) => Array.from(root.querySelectorAll('button')).find((button: any) => button.textContent === label) as any;
  const switchFor = (label: string) => root.querySelector('[role="switch"][aria-label="' + label + ' 子代理权限"]') as any;
  const workersInput = () => (Array.from(root.querySelectorAll('label')).find((label: any) => label.textContent.includes('同时运行上限')) as any).querySelector('input');
  return { dir, cfg, persona, window, root, button, switchFor, workersInput, poll: () => poll(), leave: () => leave(),
    beforeSave: (fn: () => Promise<void>) => { beforeSave = fn; } };
}

it('shows only delegable tools and saves World switches with individual choices intact', async () => {
  const f = await mount();
  expect(f.switchFor('probe_read').getAttribute('aria-checked')).toBe('true');
  expect(f.switchFor('probe_roll').getAttribute('aria-checked')).toBe('false');
  expect(f.switchFor('probe_send')).toBeNull(); expect(f.switchFor('write_file')).toBeNull();
  expect(f.switchFor('仅发送 World')).toBeNull();
  expect(f.root.textContent).not.toContain('probe_send'); expect(f.root.textContent).not.toContain('write_file');
  expect(f.root.textContent).toContain('选中 1/2');
  const card = [...f.root.querySelectorAll('.continuity-subagent-groups .sheet')].find(card => card.textContent?.includes('测试 World'))!;
  card.querySelector('button[aria-expanded]')!.click();
  expect(f.switchFor('probe_read').closest('[hidden]')).toBeNull();
  expect(f.switchFor('probe_send')).toBeNull();
  f.switchFor('测试 World').click();
  expect(f.leave()).toContain('未保存'); expect(f.root.textContent).toContain('已暂停');
  f.button('保存整页').click(); await vi.waitFor(() => expect(f.cfg.subagents!.permissions.probe.enabled).toBe(false));
  expect(f.cfg.subagents!.permissions.probe.tools.probe_read).toBe(true); expect(f.leave()).toBeNull();
  f.switchFor('测试 World').click(); f.switchFor('probe_roll').click();
  f.button('保存整页').click(); await vi.waitFor(() => expect(f.leave()).toBeNull());
  const persisted = JSON.parse(readFileSync(join(f.dir, 'config.json'), 'utf8')).subagents.permissions.probe;
  expect(persisted).toEqual({ enabled: true, tools: { probe_read: true, probe_roll: true, probe_send: false } });
  expect(f.root.textContent).toContain('主线说明需手动重载系统前缀');
});

it('keeps unsaved switches during polling and edits made while a save is pending', async () => {
  const f = await mount();
  f.switchFor('probe_read').click(); f.poll();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.switchFor('probe_read').getAttribute('aria-checked')).toBe('false');
  let release!: () => void;
  f.beforeSave(() => new Promise<void>(resolve => { release = resolve; }));
  f.button('保存整页').click();
  f.switchFor('probe_roll').click(); release();
  await vi.waitFor(() => expect(f.cfg.subagents!.permissions.probe.tools.probe_read).toBe(false));
  expect(f.cfg.subagents!.permissions.probe.tools.probe_roll).toBe(false);
  expect(f.switchFor('probe_roll').getAttribute('aria-checked')).toBe('true'); expect(f.leave()).toContain('未保存');
  f.beforeSave(async () => {}); f.button('保存整页').click(); await vi.waitFor(() => expect(f.leave()).toBeNull());
  expect(f.cfg.subagents!.permissions.probe.tools.probe_roll).toBe(true);
});

it('renders current scalar configuration from declarations and refuses conflicting round budgets', async () => {
  const f = await mount();
  expect(f.workersInput().value).toBe(String(f.cfg.subagents!.maxWorkers));
  f.workersInput().value = '2'; f.workersInput().dispatchEvent(new f.window.Event('input'));
  f.button('保存整页').click(); await vi.waitFor(() => expect(f.cfg.subagents!.maxWorkers).toBe(2));
  const label = Array.from(f.root.querySelectorAll('label')).find((label: any) => label.textContent.includes('收尾提示轮次')) as any;
  const soft = label.querySelector('input'); soft.value = String(f.cfg.subagents!.maxRounds); soft.dispatchEvent(new f.window.Event('input'));
  expect(f.button('保存整页').disabled).toBe(true); expect(f.root.textContent).toContain('必须小于');
});
