/** Dream budgets and execution diagnostics share a draft-preserving page. */
import type { ConsolePanel, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { DREAM_CONFIG_GROUP } from '../persona/config.ts';
import type { DreamRun, DreamStatus } from '../persona/subconscious/index.ts';
import { mountSettings } from './config.ts';

const STATUS = { running: '进行中', complete: '完成', partial: '部分完成', interrupted: '中断／未确认' };
export const dreamPanel: ConsolePanel = {
  async mount(ctx: ConsolePanelContext) {
    await mountSettings(ctx, DREAM_CONFIG_GROUP, '梦与交接预算', (draft, host) => {
      const { ui } = ctx;
      const sheet = ui.sheet({ title: '整理记录' });
      const live = ui.msgline();
      const tasks = ui.h('div');
      const records = ui.h('div');
      const actionStatus = ui.msgline();
      const resume = ui.button('继续未完成整理', { onClick: () => {
        resume.disabled = true;
        void ctx.invoke<{ ok: boolean; message: string; state: DreamStatus }>('resume').then((out) => {
          actionStatus.textContent = out.message; actionStatus.classList.toggle('bad', !out.ok); paint(out.state);
        }).catch((error) => { actionStatus.textContent = String(error); actionStatus.classList.add('bad'); resume.disabled = false; });
      } });
      const trigger = ui.button('强制交接并入梦', { onClick: () => {
        trigger.disabled = true;
        void ctx.invoke<{ ok: boolean; message: string; state: DreamStatus }>('trigger').then((out) => {
          actionStatus.textContent = out.message; actionStatus.classList.toggle('bad', !out.ok); paint(out.state);
        }).catch((error) => { actionStatus.textContent = String(error); actionStatus.classList.add('bad'); trigger.disabled = false; });
      } });
      const actions = ui.rowbar(); actions.append(resume, trigger, actionStatus);
      sheet.body.append(live, actions, tasks, records);
      host.append(sheet.el);
      const paint = (state: DreamStatus): void => {
        live.textContent = (state.retryAt ? '等待重试 ' + new Date(state.retryAt).toLocaleTimeString() : state.dreaming ? '进行中' : '空闲') + ' · 排队 ' + (state.queued ?? 0) + ' · 待处理材料 ' + (state.pendingMaterials ?? 0);
        trigger.disabled = state.dreaming;
        resume.disabled = state.dreaming || !state.pendingMaterials;
        tasks.replaceChildren(ui.h('h4', '', '剩余待办'), ...((state.pendingTasks ?? []).length
          ? state.pendingTasks.map((task) => ui.msgline(task)) : [ui.msgline('无已记录待办')]));
        records.replaceChildren(...(state.runs ?? []).map((run) => runRow(ctx, run)));
      };
      draft.onRefresh = (state) => paint(state as unknown as DreamStatus);
      paint(draft.state as unknown as DreamStatus);
    });
  },
};
function runRow(ctx: ConsolePanelContext, run: DreamRun): HTMLElement {
  const { ui } = ctx;
  const row = ui.rowbar();
  const metric = (value: number | null | undefined): string => value == null ? '未知' : value.toLocaleString();
  row.append(ui.pill(STATUS[run.status], run.status === 'complete' ? 'on' : 'plain'),
    ui.h('span', '', run.startedAt + ' · ' + metric(run.elapsedMs === undefined ? undefined : Math.round(run.elapsedMs / 1000)) + ' 秒'),
    ui.h('span', '', '模型轮数 ' + metric(run.usage?.rounds) + ' · HTTP 尝试 ' + metric(run.usage?.attempts)),
    ui.button('查看诊断', { onClick: () => {
      const body = ui.h('div');
      body.append(ui.msgline('初始输入（本地估算） ' + metric(run.inputTokens) + ' · STATE ' + metric(run.stateTokens) + ' · 旧背景 ' + metric(run.backgroundTokens)),
        ui.msgline('直接注入 ' + metric(run.included) + ' 份 · 未直接注入 ' + metric(run.omitted) + ' 份 · 确认完成 ' + run.processedMaterials.length + '/' + run.materialIds.length),
        ui.msgline('上游计量：输入 ' + metric(run.usage?.input) + ' · 缓存命中 ' + metric(run.usage?.cachedInput) + ' · 输出 ' + metric(run.usage?.output)),
        ui.msgline('输入组成与上游计量口径不同；这些记录不表示实际账单。'));
      if (run.error) body.append(ui.msgline(run.error));
      if (run.retryOf) body.append(ui.msgline('第 ' + run.retryAttempt + ' 次重试 · 上次记录 ' + run.retryOf));
      for (const task of run.pendingTasks) body.append(ui.msgline('待办：' + task));
      for (const tool of run.tools) body.append(ui.msgline(tool.name + ' ' + (tool.path ?? '') + ' · ' + tool.elapsedMs + ' ms · 回执 ' + tool.resultChars + ' 字符' + (tool.failed ? ' · 异常' : '')));
      ui.drawer('梦诊断', body);
    } }));
  return row;
}
