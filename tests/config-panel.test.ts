import { expect, it, vi, afterEach } from 'vitest';
import { readGroupValues } from 'cortico/core/config-schema.ts';
import { OPENROUTER_LUNA_MODEL, PERSONA_CONFIG_GROUP } from '../persona/config.ts';
import { composeDefaults } from '../index.ts';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContinuityPersona } from '../persona/index.ts';
import { Appraiser } from '../persona/appraisal.ts';
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

it.each([false, true])('saves the draft before testing and skips the request after save failure (%s)', async (failSave) => {
  const dir = mkdtempSync(join(tmpdir(), 'save-test-ui-'));
  const cfg = composeDefaults();
  cfg.appraisal!.jev.source = 'openrouter'; cfg.appraisal!.jev.allowRemoteText = true;
  writeFileSync(join(dir, 'config.json'), '{}');
  let requests = 0;
  const appraiser = new Appraiser(cfg.appraisal!, { getEnv: () => 'test-key', requestJev: async (request) => {
    requests++;
    const persisted = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    if (request.model !== 'decision/fast' || persisted.appraisal.jev.model !== request.model) throw new Error('wrong saved model');
    return { answers: { initiative: { noul: 0.5 }, topicPersistence: { noul: 0.5 }, playfulness: { noul: 0.5 } } };
  } });
  const persona = new ContinuityPersona({ cfg, appraiser, memoryDir: join(dir, 'memory'), deploymentDir: dir, dataDir: join(dir, 'data') });
  try {
    const { window } = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
    const controller = new window.AbortController();
    const root = window.document.getElementById('root')!;
    const ui = createConsoleUi({ doc: window.document, overlayHost: window.document.body, signal: controller.signal,
      memo: { get: <T>(_key: string, fallback: T): T => fallback, set() {} } });
    await mountConfig({ root, ui, signal: controller.signal,
      invoke: (method: string, args: unknown[]) => {
        if (method === 'saveDraft' && failSave) throw new Error('write failed');
        return persona.configInvoke('cognition', method, args ?? []);
      }, interval: () => ({ dispose() {} }), guardLeave: () => ({ dispose() {} }),
    } as never);
    const test = [...root.querySelectorAll('button')].find((button: any) => button.textContent === '保存并测试');
    expect(test.disabled).toBe(true);
    const provider = [...root.querySelectorAll('label')].find((label: any) => label.textContent.includes('即时评估方式')).querySelector('select');
    provider.value = 'jev'; provider.dispatchEvent(new (window as any).Event('change', { bubbles: true }));
    const model = root.querySelector('input[list="continuity-decision-models"]');
    model.value = 'decision/fast'; model.dispatchEvent(new (window as any).Event('input', { bubbles: true }));
    expect(test.disabled).toBe(false);
    expect(cfg.appraisal!.provider).toBe('random');
    test.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toBe(failSave ? 0 : 1);
    expect(root.textContent).toContain(failSave ? '保存失败：write failed' : '连接成功');
    expect(test.disabled).toBe(false);
    if (failSave) {
      expect(cfg.appraisal!.provider).toBe('random');
      expect(model.value).toBe('decision/fast');
      expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({});
    } else {
      expect(cfg.appraisal!.provider).toBe('jev');
      expect(cfg.appraisal!.jev.model).toBe('decision/fast');
    }
    controller.abort();
  } finally { await persona.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

it('offers service model presets and persists an edited model with the page draft', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-ui-'));
  const cfg = composeDefaults();
  cfg.appraisal!.provider = 'jev'; cfg.appraisal!.jev.source = 'openrouter';
  writeFileSync(join(dir, 'config.json'), '{}');
  const persona = new ContinuityPersona({ cfg, memoryDir: join(dir, 'memory'), deploymentDir: dir, dataDir: join(dir, 'data') });
  try {
    const { window } = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
    const controller = new window.AbortController();
    const root = window.document.getElementById('root')!;
    const ui = createConsoleUi({ doc: window.document, overlayHost: window.document.body, signal: controller.signal,
      memo: { get: <T>(_key: string, fallback: T): T => fallback, set() {} } });
    let poll: () => void = () => {};
    await mountConfig({ root, ui, signal: controller.signal,
      invoke: (method: string, args: unknown[]) => persona.configInvoke('cognition', method, args ?? []),
      interval: (callback: () => void) => { poll = callback; return { dispose() {} }; },
      guardLeave: () => ({ dispose() {} }),
    } as never);
    const presets = [...root.querySelectorAll('datalist option')].map((option: any) => option.value);
    expect(presets).toContain(OPENROUTER_LUNA_MODEL);
    const edit = (value: string): void => {
      const input = root.querySelector('input[list="continuity-decision-models"]');
      input.value = value; input.dispatchEvent(new (window as any).Event('input', { bubbles: true }));
    };
    const save = async (): Promise<void> => {
      [...root.querySelectorAll('button')].find((button: any) => button.textContent === '保存整页').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    edit(OPENROUTER_LUNA_MODEL);
    poll(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector('input[list="continuity-decision-models"]').value).toBe(OPENROUTER_LUNA_MODEL);
    await save();
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).appraisal.jev.model).toBe(OPENROUTER_LUNA_MODEL);
    edit('decision/fast'); await save();
    expect(cfg.appraisal!.jev.model).toBe('decision/fast');
    expect(cfg.appraisal!.jev.source).toBe('openrouter');
    expect(root.textContent).toContain('打开 OpenRouter 密钥文件');
    controller.abort();
  } finally { await persona.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

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
  expect(root.textContent).toContain('即时评估方式');
  expect(root.textContent).toContain('打开 TypeSafe 密钥文件');
  expect(root.textContent).not.toContain('Jev 密钥');
  expect(root.textContent).not.toContain('Laya 空闲释放时间');
  expect(root.textContent).not.toContain('自定义决策服务地址');
  expect(root.textContent).not.toContain('连接测试使用已保存配置');
  expect(root.textContent).not.toContain('实验值按当前消息生成');
  expect(root.textContent!.indexOf('即时评估方式')).toBeLessThan(root.textContent!.indexOf('保存并测试'));
  expect(root.textContent!.indexOf('保存并测试')).toBeLessThan(root.textContent!.indexOf('决策服务'));
  expect(root.textContent!.indexOf('决策服务')).toBeLessThan(root.textContent!.indexOf('密钥未配置'));
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
  expect(root.textContent).not.toContain('决策服务');
  cfg.appraisal!.provider = 'laya';
  poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(root.textContent).toContain('Laya 空闲释放时间');
  expect(root.textContent).not.toContain('决策服务');
  cfg.appraisal!.provider = 'jev';
  source = 'custom';
  poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(root.textContent).toContain('自定义决策服务地址');
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
