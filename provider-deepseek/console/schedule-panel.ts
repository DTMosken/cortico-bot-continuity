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
      windows: '高峰时段', weekday: '周一至周五；周末始终为空闲时段', exceptions: '例外日期（每行 YYYY-MM-DD）',
      from: '开始', to: '结束',
      save: '保存时段', saved: '峰谷设置已保存', invalid: '时段格式错误；请填写 HH:MM，例外日期每行填写 YYYY-MM-DD。',
      refreshError: '无法读取峰谷设置',
    } : {
      current: 'Active pricing band', peak: 'Peak', offPeak: 'Off-peak', timezone: 'China Standard Time (Asia/Shanghai)',
      windows: 'Peak windows', weekday: 'Monday to Friday; weekends are always off-peak', exceptions: 'Exception dates (one YYYY-MM-DD per line)',
      from: 'From', to: 'To',
      save: 'Save schedule', saved: 'Pricing schedule saved', invalid: 'Invalid time or date format. Use HH:MM and one YYYY-MM-DD date per line.',
      refreshError: 'Unable to load pricing schedule',
    };
    const status = ctx.ui.foldSheet('deepseek-schedule', { title: S.current });
    const message = ctx.ui.msgline();
    ctx.root.append(status.el, message);

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

    const starts = state.schedule.windows.map((window) => ctx.ui.input({ value: window.from, placeholder: '09:00', cls: 'mono' }));
    const ends = state.schedule.windows.map((window) => ctx.ui.input({ value: window.to, placeholder: '12:00', cls: 'mono' }));
    const windows = ctx.ui.rowbar();
    windows.classList.add('deepseek-window-grid');
    windows.style.alignItems = 'stretch';
    state.schedule.windows.forEach((_, index) => {
      const group = ctx.ui.h('div', 'deepseek-window');
      group.style.flex = '1 1 280px';
      group.style.minWidth = '0';
      const times = ctx.ui.rowbar();
      times.style.flexWrap = 'nowrap';
      for (const [label, input] of [[S.from, starts[index]], [S.to, ends[index]]] as const) {
        const field = ctx.ui.field(label, input);
        field.style.flex = '1 1 0';
        field.style.minWidth = '0';
        times.append(field);
      }
      group.append(ctx.ui.h('div', 'fieldlabel', zh ? `时段 ${index + 1}` : `Window ${index + 1}`), times);
      windows.append(group);
    });
    status.body.append(ctx.ui.section(S.windows), ctx.ui.msgline(S.weekday), windows);
    const exceptionDates = ctx.ui.textarea({ rows: 6, value: state.schedule.exceptDates.join('\n'), cls: 'mono' });
    status.body.append(ctx.ui.field(S.exceptions, exceptionDates));
    const save = ctx.ui.button(S.save, { variant: 'primary', onClick: () => void saveSchedule() });
    status.body.append(ctx.ui.actions().appendChild(save));

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
