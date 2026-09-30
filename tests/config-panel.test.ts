import { expect, it, vi, afterEach } from 'vitest';
import { readGroupValues } from 'cortico/core/config-schema.ts';
import { PERSONA_CONFIG_GROUP } from '../persona/config.ts';
import { composeDefaults } from '../index.ts';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContinuityPersona } from '../persona/index.ts';
import { decideFrame } from '../persona/cognition.ts';

const JSDOM_MODULE = new URL('../../Cortico/node_modules/jsdom/lib/api.js', import.meta.url).href;
const UI_MODULE = '../../Cortico/src/web/client/ui/index.ts';
afterEach(() => vi.unstubAllGlobals());
const CONFIG_MODULE = '../console/cognition.ts';
const { JSDOM } = await import(JSDOM_MODULE) as {
  JSDOM: new (html: string, options: { url: string }) => {
    window: { document: any; AbortController: typeof AbortController };
  };
};
const { createConsoleUi } = await import(UI_MODULE);
const { mountCognition: mountConfig } = await import(CONFIG_MODULE);

it('renders the Jev key-file action inside the cognition panel', async () => {
  const { window } = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
  const controller = new window.AbortController();
  const cfg = composeDefaults();
  cfg.appraisal!.provider = 'jev';
  const root = window.document.getElementById('root')!;
  const ui = createConsoleUi({
    doc: window.document, overlayHost: window.document.body, signal: controller.signal,
    memo: { get: <T>(_key: string, fallback: T): T => fallback, set: () => {} },
  });
  await mountConfig({
    root, ui, signal: controller.signal,
    invoke: async (method: string) => {
      if (method === 'options') return [];
      if (method === 'state') return {
        values: readGroupValues(cfg, PERSONA_CONFIG_GROUP),
        provider: 'jev', source: 'typesafe', keySet: false,
      };
      throw new Error(method);
    },
    interval: () => ({ dispose() {} }), guardLeave: () => ({ dispose() {} }),
  } as never);
  expect(root.querySelectorAll('.sheet').length).toBeGreaterThan(0);
  expect(root.textContent).toContain('即时评估来源');
  expect(root.textContent).toContain('打开 TypeSafe 密钥文件');
  expect(root.textContent).not.toContain('Jev 密钥');
  expect(root.textContent).not.toContain('Laya 空闲释放时间');
  expect(root.textContent).not.toContain('自定义 Jev 服务地址');
  expect(root.textContent!.indexOf('即时评估来源')).toBeLessThan(root.textContent!.indexOf('测试连接'));
  expect(root.textContent!.indexOf('测试连接')).toBeLessThan(root.textContent!.indexOf('Jev 来源'));
  expect(root.textContent!.indexOf('Jev 来源')).toBeLessThan(root.textContent!.indexOf('密钥未配置'));
});

it('shows only the selected appraisal settings', async () => {
  const { window } = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
  const controller = new window.AbortController();
  const cfg = composeDefaults();
  const root = window.document.getElementById('root')!;
  const ui = createConsoleUi({
    doc: window.document, overlayHost: window.document.body, signal: controller.signal,
    memo: { get: <T>(_key: string, fallback: T): T => fallback, set: () => {} },
  });
  let source: 'typesafe' | 'openrouter' | 'custom' = 'typesafe';
  const ctx = {
    root, ui, signal: controller.signal,
    invoke: async (method: string) => {
      if (method === 'options') return [];
      if (method === 'state') return {
        values: readGroupValues(cfg, PERSONA_CONFIG_GROUP),
        provider: cfg.appraisal!.provider, source, keySet: false,
      };
      throw new Error(method);
    },
    guardLeave: () => ({ dispose() {} }),
    interval: (callback: () => void) => { poll = callback; return { dispose() {} }; },
  } as never;
  let poll: () => void = () => {};
  await mountConfig(ctx);
  expect(root.textContent).not.toContain('Laya 空闲释放时间');
  expect(root.textContent).not.toContain('Jev 来源');
  cfg.appraisal!.provider = 'laya';
  poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(root.textContent).toContain('Laya 空闲释放时间');
  expect(root.textContent).not.toContain('Jev 来源');
  cfg.appraisal!.provider = 'jev';
  source = 'custom';
  poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(root.textContent).toContain('自定义 Jev 服务地址');
  expect(root.textContent).not.toContain('Laya 空闲释放时间');
});

