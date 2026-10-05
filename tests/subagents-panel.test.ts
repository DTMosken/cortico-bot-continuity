import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { World } from 'cortico/core/types.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { composeDefaults } from '../index.ts';
import { TaskStore, type TaskRecord } from '../persona/subagents/store.ts';
import { subagentsConfig } from '../persona/subagents/config.ts';

const JSDOM_MODULE = new URL('../../Cortico/node_modules/jsdom/lib/api.js', import.meta.url).href;
const UI_MODULE = '../../Cortico/src/web/client/ui/index.ts';
const PANEL_MODULE = '../console/subagents.ts';
const { JSDOM } = await import(JSDOM_MODULE);
const { createConsoleUi } = await import(UI_MODULE);
const { subagentsPanel } = await import(PANEL_MODULE);
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

async function mount(taskCount = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'continuity-subagent-panel-'));
  writeFileSync(join(dir, 'config.json'), '{}\n');
  const cfg = composeDefaults();
  if (taskCount) {
    cfg.subagents = subagentsConfig({ resultPageChars: 2 });
    const store = new TaskStore(join(dir, 'data', 'continuity', 'subagents'));
    for (let index = 0; index < taskCount; index++) {
      const record: TaskRecord = { id: randomUUID(), task: '任务 ' + index, materials: [], tools: [], source: 'world', worldId: 'probe', context: 'main',
        status: 'complete', startedAt: new Date(Date.now() - index * 1000).toISOString(), summary: '已核验', resultChars: 0,
        softRounds: cfg.subagents.softRounds, maxRounds: cfg.subagents.maxRounds, timeoutMs: cfg.subagents.timeoutMs,
        contextTokens: 100000, rounds: 9, peakInputTokens: 2048, estimatedInputTokens: 2000, endReason: 'natural', reminders: [] };
      store.writeResult(record, '正文😀甲乙');
      if (index === 0) store.writeReminder(record, '请核验差异', '证据😀甲乙');
    }
  }
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
  vi.stubGlobal('AbortController', window.AbortController);
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
  const switchFor = (label: string, section = '主线子代理权限') => root.querySelector('[role="switch"][aria-label="' + label + ' ' + section + '"]') as any;
  const workersInput = () => (Array.from(root.querySelectorAll('label')).find((label: any) => label.textContent.includes('同时运行上限')) as any).querySelector('input');
  return { dir, cfg, persona, window, root, button, switchFor, workersInput, poll: () => poll(), leave: () => leave(),
    beforeSave: (fn: () => Promise<void>) => { beforeSave = fn; } };
}

