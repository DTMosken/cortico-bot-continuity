import type { ProviderModule } from 'cortico/providers/base.ts';
import type { ReasoningTier } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import responsesCompat from 'cortico/providers/openai-responses-compat/index.ts';
import { pricesForSchedule } from './pricing.ts';
import { deepseekPricingConsole } from './console/server.ts';

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

export const DEEPSEEK_PROVIDER: ProviderModule = {
  ...responsesCompat,
  id: 'deepseek',
  title: 'DeepSeek',
  description: 'DeepSeek Responses API.',
  defaultBaseUrl: 'https://api.deepseek.com',
  baseUrlSuggestions: ['https://api.deepseek.com'],
  console: deepseekPricingConsole,
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
  prices: (entry) => [pricesForSchedule(entry.options?.deepseekPricingSchedule)],
  validateEntry(entry) {
    pricesForSchedule(entry.options?.deepseekPricingSchedule);
  },
};

export default DEEPSEEK_PROVIDER;
