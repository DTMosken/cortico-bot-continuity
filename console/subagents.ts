/** Operator tool permissions are page drafts; World switches preserve individual choices. */
import type { ConsolePanel, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { SUBAGENTS_CONFIG_GROUP, type ToolPermissions } from '../persona/subagents/config.ts';
import type { ToolGroup } from '../persona/subagents/index.ts';
import type { TaskRecord, TaskStatus } from '../persona/subagents/store.ts';
import { mountSettings, type SettingsDraft, type SettingsState } from './config.ts';
import './subagents.css';

interface SubagentsState extends SettingsState {
  groups: ToolGroup[];
  running: number;
  records: Omit<TaskRecord, 'materials'>[];
}
interface ResultPage { status: TaskStatus; result: string; nextOffset: number | null; }
const STATUS: Record<TaskStatus, string> = {
  running: '运行中', complete: '完成', partial: '部分完成', failed: '失败', unconfirmed: '未确认', interrupted: '已中断',
};

export const subagentsPanel: ConsolePanel = {
  async mount(ctx) {
    await mountSettings<SubagentsState>(ctx, SUBAGENTS_CONFIG_GROUP, '子代理', (draft, host) => mountPermissions(ctx, draft, host));
  },
};

function mountPermissions(ctx: ConsolePanelContext, draft: SettingsDraft<SubagentsState>, host: HTMLElement): void {
  const { ui } = ctx;
  draft.pendingMessage = '未保存';
  draft.validation = () => Number(draft.values['subagents.softRounds']) >= Number(draft.values['subagents.maxRounds'])
    ? '收尾提示轮次必须小于硬结束轮次' : null;
  const note = ui.msgline('权限保存后生效；主线说明需手动重载系统前缀。新 worker 使用新轮数额度，运行中的 worker 保持启动额度。');
  const groups = ui.h('div', 'continuity-subagent-groups');
  const tasks = ui.sheet({ title: '任务', en: 'subagents' });
  host.append(note, groups, tasks.el);
  const expanded = new Set<string>();
  draft.onRefresh = render;
  draft.onReset = render;

  function permissions(group: ToolGroup): ToolPermissions {
    const map = draft.values['subagents.permissions'] as Record<string, ToolPermissions>;
    return map[group.id] ??= { enabled: group.enabled, tools: Object.fromEntries(group.tools.map(tool => [tool.name, tool.allowed])) };
  }
  function toggle(label: string, checked: boolean, onChange: (checked: boolean) => void, disabled = false): HTMLButtonElement {
    const button = ui.button('', { onClick: () => { onChange(button.getAttribute('aria-checked') !== 'true'); draft.changed(); render(); } });
    button.className = 'continuity-subagent-switch';
    button.setAttribute('role', 'switch'); button.setAttribute('aria-label', label); button.setAttribute('aria-checked', String(checked));
    button.disabled = disabled;
    return button;
  }
  function render(): void {
    groups.replaceChildren(...draft.state.groups.map(group => {
      const policy = permissions(group);
      const card = ui.sheet({ title: group.label, en: group.id === 'memory' ? '只读' : group.id });
      const selected = group.tools.filter(tool => !tool.reason && policy.tools[tool.name]).length;
      const bar = ui.rowbar();
      const detail = ui.button('工具明细', { onClick: () => {
        if (expanded.has(group.id)) expanded.delete(group.id); else expanded.add(group.id);
        render();
      } });
      detail.setAttribute('aria-expanded', String(expanded.has(group.id)));
      bar.append(toggle(group.label + ' 子代理权限', policy.enabled, value => { policy.enabled = value; }),
        ui.msgline((policy.enabled ? '已开启' : '已暂停') + ' · 选中 ' + selected + '/' + group.tools.length), ui.h('span', 'grow'), detail);
      card.body.append(bar);
      const list = ui.h('div'); list.hidden = !expanded.has(group.id);
      for (const tool of group.tools) {
        const row = ui.h('div', 'continuity-subagent-tool');
        const text = ui.h('div');
        text.append(ui.h('div', 'mono', tool.name), ui.msgline(tool.description));
        const state = tool.reason ?? (!tool.available ? '当前对主线不可用' : !policy.enabled ? '工具组已暂停' : '');
        if (state) text.append(ui.msgline(state));
        row.append(text, toggle(tool.name + ' 子代理权限', !tool.reason && policy.tools[tool.name] === true,
          value => { policy.tools[tool.name] = value; }, !!tool.reason));
        list.append(row);
      }
      card.body.append(list);
      return card.el;
    }));
    const table = ui.table({ head: ['任务', '状态', '摘要', '结果'] });
    for (const task of draft.state.records) table.addRow([
      { text: task.task, cls: 'txt' }, { text: STATUS[task.status] }, { text: task.summary, cls: 'txt' },
      { el: ui.button('查看结果', { onClick: () => { void showResult(task.id); } }) },
    ]);
    tasks.body.replaceChildren(ui.msgline('运行中 ' + draft.state.running + '/' + draft.values['subagents.maxWorkers']), table.el);
  }
  async function showResult(taskId: string): Promise<void> {
    const body = ui.h('div');
    const text = ui.h('pre', 'mono txt');
    const status = ui.msgline('读取中…');
    let offset = 0;
    const next = ui.button('读取下一页', { onClick: () => { void read(); } });
    next.disabled = true;
    body.append(status, text, next); ui.drawer('子代理结果 · ' + taskId, body);
    async function read(): Promise<void> {
      next.disabled = true;
      try {
        const page = await ctx.invoke<ResultPage>('get', [{ taskId, offsetChars: offset }]);
        if (ctx.signal.aborted || !body.isConnected) return;
        status.textContent = STATUS[page.status]; text.textContent += page.result;
        if (page.nextOffset !== null) { offset = page.nextOffset; next.disabled = false; }
      } catch (error) { status.textContent = String(error); status.classList.add('bad'); }
    }
    await read();
  }
  render();
}