it('shows both permission sets and saves independent World switches with choices intact', async () => {
  const f = await mount();
  expect(f.switchFor('probe_read').getAttribute('aria-checked')).toBe('true');
  expect(f.switchFor('probe_roll').getAttribute('aria-checked')).toBe('false');
  expect(f.switchFor('probe_send').getAttribute('aria-checked')).toBe('false'); expect(f.switchFor('write_file')).toBeNull();
  expect(f.switchFor('仅发送 World')).not.toBeNull();
  expect(f.root.textContent).not.toContain('write_file'); expect(f.root.textContent).toContain('选中 1/3');
  expect(f.switchFor('probe_send', 'World扩展子代理权限').getAttribute('aria-checked')).toBe('true');
  expect(f.leave()).toBeNull(); expect(f.button('保存整页').disabled).toBe(true);
  const card = [...f.root.querySelectorAll('.continuity-subagent-groups .sheet')].find(card => card.textContent?.includes('测试 World'))!;
  card.querySelector('button[aria-expanded]')!.click();
  expect(f.switchFor('probe_read').closest('[hidden]')).toBeNull();
  expect(f.switchFor('probe_send')).not.toBeNull();
  f.switchFor('测试 World').click();
  expect(f.leave()).toContain('未保存'); expect(f.root.textContent).toContain('已暂停');
  f.button('保存整页').click(); await vi.waitFor(() => expect(f.cfg.subagents!.permissions.probe.enabled).toBe(false));
  expect(f.cfg.subagents!.permissions.probe.tools.probe_read).toBe(true); expect(f.leave()).toBeNull();
  f.switchFor('测试 World').click(); f.switchFor('probe_roll').click();
  f.button('保存整页').click(); await vi.waitFor(() => expect(f.leave()).toBeNull());
  const persisted = JSON.parse(readFileSync(join(f.dir, 'config.json'), 'utf8')).subagents.permissions.probe;
  expect(persisted).toEqual({ enabled: true, tools: { probe_read: true, probe_roll: true, probe_send: false } });
  expect(f.root.textContent).toContain('主线说明需手动重载系统前缀');
  f.switchFor('测试 World', 'World扩展子代理权限').click();
  f.button('保存整页').click(); await vi.waitFor(() => expect(f.leave()).toBeNull());
  expect(f.cfg.subagents!.cognitionPermissions.probe.enabled).toBe(false);
  expect(f.cfg.subagents!.permissions.probe.enabled).toBe(true);
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
  const duration = (Array.from(f.root.querySelectorAll('label')).find((label: any) => label.textContent.includes('任务时限 (分钟)')) as any).querySelector('input');
  expect(duration.value).toBe('15'); duration.value = '2'; duration.dispatchEvent(new f.window.Event('input'));
  f.button('保存整页').click(); await vi.waitFor(() => expect(f.cfg.subagents!.timeoutMs).toBe(120000));
  const label = Array.from(f.root.querySelectorAll('label')).find((label: any) => label.textContent.includes('轮数提醒起点')) as any;
  const soft = label.querySelector('input'); soft.value = String(f.cfg.subagents!.maxRounds); soft.dispatchEvent(new f.window.Event('input'));
  expect(f.button('保存整页').disabled).toBe(true); expect(f.root.textContent).toContain('必须小于');
});

it('pages historical tasks and reads paged reminder evidence from real task storage', async () => {
  const f = await mount(21);
  expect(f.root.querySelector('details').open).toBe(false);
  expect(f.root.textContent).toContain('共 21 项');
  expect(f.root.textContent).toContain('模型轮数 9/64');
  const source = f.root.querySelector('.continuity-subagent-filters select');
  source.value = 'main'; source.dispatchEvent(new f.window.Event('change'));
  await vi.waitFor(() => expect(f.root.textContent).toContain('没有符合筛选条件的任务'));
  expect(f.root.textContent).not.toContain('任务 0');
  source.value = 'world'; source.dispatchEvent(new f.window.Event('change'));
  await vi.waitFor(() => expect(f.root.textContent).toContain('任务 0'));
  const focused = f.button('查看结果'); focused.focus(); f.poll();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.window.document.activeElement).toBe(focused);
  const status = f.root.querySelectorAll('.continuity-subagent-filters select')[1];
  status.value = 'running'; status.dispatchEvent(new f.window.Event('change'));
  await vi.waitFor(() => expect(f.root.textContent).toContain('没有符合筛选条件的任务'));
  status.value = 'complete'; status.dispatchEvent(new f.window.Event('change'));
  await vi.waitFor(() => expect(f.root.textContent).toContain('任务 0'));
  f.button('下一页任务').click(); await vi.waitFor(() => expect(f.root.textContent).toContain('任务 20'));
  expect(f.button('下一页任务').disabled).toBe(true);
  f.button('上一页任务').click(); await vi.waitFor(() => expect(f.root.textContent).toContain('1 条提醒'));
  f.button('1 条提醒').click();
  const button = (text: string) => [...f.window.document.querySelectorAll('button')].find((el: any) => el.textContent === text) as any;
  await vi.waitFor(() => expect(button('读取提醒 1')).toBeDefined());
  button('读取提醒 1').click();
  await vi.waitFor(() => expect(f.window.document.body.textContent).toContain('证据'));
  expect([...f.window.document.querySelectorAll('button')].filter((el: any) => el.textContent === '✕ 关闭 (Esc)')).toHaveLength(1);
  expect(f.window.document.body.textContent).not.toContain('正文');
  button('读取下一页').click(); await vi.waitFor(() => expect(f.window.document.body.textContent).toContain('证据😀甲'));
  button('读取下一页').click(); await vi.waitFor(() => expect(f.window.document.body.textContent).toContain('证据😀甲乙'));
  expect(button('读取下一页').disabled).toBe(true);
});
