import type { PriceDefinition } from 'cortico/providers/pricebook.ts';

export interface DeepSeekPricingSchedule {
  windows: Array<{ from: string; to: string }>;
  exceptDates: string[];
}

export const defaultPricingSchedule: DeepSeekPricingSchedule = {
  windows: [
    { from: '09:00', to: '12:00' },
    { from: '14:00', to: '18:00' },
  ],
  exceptDates: [
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  ],
};

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parsePricingSchedule(value: unknown): DeepSeekPricingSchedule {
  if (value === undefined || value === '') return structuredClone(defaultPricingSchedule);
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error('Invalid DeepSeek pricing schedule JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid DeepSeek pricing schedule');
  const candidate = parsed as Partial<DeepSeekPricingSchedule>;
  if (!Array.isArray(candidate.windows) || candidate.windows.length !== 2
    || candidate.windows.some((window) => !window || !TIME.test(window.from) || !TIME.test(window.to) || window.from >= window.to)
    || candidate.windows[0].to > candidate.windows[1].from) {
    throw new Error('Peak windows must be two ordered, non-overlapping HH:MM ranges');
  }
  if (!Array.isArray(candidate.exceptDates) || candidate.exceptDates.some((date) => {
    if (typeof date !== 'string' || !DATE.test(date)) return true;
    const value = new Date(`${date}T00:00:00.000Z`);
    return !Number.isFinite(value.valueOf()) || value.toISOString().slice(0, 10) !== date;
  })) throw new Error('Exception dates must use YYYY-MM-DD');
  return {
    windows: candidate.windows.map(({ from, to }) => ({ from, to })),
    exceptDates: [...new Set(candidate.exceptDates)].sort(),
  };
}

export function currentPricingBand(scheduleValue: unknown, at: Date): 'peak' | 'offPeak' {
  const schedule = parsePricingSchedule(scheduleValue);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(part('weekday')) + 1;
  const time = `${part('hour')}:${part('minute')}`;
  if (weekday < 1 || weekday > 5 || schedule.exceptDates.includes(date)) return 'offPeak';
  return schedule.windows.some(({ from, to }) => from <= time && time < to) ? 'peak' : 'offPeak';
}

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

export function pricesForSchedule(scheduleValue: unknown): PriceDefinition {
  const schedule = parsePricingSchedule(scheduleValue);
  return {
    models: ['deepseek-flash'],
    currency: 'RMB',
    basis: 'marginal',
    rules: IDLE_RULES,
    source: 'DeepSeek official pricing',
    timeWindows: schedule.windows.map(({ from, to }) => ({
      from, to, timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5],
      exceptDates: schedule.exceptDates, rules: PEAK_RULES,
    })),
  };
}
