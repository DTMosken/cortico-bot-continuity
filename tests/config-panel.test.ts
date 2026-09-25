import { expect, it } from 'vitest';
import { readGroupValues } from 'cortico/core/config-schema.ts';
import { PERSONA_CONFIG_GROUP } from '../persona/config.ts';
import { composeDefaults } from '../index.ts';

const JSDOM_MODULE = new URL('../../Cortico/node_modules/jsdom/lib/api.js', import.meta.url).href;
const UI_MODULE = '../../Cortico/src/web/client/ui/index.ts';
const CONFIG_MODULE = '../console/config.ts';
const { JSDOM } = await import(JSDOM_MODULE) as {
  JSDOM: new (html: string, options: { url: string }) => {
    window: { document: any; AbortController: typeof AbortController };
  };
};
const { createConsoleUi } = await import(UI_MODULE);
const { mountConfig } = await import(CONFIG_MODULE);

it('renders the Jev key-file action inside the only config panel', async () => {
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
    interval: () => ({ dispose() {} }),
  } as never);
  expect(root.querySelectorAll('.sheet')).toHaveLength(1);
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
