import { describe, expect, it } from 'vitest';
import type { ProviderConsoleHost } from 'cortico/providers/console/types.ts';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import deepseekProvider from '../provider-deepseek/index.ts';

const JSDOM_MODULE = new URL('../../Cortico/node_modules/jsdom/lib/api.js', import.meta.url).href;
const UI_MODULE = '../../Cortico/src/web/client/ui/index.ts';
const PRICING_MODULE = '../provider-deepseek/console/pricing-panel.ts';
const SCHEDULE_MODULE = '../provider-deepseek/console/schedule-panel.ts';
const { JSDOM } = await import(JSDOM_MODULE) as {
  JSDOM: new (html: string, options: { url: string }) => { window: { document: any; AbortController: typeof AbortController } };
};
const { createConsoleUi } = await import(UI_MODULE);
const { pricingPanel } = await import(PRICING_MODULE);
const { schedulePanel } = await import(SCHEDULE_MODULE);

function panelContext(panelId: 'pricing' | 'schedule') {
  const { window } = new JSDOM('<!doctype html><body><div class="connection-step"></div></body>', { url: 'http://localhost' });
  const controller = new window.AbortController();
  const root = window.document.querySelector('.connection-step');
  const entry: LLMProviderEntry = { kind: 'deepseek', baseUrl: 'https://api.deepseek.com' };
  const host: ProviderConsoleHost = {
    language: 'zh', editing: true,
    entries: () => [{ name: 'main', entry }],
    instance: () => ({ client: {} as never }),
    save: () => {},
  };
  const contribution = deepseekProvider.console!(host);
  const ui = createConsoleUi({
    doc: window.document, overlayHost: window.document.body, signal: controller.signal,
    memo: { get: <T>(_key: string, fallback: T): T => fallback, set: () => {} },
  });
  return {
    panelId, root, ui, signal: controller.signal, language: 'zh', scope: { instance: 'main' },
    invoke: (method: string, args?: unknown[]) => Promise.resolve(contribution.invoke!(panelId, method, args ?? [])),
    interval: () => ({ dispose() {} }),
  };
}

describe('DeepSeek connection panels', () => {
  it('shows the collapsed endpoint quote editor inside the official pricing card', async () => {
    const ctx = panelContext('pricing');
    await pricingPanel.mount(ctx);
    const custom = ctx.root.querySelector('details.deepseek-custom-pricing');
    expect(custom).not.toBeNull();
    expect(custom?.open).toBe(false);
    expect(custom?.textContent).toContain('端点自定义报价');
    expect(custom?.querySelectorAll('input[type="number"]')).toHaveLength(3);
  });

  it('keeps the schedule in one foldable step with both windows on one row', async () => {
    const ctx = panelContext('schedule');
    await schedulePanel.mount(ctx);
    expect(Array.from(ctx.root.children).filter((element: any) => element.classList.contains('sheet'))).toHaveLength(1);
    const card = ctx.root.querySelector(':scope > details.sheet.fold');
    expect(card).not.toBeNull();
    expect(card?.open).toBe(false);
    expect(card?.querySelector('.tablewrap')).toBeNull();
    const windows = card?.querySelectorAll('.deepseek-window-grid > .deepseek-window');
    expect(windows).toHaveLength(2);
    for (const window of windows ?? []) expect(window.querySelectorAll('input')).toHaveLength(2);
  });
});
