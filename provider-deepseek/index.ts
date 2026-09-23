import type { ProviderModule } from 'cortico/providers/base.ts';
import type { PriceDefinition } from 'cortico/providers/pricebook.ts';
import type { ReasoningTier } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import responsesCompat from 'cortico/providers/openai-responses-compat/index.ts';

const DEFAULT_MODEL = 'deepseek-flash';
const LEGACY_EFFORTS: Record<string, string> = {
  minimal: 'low', medium: 'high', xhigh: 'high', ultra: 'max',
};

const reasoningTiers = (language: Language): ReasoningTier[] => {
  const labels = language === 'zh'
    ? { high: '高', none: '关闭', low: '低', max: '最大' }
    : { high: 'High', none: 'Off', low: 'Low', max: 'Max' };
  return [
    { id: 'high', label: labels.high, thinking: true, effort: 'high' },
    { id: 'none', label: labels.none, thinking: false },
    { id: 'low', label: labels.low, thinking: true, effort: 'low' },
    { id: 'max', label: labels.max, thinking: true, effort: 'max' },
  ];
};

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
  models: [DEFAULT_MODEL],
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
  reasoningTiers: reasoningTiers('zh'),
  localize: (language) => ({
    ...responsesCompat.localize?.(language),
    reasoningTiers: reasoningTiers(language),
  }),
  normalize(entry) {
    const normalized = responsesCompat.normalize?.(entry) ?? structuredClone(entry);
    if (!normalized.spec) return normalized;
    const spec = { ...normalized.spec };
    if (typeof spec.model !== 'string' || !spec.model.trim()) spec.model = DEFAULT_MODEL;
    if (spec.thinking) {
      const effort = spec.reasoningEffort?.trim();
      if (effort === 'none') {
        spec.thinking = false;
        delete spec.reasoningEffort;
      } else {
        spec.reasoningEffort = effort ? LEGACY_EFFORTS[effort] ?? effort : 'high';
      }
    }
    return { ...normalized, spec };
  },
  prices: () => [DEEPSEEK_PRICES],
};

export default DEEPSEEK_PROVIDER;
