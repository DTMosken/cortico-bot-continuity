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
});
