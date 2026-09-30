import { expect, it, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeDefaults } from '../index.ts';
import { ContinuityPersona } from '../persona/index.ts';
import type { FrameRule } from '../persona/cognition.ts';

const { JSDOM } = await import(new URL('../../Cortico/node_modules/jsdom/lib/api.js', import.meta.url).href);
const UI_MODULE = '../../Cortico/src/web/client/ui/index.ts';
const PANEL_MODULE = '../console/cognition.ts';
const { createConsoleUi } = await import(UI_MODULE);
const { mountCognition } = await import(PANEL_MODULE);
afterEach(() => vi.unstubAllGlobals());

async function fixture(blacklist: FrameRule[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cognition-preview-'));
  const cfg = composeDefaults(); cfg.cognition!.blacklist = blacklist;
  const events = Array.from({ length: 210 }, (_, index) => ({ cursor: index + 1,
    world: index < 20 ? 'chat' : 'dungeon', eventType: index < 20 ? 'chat.message' : 'dungeon.chat',
    sceneKind: 'scene', sceneKey: 'scene:1', senderKey: 'Alice', ts: '2026-09-30', text: 'message ' + (index + 1) }));
  mkdirSync(join(dir, 'data', 'continuity'), { recursive: true });
  writeFileSync(join(dir, 'data', 'continuity', 'recent-events.json'), JSON.stringify(events));
  writeFileSync(join(dir, 'config.json'), '{}');
  const persona = new ContinuityPersona({ cfg, memoryDir: join(dir, 'memory'), deploymentDir: dir, dataDir: join(dir, 'data') });
  const storage = new Map<string, unknown>();
  const memo = { get: <T>(key: string, fallback: T): T => storage.has(key) ? storage.get(key) as T : fallback,
    set: (key: string, value: unknown) => { storage.set(key, value); } };
  async function mount() {
    const { window } = new JSDOM('<!doctype html><body><main id="root"></main></body>', { url: 'http://localhost' });
    vi.stubGlobal('AbortController', window.AbortController);
    vi.stubGlobal('MutationObserver', window.MutationObserver);
    const controller = new window.AbortController();
    const root = window.document.getElementById('root')!;
    const ui = createConsoleUi({ doc: window.document, overlayHost: window.document.body, signal: controller.signal, memo });
    let poll = () => {};
    await mountCognition({ root, ui, signal: controller.signal, memo,
      invoke: (method: string, args: unknown[]) => persona.configInvoke('cognition', method, args ?? []),
      interval: (callback: () => void) => { poll = callback; return { dispose() {} }; },
      own: (item: any) => { controller.signal.addEventListener('abort', () => item.dispose()); return item; },
      guardLeave: () => ({ dispose() {} }),
    } as never);
    const click = (text: string) => [...window.document.querySelectorAll('button')].find((button: any) => button.textContent === text)!.click();
    const input = (field: string, value: string) => {
      const element = window.document.querySelector('[data-condition="' + field + '"] input[type="text"]')!;
      element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true })); return element;
    };
    const mode = (field: string) => {
      const select = window.document.querySelector('[data-condition="' + field + '"] select')!;
      select.value = 'regex'; select.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    return { root, window, controller, poll: () => poll(), click, input, mode };
  }
  return { cfg, dir, persona, memo, mount, dispose: async () => { await persona.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('groups the latest 200 by World and type, retains folds on polls and remounts, and pages within a type', async () => {
  const f = await fixture([{ id: 'd', label: 'blocked', enabled: true, match: { world: 'dungeon' } }]);
  try {
    const panel = await f.mount();
    const groups = [...panel.root.querySelectorAll('[data-preview-group]')];
    expect(groups).toHaveLength(4);
    const world = groups.find((el: any) => el.dataset.previewGroup === '["dungeon"]')!;
    const type = groups.find((el: any) => el.dataset.previewGroup === '["dungeon","dungeon.chat"]')!;
    expect(world.open).toBe(true); expect(type.open).toBe(false);
    expect(type.querySelector('summary')!.textContent).toContain('190 条 · 触发 0 · 屏蔽 190');
    expect(panel.root.textContent).toContain('chat · 10 条');
    expect([...type.querySelectorAll('[data-cursor]')].map((el: any) => Number(el.dataset.cursor))).toEqual([210, 209, 208, 207, 206, 205, 204, 203, 202, 201]);
    type.open = true; await settle();
    panel.click('再显示 10 条（剩余 180）');
    expect(type.querySelectorAll('[data-cursor]')).toHaveLength(20);
    panel.poll(); await settle();
    expect([...panel.root.querySelectorAll('[data-preview-group]')].find((el: any) => el.dataset.previewGroup === '["dungeon","dungeon.chat"]')).toBe(type);
    expect(type.open).toBe(true); expect(type.querySelectorAll('[data-cursor]')).toHaveLength(20);
    const triggerFilter = panel.root.querySelector('[data-preview-filter="trigger"] input')!;
    const blockedFilter = panel.root.querySelector('[data-preview-filter="blocked"] input')!;
    expect(triggerFilter.checked).toBe(true); expect(blockedFilter.checked).toBe(true);
    blockedFilter.click();
    expect(panel.root.textContent).toContain('chat · 10 条 · 触发 10 · 屏蔽 0');
    expect([...panel.root.querySelectorAll('[data-preview-group]')].some((el: any) => el.dataset.previewGroup === '["dungeon"]')).toBe(false);
    triggerFilter.click(); expect(panel.root.textContent).toContain('当前筛选没有消息');
    blockedFilter.click();
    expect(panel.root.textContent).toContain('dungeon · 190 条 · 触发 0 · 屏蔽 190');
    expect(panel.root.querySelector('[data-preview-group]')!.textContent).not.toContain('chat · 10 条');
    triggerFilter.click();
    expect([...panel.root.querySelectorAll('[data-preview-group]')].find((el: any) => el.dataset.previewGroup === '["dungeon","dungeon.chat"]')).toBe(type);
    expect(type.open).toBe(true); expect(type.querySelectorAll('[data-cursor]')).toHaveLength(20);
    panel.controller.abort();
    const next = await f.mount();
    expect(next.root.querySelector('[data-preview-filter="trigger"] input')!.checked).toBe(true);
    expect(next.root.querySelector('[data-preview-filter="blocked"] input')!.checked).toBe(true);
    const nextType = [...next.root.querySelectorAll('[data-preview-group]')].find((el: any) => el.dataset.previewGroup === '["dungeon","dungeon.chat"]')!;
    expect(nextType.open).toBe(true);
    next.click('全部折叠'); await settle();
    expect([...next.root.querySelectorAll('[data-preview-group]')].every((el: any) => !el.open)).toBe(true);
    next.click('全部展开'); await settle();
    expect([...next.root.querySelectorAll('[data-preview-group]')].every((el: any) => el.open)).toBe(true);
    next.controller.abort();
    const other = await fixture();
    try {
      other.memo.set = f.memo.set; other.memo.get = f.memo.get;
      const separate = await other.mount();
      expect([...separate.root.querySelectorAll('[data-preview-group]')].find((el: any) => el.dataset.previewGroup === '["dungeon","dungeon.chat"]')!.open).toBe(false);
      separate.controller.abort();
    } finally { await other.dispose(); }
  } finally { await f.dispose(); }
});

it('validates each regex inline and saves independent modes and case flags through the real configuration boundary', async () => {
  const f = await fixture();
  try {
    const p = await f.mount();
    p.click('添加规则');
    p.input('world', 'dungeon'); p.mode('eventType');
    const invalid = p.input('eventType', '[');
    expect(invalid.getAttribute('aria-invalid')).toBe('true');
    expect([...p.window.document.querySelectorAll('button')].find((el: any) => el.textContent === '加入页面草稿')!.disabled).toBe(true);
    expect([...p.root.querySelectorAll('button')].find((el: any) => el.textContent === '保存整页')!.disabled).toBe(true);
    expect(readFileSync(join(f.dir, 'config.json'), 'utf8')).toBe('{}');
    p.input('eventType', 'dungeon(\\..*)?'); p.mode('senderKey'); p.input('senderKey', 'alice');
    expect(p.window.document.body.textContent).toContain('近期 0/200 条命中本规则');
    const caseInput = p.window.document.querySelector('[data-condition="senderKey"] input[type="checkbox"]')!;
    caseInput.click();
    expect(p.window.document.body.textContent).toContain('近期 190/200 条命中本规则');
    expect(p.window.document.body.textContent).toContain('dungeon(\\..*)?');
    const enabled = [...p.window.document.querySelectorAll('label')].find((el: any) => el.textContent === '启用')!.querySelector('input')!;
    enabled.click(); expect(p.window.document.body.textContent).toContain('近期 0/200 条命中本规则');
    enabled.click(); expect(p.window.document.body.textContent).toContain('近期 190/200 条命中本规则');
    p.click('加入页面草稿'); p.click('保存整页'); await settle();
    const saved = JSON.parse(readFileSync(join(f.dir, 'config.json'), 'utf8')).cognition.blacklist[0].match;
    expect(saved).toEqual({ world: 'dungeon', eventType: { kind: 'regex', pattern: 'dungeon(\\..*)?', ignoreCase: false }, senderKey: { kind: 'regex', pattern: 'alice', ignoreCase: true } });
    const interval = [...p.root.querySelectorAll('label')].find((el: any) => el.textContent.includes('STATE 重复提醒间隔'))!.querySelector('input')!;
    interval.value = '12'; interval.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    p.click('添加规则'); p.mode('eventType'); p.input('eventType', '[');
    p.window.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect([...p.root.querySelectorAll('button')].find((el: any) => el.textContent === '保存整页')!.disabled).toBe(false);
    p.controller.abort();
  } finally { await f.dispose(); }
});

it('shows invalid stored rules, blocks page save, and lets an operator repair them', async () => {
  const f = await fixture([{ id: 'bad', label: 'invalid rule', enabled: true, match: { eventType: { kind: 'regex', pattern: '[', ignoreCase: false } } }]);
  try {
    const p = await f.mount();
    expect(p.root.textContent).toContain('规则已跳过');
    const interval = [...p.root.querySelectorAll('label')].find((el: any) => el.textContent.includes('STATE 重复提醒间隔'))!.querySelector('input')!;
    interval.value = '11'; interval.dispatchEvent(new p.window.Event('input', { bubbles: true }));
    expect([...p.root.querySelectorAll('button')].find((el: any) => el.textContent === '保存整页')!.disabled).toBe(true);
    p.click('编辑'); p.input('eventType', 'dungeon\\..*');
    p.click('加入页面草稿'); p.click('保存整页'); await settle();
    expect(p.root.textContent).not.toContain('规则已跳过');
    expect(f.cfg.cognition!.stateReminderBatches).toBe(11);
    p.controller.abort();
  } finally { await f.dispose(); }
});
