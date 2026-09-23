import type { ConsolePageContribution } from 'cortico/web/shared/console-protocol.ts';
import type { ProviderConsoleHost } from 'cortico/providers/console/types.ts';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import responsesCompat from 'cortico/providers/openai-responses-compat/index.ts';
import { currentPricingBand, parsePricingSchedule } from '../pricing.ts';

function instanceName(args: unknown[], required: string): string {
  const raw = args[0];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Record<string, unknown>).name !== 'string') throw new Error(required);
  return (raw as { name: string }).name;
}

export function deepseekPricingConsole(host: ProviderConsoleHost): Partial<ConsolePageContribution> {
  const base = responsesCompat.console?.(host) ?? {};
  const labels = host.language === 'zh'
    ? { title: '峰谷计价', description: '查看人民币单价、当前时段并调整峰时段与例外日期。', required: '需要端点名', unknownPanel: '未知面板', unknownMethod: '未知方法' }
    : { title: 'Peak/off-peak pricing', description: 'View RMB rates, the active band, and edit peak hours and exception dates.', required: 'Endpoint name required', unknownPanel: 'Unknown panel', unknownMethod: 'Unknown method' };
  const stateFor = (name: string, entry: LLMProviderEntry) => {
    const schedule = parsePricingSchedule(entry.options?.deepseekPricingSchedule);
    return { name, schedule, band: currentPricingBand(schedule, new Date()) };
  };
  return {
    ...base,
    config: [...(base.config ?? [])],
    panels: [
      ...(base.panels ?? []),
      { id: 'schedule', title: labels.title, description: labels.description },
    ],
    invoke: async (panel, method, args) => {
      if (panel !== 'schedule') return base.invoke?.(panel, method, args);
      const name = instanceName(args, labels.required);
      const entry = host.entries().find((item) => item.name === name)?.entry;
      if (!entry) throw new Error(labels.required);
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
