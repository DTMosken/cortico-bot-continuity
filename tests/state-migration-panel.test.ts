import { afterEach, expect, it, vi } from 'vitest';
const PANEL_MODULE = '../webui/state-migration.ts';
const { mountStateMigration } = await import(PANEL_MODULE);
import { MIGRATION_DEFAULT_MINUTES, MIGRATION_MAX_MINUTES, MIGRATION_MIN_MINUTES } from '../persona/state-migration/contracts.ts';
const { JSDOM } = await import(new URL('../../Cortico/node_modules/jsdom/lib/api.js', import.meta.url).href);
const UI_MODULE = '../../Cortico/src/web/client/ui/index.ts';
const { createWebUi } = await import(UI_MODULE);
afterEach(() => vi.unstubAllGlobals());

function fixture(enabled = true, pending = true) {
  const { window } = new JSDOM('<!doctype html><body><main></main></body>', { url: 'http://localhost' });
  const controller = new window.AbortController(), root = window.document.querySelector('main');
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const ui = createWebUi({ doc: window.document, overlayHost: window.document.body, signal: controller.signal,
    memo: { get: <T>(_key: string, fallback: T): T => fallback, set() {} } });
  let confirm = true, confirmations = 0;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const draft: any = { values: {}, changed() {}, state: { stateReview: { enabled, available: true, migrationPending: pending }, stateMigration: { status: 'idle' } } };
  const ctx: any = { root, signal: controller.signal, ui: { ...ui, confirm: async () => { confirmations++; return confirm; } },
    invoke: async (method: string, args: unknown[] = []) => { calls.push({ method, args }); return { status: 'running' }; } };
  const render = mountStateMigration(ctx, draft, root);
  const click = (text: string) => [...root.querySelectorAll('button')].find((button: any) => button.textContent === text)?.click();
  return { root, controller, draft, render, calls, click, setConfirm: (value: boolean) => { confirm = value; }, confirmations: () => confirmations };
}
it.each([[false, true], [true, false]])('hides migration when review is off or STATE is migrated (%s, %s)', (enabled, pending) => {
  const f = fixture(enabled, pending); expect(f.root.firstChild.hidden).toBe(true); f.controller.abort();
});
it('requires both confirmations and sends only the selected duration', async () => {
  const f = fixture();
  f.setConfirm(false); f.click('迁移旧约束'); await Promise.resolve(); expect(f.calls).toEqual([]); expect(f.root.querySelector('dialog')).toBeNull();
  f.setConfirm(true); f.click('迁移旧约束'); await Promise.resolve();
  const slider = f.root.querySelector('input[type="range"]');
  expect(slider.value).toBe(String(MIGRATION_DEFAULT_MINUTES)); expect(slider.min).toBe(String(MIGRATION_MIN_MINUTES)); expect(slider.max).toBe(String(MIGRATION_MAX_MINUTES));
  expect(f.calls).toEqual([]);
  slider.value = String(MIGRATION_MAX_MINUTES); slider.dispatchEvent(new slider.ownerDocument.defaultView.Event('input'));
  expect(f.root.querySelector('dialog').textContent).toContain('下次正常入梦');
  f.click('开始迁移'); await vi.waitFor(() => expect(f.calls).toEqual([{ method: 'startStateMigration', args: [MIGRATION_MAX_MINUTES] }]));
  expect(f.root.textContent).toContain('正在整理'); expect(f.root.querySelector('dialog')).toBeNull(); f.controller.abort();
});
it('cancels the second dialog on leaving and keeps waiting status beside its cancel action', async () => {
  const f = fixture(); f.click('迁移旧约束'); await Promise.resolve(); f.controller.abort(); await Promise.resolve();
  expect(f.root.querySelector('dialog')).toBeNull(); expect(f.calls).toEqual([]);
  const g = fixture(); g.draft.state.stateMigration = { status: 'waiting' }; g.render();
  expect(g.root.textContent).toContain('待下次入梦应用'); expect(g.root.textContent).toContain('取消迁移');
  expect(g.root.firstChild.children[1].nextElementSibling.textContent).toBe('取消迁移');
  g.draft.state.stateMigration = { status: 'applying' }; g.render(); expect(g.root.firstChild.children[2].hidden).toBe(true); g.controller.abort();
});
