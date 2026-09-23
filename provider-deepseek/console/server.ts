import type { ConsolePageContribution } from 'cortico/web/shared/console-protocol.ts';
import type { ProviderConsoleHost } from 'cortico/providers/console/types.ts';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import responsesCompat from 'cortico/providers/openai-responses-compat/index.ts';
import { validatePrices } from 'cortico/providers/pricebook.ts';
import { currentPricingBand, parsePricingSchedule, pricesForSchedule } from '../pricing.ts';

function instanceName(args: unknown[], required: string): string {
  const raw = args[0];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Record<string, unknown>).name !== 'string') throw new Error(required);
  return (raw as { name: string }).name;
}

export function deepseekPricingConsole(host: ProviderConsoleHost): Partial<ConsolePageContribution> {
  const base = responsesCompat.console?.(host) ?? {};
  const labels = host.language === 'zh'
    ? { title: '峰谷计价', description: '查看人民币单价、当前时段并调整峰时段与例外日期。', pricing: '成本与计价', pricingDescription: 'DeepSeek 官方价目与端点自定义报价。', required: '需要端点名', unknownMethod: '未知方法' }
    : { title: 'Peak/off-peak pricing', description: 'View RMB rates, the active band, and edit peak hours and exception dates.', pricing: 'Cost and pricing', pricingDescription: 'DeepSeek official rates and endpoint-specific overrides.', required: 'Endpoint name required', unknownMethod: 'Unknown method' };
  const stateFor = (name: string, entry: LLMProviderEntry) => {
    const schedule = parsePricingSchedule(entry.options?.deepseekPricingSchedule);
    return { name, schedule, band: currentPricingBand(schedule, new Date()), official: pricesForSchedule(schedule), custom: entry.pricing ?? [] };
  };
  const panels = (base.panels ?? []).map((panel) => panel.id === 'pricing'
    ? { id: 'pricing', title: labels.pricing, description: labels.pricingDescription }
    : panel);
  return {
    ...base,
    config: [...(base.config ?? [])],
    panels: [
      ...panels,
      { id: 'schedule', title: labels.title, description: labels.description },
    ],
    invoke: async (panel, method, args) => {
      if (panel !== 'schedule' && panel !== 'pricing') return base.invoke?.(panel, method, args);
      if (panel === 'pricing' && method === 'instances') {
        return host.entries().map(({ name }) => ({ name }));
      }
      const name = instanceName(args, labels.required);
      const entry = host.entries().find((item) => item.name === name)?.entry;
      if (!entry) throw new Error(labels.required);
      if (panel === 'pricing') {
        if (method === 'state') return { ...stateFor(name, entry), editing: host.editing === true };
        if (method === 'save') {
          const raw = args[0] as Record<string, unknown>;
          const pricing = validatePrices(raw.pricing, host.language);
          const next = { ...entry, pricing };
          host.save(name, next);
          return { ...stateFor(name, next), editing: host.editing === true };
        }
        throw new Error(labels.unknownMethod);
      }
      if (method === 'state') return stateFor(name, entry);
      if (method === 'save') {
        const raw = args[0] as Record<string, unknown>;
        const schedule = parsePricingSchedule(raw.schedule);
        const next = { ...entry, options: { ...entry.options, deepseekPricingSchedule: JSON.stringify(schedule) } };
        host.save(name, next);
        return stateFor(name, next);
      }
      throw new Error(labels.unknownMethod);
    },
  };
}
