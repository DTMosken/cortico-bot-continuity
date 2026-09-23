import type { ProviderModule } from 'cortico/providers/base.ts';
import type { PriceDefinition } from 'cortico/providers/pricebook.ts';
import responsesCompat from 'cortico/providers/openai-responses-compat/index.ts';

const IDLE_RULES: PriceDefinition['rules'] = [
  { meter: 'cachedInput', perMillion: 0.02 },
  { meter: 'uncachedInput', perMillion: 1 },
  { meter: 'output', perMillion: 4 },
];

const PEAK_RULES: PriceDefinition['rules'] = [
  { meter: 'cachedInput', perMillion: 0.04 },
  { meter: 'uncachedInput', perMillion: 2 },
  { meter: 'output', perMillion: 8 },
];

const HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
];

const DEEPSEEK_PRICES: PriceDefinition = {
  models: ['deepseek-flash'],
  currency: 'RMB',
  basis: 'marginal',
  rules: IDLE_RULES,
  source: 'DeepSeek official pricing',
  timeWindows: [
    { from: '09:00', to: '12:00', timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], exceptDates: HOLIDAYS_2026, rules: PEAK_RULES },
    { from: '14:00', to: '18:00', timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], exceptDates: HOLIDAYS_2026, rules: PEAK_RULES },
  ],
};

export const DEEPSEEK_PROVIDER: ProviderModule = {
  ...responsesCompat,
  id: 'deepseek',
  title: 'DeepSeek',
  description: 'DeepSeek Responses API.',
  defaultBaseUrl: 'https://api.deepseek.com',
  baseUrlSuggestions: ['https://api.deepseek.com'],
  prices: () => [DEEPSEEK_PRICES],
};

export default DEEPSEEK_PROVIDER;
