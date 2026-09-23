import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import deepseekProvider from '../provider-deepseek/index.ts';
import { currentPricingBand, defaultPricingSchedule, parsePricingSchedule } from '../provider-deepseek/pricing.ts';
import type { ProviderConsoleHost } from 'cortico/providers/console/types.ts';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { priceUsage } from 'cortico/core/generation.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { validateEntry } from 'cortico/providers/configuration.ts';
import { parseExtensionManifest } from 'cortico/extensions/manifest.ts';
import { extensionAssetUrl } from 'cortico/extensions/manifest.ts';
import { quotePrices } from 'cortico/providers/pricebook.ts';
import { ResponsesProvider } from 'cortico/providers/openai-responses-compat/native.ts';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
const meters = { input: 2000000, output: 1000000, total: 3000000, cachedInput: 1000000, uncachedInput: 1000000, reasoning: 0, native: {} };
const entry: LLMProviderEntry = { kind: 'deepseek', baseUrl: 'https://api.deepseek.com' };
function chargeAt(startedAt: string, model = 'deepseek-flash') {
  const at = { startedAt, requestedServiceTier: null };
  const request = { model } as Request;
  const quotes = quotePrices(entry, request, at, deepseekProvider.prices?.(entry, request, at) ?? []);
  return quotes.length ? priceUsage(meters, quotes)[0] : null;
}