it('saves each page draft in one request and retains edits made during polling or saving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cognition-ui-'));
  const cfg = composeDefaults();
  cfg.cognition!.blacklist = [{ id: 'existing', label: 'existing rule', enabled: true, match: { world: 'other' } }];
  const observed = { world: 'chat', eventType: 'chat.message', sceneKind: 'group', sceneKey: 'chat:group:1', senderKey: 'a', cursor: 1, ts: '2026-09-30', text: 'hello' };
  mkdirSync(join(dir, 'data', 'continuity'), { recursive: true });
  writeFileSync(join(dir, 'data', 'continuity', 'recent-events.json'), JSON.stringify([observed]));
  writeFileSync(join(dir, 'config.json'), '{}');
  const persona = new ContinuityPersona({ cfg, memoryDir: join(dir, 'memory'), deploymentDir: dir, dataDir: join(dir, 'data') });
  try {
    const { window } = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
    vi.stubGlobal('AbortController', window.AbortController);
    vi.stubGlobal('MutationObserver', (window as any).MutationObserver);
    const controller = new window.AbortController();
    const root = window.document.getElementById('root')!;
    const ui = createConsoleUi({ doc: window.document, overlayHost: window.document.body, signal: controller.signal,
      memo: { get: <T>(_key: string, fallback: T): T => fallback, set() {} } });
    let poll: () => void = () => {}, leave: () => string | null = () => null;
    let saves = 0, release!: () => void, savingStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saving = new Promise<void>((resolve) => { savingStarted = resolve; });
    await mountConfig({ root, ui, signal: controller.signal,
      memo: { get: <T>(_key: string, fallback: T): T => fallback, set() {} }, invoke: async (method: string, args: unknown[]) => {
      if (method === 'saveDraft') saves++;
      const result = await persona.configInvoke('cognition', method, args ?? []);
      if (method === 'saveDraft' && saves === 1) { savingStarted(); await gate; }
      return result;
    }, interval: (callback: () => void) => { poll = callback; return { dispose() {} }; },
      own: (item: any) => { controller.signal.addEventListener('abort', () => item.dispose()); return item; },
      guardLeave: (callback: () => string | null) => { leave = callback; return { dispose() {} }; } } as never);
    const input = [...root.querySelectorAll('label')].find((label: any) => label.textContent.includes('STATE 重复提醒间隔')).querySelector('input');
    input.value = '3'; input.focus(); input.dispatchEvent(new (window as any).Event('input', { bubbles: true }));
    poll(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input.value).toBe('3'); expect(window.document.activeElement).toBe(input); expect(saves).toBe(0); expect(leave()).toBeTruthy();
    const click = (text: string): void => [...window.document.querySelectorAll('button')].find((button: any) => button.textContent === text).click();
    click('添加规则');
    const world = [...window.document.querySelectorAll('label')].find((label: any) => label.textContent === 'World').querySelector('input');
    world.value = 'chat'; world.dispatchEvent(new (window as any).Event('input', { bubbles: true }));
    expect(window.document.body.textContent).toContain('近期 1/1 条命中本规则');
    click('加入页面草稿'); expect(saves).toBe(0);
    click('保存整页'); await saving;
    input.value = '4'; input.dispatchEvent(new (window as any).Event('input', { bubbles: true }));
    expect([...root.querySelectorAll('button')].find((button: any) => button.textContent === '保存整页').disabled).toBe(true);
    click('编辑');
    const name = [...window.document.querySelectorAll('label')].find((label: any) => label.textContent === '名称').querySelector('input');
    name.value = 'edited existing rule'; name.dispatchEvent(new (window as any).Event('input', { bubbles: true }));
    release(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saves).toBe(1);
    expect(root.textContent).not.toContain('保存失败');
    const persisted = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(persisted.cognition.stateReminderBatches).toBe(3);
    expect(decideFrame(observed, persisted.cognition)).toMatchObject({ trigger: false, reason: 'blacklist' });
    expect(cfg.cognition).toEqual(persisted.cognition);
    expect(input.value).toBe('4'); expect(leave()).toBeTruthy();
    click('加入页面草稿');
    click('保存整页'); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saves).toBe(2);
    const final = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).cognition;
    expect(final.stateReminderBatches).toBe(Number(input.value));
    expect(final.blacklist).toHaveLength(2);
    expect(final.blacklist.find((rule: { id: string }) => rule.id === 'existing').label).toBe(name.value);
    expect(decideFrame(observed, final).trigger).toBe(false);
    expect(leave()).toBeNull();
    controller.abort();
  } finally { await persona.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
