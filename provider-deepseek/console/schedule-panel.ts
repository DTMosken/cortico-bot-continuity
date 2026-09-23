import type { ConsolePanel, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { currentPricingBand, type DeepSeekPricingSchedule } from '../pricing.ts';

interface ScheduleState {
  name: string;
  schedule: DeepSeekPricingSchedule;
  band: 'peak' | 'offPeak';
}

export const schedulePanel: ConsolePanel = {
  mount: async (ctx: ConsolePanelContext) => {
    const zh = ctx.language === 'zh';
    const S = zh ? {
      current: '当前计价时段', peak: '高峰', offPeak: '空闲', timezone: '北京时间（Asia/Shanghai）',
      rates: '每百万 tokens（人民币）', meter: '用量', cached: '输入（缓存命中）', uncached: '输入（缓存未命中）', output: '输出',
      windows: '高峰时段', weekday: '周一至周五；周末始终为空闲时段', exceptions: '例外日期（每行 YYYY-MM-DD）',
      save: '保存时段', saved: '峰谷设置已保存', invalid: '时段格式错误；请填写 HH:MM，例外日期每行填写 YYYY-MM-DD。',
      refreshError: '无法读取峰谷设置',
    } : {
      current: 'Active pricing band', peak: 'Peak', offPeak: 'Off-peak', timezone: 'China Standard Time (Asia/Shanghai)',
      rates: 'RMB per million tokens', meter: 'Meter', cached: 'Input (cache hit)', uncached: 'Input (cache miss)', output: 'Output',
      windows: 'Peak windows', weekday: 'Monday to Friday; weekends are always off-peak', exceptions: 'Exception dates (one YYYY-MM-DD per line)',
      save: 'Save schedule', saved: 'Pricing schedule saved', invalid: 'Invalid time or date format. Use HH:MM and one YYYY-MM-DD date per line.',
      refreshError: 'Unable to load pricing schedule',
    };
    const status = ctx.ui.sheet({ title: S.current });
    const rates = ctx.ui.sheet({ title: S.rates });
    const editor = ctx.ui.sheet({ title: S.windows });
    const message = ctx.ui.msgline();
    ctx.root.append(status.el, rates.el, editor.el, message);

    let state: ScheduleState;
    try {
      state = await ctx.invoke<ScheduleState>('state', [{ name: ctx.scope.instance }]);
    } catch (error) {
      message.textContent = `${S.refreshError}: ${String(error)}`;
      return;
    }
    if (ctx.signal.aborted) return;

    const updateStatus = (band = currentPricingBand(state.schedule, new Date())) => {
      const now = new Date();
      const time = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
        timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23',
      }).format(now);
      status.note.textContent = `${band === 'peak' ? S.peak : S.offPeak} · ${time} · ${S.timezone}`;
    };
    updateStatus(state.band);
    ctx.interval(updateStatus, 30_000);

    const table = ctx.ui.table({ head: [S.meter, S.peak, S.offPeak] });
    table.addRow([S.cached, '¥0.04', '¥0.02']);
    table.addRow([S.uncached, '¥2.00', '¥1.00']);
    table.addRow([S.output, '¥8.00', '¥4.00']);
    rates.body.append(table.el);

    const starts = state.schedule.windows.map((window) => ctx.ui.input({ value: window.from, placeholder: '09:00', cls: 'mono' }));
    const ends = state.schedule.windows.map((window) => ctx.ui.input({ value: window.to, placeholder: '12:00', cls: 'mono' }));
    const timeRows = state.schedule.windows.map((_, index) => {
      const row = ctx.ui.rowbar();
      row.append(ctx.ui.field(zh ? `时段 ${index + 1}` : `Window ${index + 1}`, starts[index]), ctx.ui.h('span', 'muted', '–'), ends[index]);
      return row;
    });
    editor.body.append(ctx.ui.msgline(S.weekday));
    for (const row of timeRows) editor.body.append(row);
    const exceptionDates = ctx.ui.textarea({ rows: 6, value: state.schedule.exceptDates.join('\n'), cls: 'mono' });
    editor.body.append(ctx.ui.field(S.exceptions, exceptionDates));
    const save = ctx.ui.button(S.save, { variant: 'primary', onClick: () => void saveSchedule() });
    editor.body.append(ctx.ui.actions().appendChild(save));

    async function saveSchedule(): Promise<void> {
      const schedule: DeepSeekPricingSchedule = {
        windows: starts.map((input, index) => ({ from: input.value.trim(), to: ends[index].value.trim() })),
        exceptDates: exceptionDates.value.split(/\r?\n/).map((date) => date.trim()).filter(Boolean),
      };
      if (schedule.windows.some(({ from, to }) => !/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to))
        || schedule.exceptDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
        message.textContent = S.invalid;
        return;
      }
      const release = ctx.ui.disable(save);
      try {
        state = await ctx.invoke<ScheduleState>('save', [{ name: state.name, schedule }]);
        message.textContent = S.saved;
        updateStatus(state.band);
      } catch (error) {
        message.textContent = String(error);
      } finally {
        release.dispose();
      }
    }
  },
};