function costAt(startedAt: string, model = 'deepseek-flash'): number | null {
  return chargeAt(startedAt, model)?.amount ?? null;
}
describe('DeepSeek provider module', () => {
 it('ships every panel declared by its console contribution', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../provider-deepseek/package.json', import.meta.url), 'utf8'));
  expect(pkg.cortico.consoleClient).toBe('dist/console.js');
  expect(pkg.files).toEqual(expect.arrayContaining(['console', 'dist']));
  expect(pkg.scripts['build:console']).toBeTruthy();
  const outDir = mkdtempSync(join(tmpdir(), 'deepseek-console-test-'));
  try {
   const outfile = join(outDir, 'console.mjs');
   await build({
    entryPoints: [fileURLToPath(new URL('../provider-deepseek/console/client.ts', import.meta.url))],
    bundle: true, format: 'esm', outfile,
   });
   const bundle = (await import(pathToFileURL(outfile).href)).default;
   expect(Object.keys(bundle.panels)).toEqual(['reasoning', 'schedule', 'pricing']);
   expect(typeof bundle.panels.reasoning.mount).toBe('function');
   expect(typeof bundle.panels.schedule.mount).toBe('function');
   expect(typeof bundle.panels.pricing.mount).toBe('function');
  } finally {
   rmSync(outDir, { recursive: true, force: true });
  }
 });

 it('declares supported reasoning choices and preserves the API default for existing entries', () => {
  expect(deepseekProvider.reasoningTiers.map(({ id, thinking, effort }) => ({ id, thinking, effort }))).toEqual([
   { id: 'high', thinking: true, effort: 'high' },
   { id: 'none', thinking: false, effort: undefined },
   { id: 'low', thinking: true, effort: 'low' },
   { id: 'max', thinking: true, effort: 'max' },
  ]);
  expect(deepseekProvider.localize?.('zh').reasoningTiers?.map(({ label }) => label)).toEqual(['高', '关闭', '低', '最大']);
  expect(deepseekProvider.localize?.('en').reasoningTiers?.map(({ label }) => label)).toEqual(['High', 'Off', 'Low', 'Max']);
  const normalized = deepseekProvider.normalize?.({
   kind: 'deepseek', baseUrl: 'https://api.deepseek.com',
   spec: { model: 'deepseek-flash', thinking: true },
  });
  expect(normalized?.spec?.reasoningEffort).toBe('high');
  const legacyEfforts = [
   ['minimal', 'low'], ['medium', 'high'], ['xhigh', 'high'], ['ultra', 'max'],
  ] as const;
  for (const [reasoningEffort, expected] of legacyEfforts) {
   const legacy = deepseekProvider.normalize?.({
    kind: 'deepseek', baseUrl: 'https://api.deepseek.com',
    spec: { model: 'deepseek-flash', thinking: true, reasoningEffort },
   });
   expect(legacy?.spec?.reasoningEffort).toBe(expected);
  }
  const disabled = deepseekProvider.normalize?.({
   kind: 'deepseek', baseUrl: 'https://api.deepseek.com',
   spec: { model: 'deepseek-flash', thinking: true, reasoningEffort: 'none' },
  });
  expect(disabled?.spec).toMatchObject({ thinking: false });
  expect(disabled?.spec).not.toHaveProperty('reasoningEffort');
 });

 it('supplies its default model before Core validates a draft connection action', () => {
  const normalized = validateEntry(deepseekProvider, {
   kind: 'deepseek', baseUrl: 'https://api.deepseek.com',
   spec: { model: '', thinking: false },
  });
  expect(normalized.spec?.model).toBe('deepseek-flash');
 });

 it('declares the provider contract and DeepSeek URL', () => {
  const pkg = JSON.parse(readFileSync(new URL('../provider-deepseek/package.json', import.meta.url), 'utf8'));
  expect(deepseekProvider.id).toBe('deepseek');
  expect(deepseekProvider.defaultBaseUrl).toBe('https://api.deepseek.com');
  expect(parseExtensionManifest(pkg)).toMatchObject({ ok: true, manifest: { kind: 'provider', api: 5 } });
  expect(pkg.files).toContain('pricing.ts');
 });
 it('uses a new immutable asset URL for the bundle that adds pricing controls', () => {
  const pkg = JSON.parse(readFileSync(new URL('../provider-deepseek/package.json', import.meta.url), 'utf8'));
  expect(extensionAssetUrl(pkg.name, pkg.version, 'console.js')).not.toBe(
   extensionAssetUrl(pkg.name, '0.1.1', 'console.js'),
  );
 });
 it('reuses the Responses client and model catalog', () => {
  const provider = deepseekProvider.create('deepseek', entry, { stateDir: 'unused', secret: () => '', readBlob: () => null, keepThinking: () => false, log: nullLogger() });
  expect(provider.client).toBeInstanceOf(ResponsesProvider);
  expect(provider.listModels).toEqual(expect.any(Function));
 });
 it('uses idle rates outside weekday peaks', () => {
    expect(costAt('2026-09-22T04:00:00Z')).toBeCloseTo(5.02);
    expect(costAt('2026-09-22T10:00:00Z')).toBeCloseTo(5.02);
    expect(costAt('2026-09-26T02:00:00Z')).toBeCloseTo(5.02);
    expect(chargeAt('2026-09-22T04:00:00Z')?.lines.map(({ meter, perMillion, amount }) => [meter, perMillion, amount])).toEqual([
      ['cachedInput', 0.02, 0.02], ['uncachedInput', 1, 1], ['output', 4, 4],
    ]);
 });
 it('uses the configured schedule and exposes the active Shanghai pricing band', () => {
  const schedule = {
   ...defaultPricingSchedule,
   windows: [{ from: '08:00', to: '10:00' }, { from: '15:00', to: '17:00' }],
   exceptDates: ['2026-09-22'],
  };
  const configured = { ...entry, options: { deepseekPricingSchedule: JSON.stringify(schedule) } };
  const quote = deepseekProvider.prices?.(configured, {} as Request, { startedAt: '2026-09-22T01:00:00Z', requestedServiceTier: null })[0];
  expect(quote?.timeWindows?.map(({ from, to }) => [from, to])).toEqual([['08:00', '10:00'], ['15:00', '17:00']]);
  expect(quote?.timeWindows?.[0].rules).toEqual([
   { meter: 'cachedInput', perMillion: 0.04 },
   { meter: 'uncachedInput', perMillion: 2 },
   { meter: 'output', perMillion: 8 },
  ]);
  expect(currentPricingBand(schedule, new Date('2026-09-22T01:00:00Z'))).toBe('offPeak');
  expect(currentPricingBand(schedule, new Date('2026-09-23T01:00:00Z'))).toBe('peak');
  expect(currentPricingBand(schedule, new Date('2026-09-26T01:00:00Z'))).toBe('offPeak');
  expect(currentPricingBand(schedule, new Date('2026-09-23T02:00:00Z'))).toBe('offPeak');
 });
 it('uses default schedule for missing settings and rejects malformed schedules', () => {
  expect(parsePricingSchedule(undefined)).toEqual(defaultPricingSchedule);
  expect(() => parsePricingSchedule('{"windows":[]}')).toThrow();
 });
 it('exposes the plugin-owned schedule panel alongside the inherited pricing and reasoning panels', async () => {
  let saved: LLMProviderEntry | undefined;
  const host: ProviderConsoleHost = {
   language: 'zh', editing: true,
   entries: () => [{ name: 'main', entry }],
   instance: () => ({ client: {} as never }),
   save: (_name, next) => { saved = next; },
  };
  const contribution = deepseekProvider.console?.(host);
  expect(contribution?.panels?.map(({ id }) => id)).toContain('schedule');
  expect(contribution?.panels?.map(({ id }) => id)).toContain('reasoning');
  const state = await contribution?.invoke?.('schedule', 'state', [{ name: 'main' }]) as { schedule: unknown };
  expect(state.schedule).toEqual(defaultPricingSchedule);
  const updated = await contribution?.invoke?.('schedule', 'save', [{ name: 'main', schedule: { ...defaultPricingSchedule, windows: [{ from: '08:00', to: '10:00' }, { from: '15:00', to: '17:00' }] } }]) as { schedule: unknown };
  expect(saved?.options?.deepseekPricingSchedule).toContain('08:00');
  expect(updated.schedule).toMatchObject({ windows: [{ from: '08:00', to: '10:00' }, { from: '15:00', to: '17:00' }] });
 });
 it('replaces the generic price editor with a DeepSeek price panel and stages explicit quotes', async () => {
  let saved: LLMProviderEntry | undefined;
  const host: ProviderConsoleHost = {
   language: 'zh', editing: true,
   entries: () => [{ name: 'main', entry }],
   instance: () => ({ client: {} as never }),
   save: (_name, next) => { saved = next; },
  };
  const contribution = deepseekProvider.console?.(host);
  const pricingPanel = contribution?.panels?.find(({ id }) => id === 'pricing');
  expect(pricingPanel).toMatchObject({ id: 'pricing', title: '成本与计价' });
  expect(pricingPanel).not.toHaveProperty('builtin');
  const state = await contribution?.invoke?.('pricing', 'state', [{ name: 'main' }]) as { official: { rules: Array<{ meter: string; perMillion: number }> }; custom: unknown[] };
  expect(await contribution?.invoke?.('pricing', 'instances', [])).toEqual([{ name: 'main' }]);
  expect((await contribution?.invoke?.('pricing', 'state', [{ name: 'main' }]) as { editing: boolean }).editing).toBe(true);
  expect(state.official.rules).toEqual([
   { meter: 'cachedInput', perMillion: 0.02 },
   { meter: 'uncachedInput', perMillion: 1 },
   { meter: 'output', perMillion: 4 },
  ]);
  expect(state.custom).toEqual([]);
  await contribution?.invoke?.('pricing', 'save', [{ name: 'main', pricing: [{
   models: ['*'], currency: 'RMB', basis: 'marginal', source: 'console',
   rules: [{ meter: 'cachedInput', perMillion: 0.5 }, { meter: 'uncachedInput', perMillion: 3 }, { meter: 'output', perMillion: 9 }],
  }] }]);
  expect(saved?.pricing?.[0].rules).toEqual([
   { meter: 'cachedInput', perMillion: 0.5 },
   { meter: 'uncachedInput', perMillion: 3 },
   { meter: 'output', perMillion: 9 },
  ]);
 });
  it('applies half-open windows in Shanghai time', () => {
  const cases: Array<[string, number]> = [
   ['2026-09-22T01:00:00Z',10.04],['2026-09-22T03:59:00Z',10.04],['2026-09-22T04:00:00Z',5.02],
   ['2026-09-22T06:00:00Z',10.04],['2026-09-22T09:59:00Z',10.04],['2026-09-22T10:00:00Z',5.02],
  ];
    for (const [at, expected] of cases) expect(costAt(at)).toBeCloseTo(expected);
    expect(chargeAt('2026-09-22T01:00:00Z')?.lines.map(({ meter, perMillion, amount }) => [meter, perMillion, amount])).toEqual([
      ['cachedInput', 0.04, 0.04], ['uncachedInput', 2, 2], ['output', 8, 8],
    ]);
  });
 it('excludes statutory holidays and leaves makeup weekends off-peak', () => {
  const holidays = [
   '2026-01-01','2026-01-02','2026-01-03','2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22','2026-02-23',
   '2026-04-04','2026-04-05','2026-04-06','2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',
   '2026-06-19','2026-06-20','2026-06-21','2026-09-25','2026-09-26','2026-09-27',
   '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07',
  ];
  for (const date of holidays) expect(costAt(date + 'T02:00:00Z')).toBeCloseTo(5.02);
  expect(costAt('2026-05-09T02:00:00Z')).toBeCloseTo(5.02);
  expect(costAt('2026-09-26T02:00:00Z')).toBeCloseTo(5.02);
  expect(costAt('2026-09-28T02:00:00Z')).toBeCloseTo(10.04);
 });
 it('does not quote Flash prices for another model', () => {
  expect(costAt('2026-09-22T01:00:00Z','deepseek-chat')).toBeNull();
 });
});
