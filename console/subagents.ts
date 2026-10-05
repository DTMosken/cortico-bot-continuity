/** Operator tool permissions are page drafts; World switches preserve individual choices. */
import type { ConsolePanel, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { SUBAGENTS_CONFIG_GROUP, type ToolPermissions } from '../persona/subagents/config.ts';
import type { ToolGroup } from '../persona/subagents/index.ts';
import type { TaskRecord, TaskStatus } from '../persona/subagents/store.ts';
import { mountSettings, type SettingsDraft, type SettingsState } from './config.ts';
import './subagents.css';

interface SubagentsState extends SettingsState {
  groups: ToolGroup[];
  cognitionGroups: ToolGroup[];
  running: number;
  records: Omit<TaskRecord, 'materials'>[];
  total: number;
  nextOffset: number | null;
}
interface TaskPage { tasks: SubagentsState['records']; total: number; nextOffset: number | null; }
interface ResultPage { status: TaskStatus; result: string; nextOffset: number | null; }
const STATUS: Record<TaskStatus, string> = {
  running: '运行中', stopping: '停止中', cancelled: '已取消', timed_out: '已超时', complete: '完成', partial: '部分完成', failed: '失败', unconfirmed: '未确认', interrupted: '已中断',
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
    ? '轮数提醒起点必须小于硬结束轮次' : null;
  const note = ui.msgline('权限保存后生效；主线说明需手动重载系统前缀。新任务使用新额度，运行中的任务保持启动额度。');
  const groups = ui.h('div', 'continuity-subagent-permission-sections');
  const tasks = ui.sheet({ title: '任务', en: 'subagents' });
  tasks.el.classList.add('continuity-subagent-tasks');
  host.append(note, groups, tasks.el);
  const expanded = new Set<string>();
  let taskOffset = 0;
  let taskPage: TaskPage | null = null;
  draft.onRefresh = () => { if (taskOffset) void loadTasks(taskOffset); else { taskPage = null; render(); } };
  draft.onReset = () => { taskOffset = 0; taskPage = null; render(); };

  function permissions(group: ToolGroup, key: string): ToolPermissions {
    const map = draft.values[key] as Record<string, ToolPermissions>;
    return { enabled: map[group.id]?.enabled ?? group.enabled,
      tools: Object.fromEntries(group.tools.map(tool => [tool.name, map[group.id]?.tools[tool.name] ?? tool.allowed])) };
  }
  function toggle(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLButtonElement {
    const button = ui.button('', { onClick: () => { onChange(button.getAttribute('aria-checked') !== 'true'); draft.changed(); render(); } });
    button.className = 'continuity-subagent-switch';
    button.setAttribute('role', 'switch'); button.setAttribute('aria-label', label); button.setAttribute('aria-checked', String(checked));
    return button;
  }
  function render(): void {
    const taskScroll = tasks.body.querySelector('.tablewrap')?.scrollLeft ?? 0;
    const sections = [
      { key: 'subagents.permissions', title: '主线子代理权限', groups: draft.state.groups,
        notes: [
          '用于主 agent 通过 subagent_spawn 委派的任务。每次委派仍需从这里允许的工具中，选择本次任务要用的工具。',
          'World 工具还必须对主线可见。Memory 仅开放只读工具。',
        ] },
      { key: 'subagents.cognitionPermissions', title: 'World扩展子代理权限', groups: draft.state.cognitionGroups,
        notes: [
          '用于 World 自己通过 cognition.request 发起的后台任务。每次请求只能选择自己的工具；任务只获得请求中点名且在这里允许的 World 工具。',
          '整组开关控制该 World 能否发起任务，关闭后会停止它正在运行的认知任务。单个工具开关控制该工具是否可用；请求包含被禁用的工具时，整个请求会被拒绝。',
          '这里的 World 工具默认允许使用，不受主线可见性限制。Memory 自动提供上方 Memory 组已开启的只读工具。',
        ] },
    ];
    groups.replaceChildren(...sections.map(section => {
      const block = ui.h('section', 'continuity-subagent-permissions');
      const cards = ui.h('div', 'continuity-subagent-groups');
      const description = ui.h('div', 'continuity-subagent-description');
      description.append(...section.notes.map(note => ui.h('p', '', note)));
      block.append(ui.h('h3', '', section.title), description, cards);
      cards.replaceChildren(...section.groups.flatMap(group => {
      const tools = group.tools.filter(tool => !tool.reason);
      if (!tools.length) return [];
      const policy = permissions(group, section.key);
      const change = (update: () => void) => {
        update();
        const map = draft.values[section.key] as Record<string, ToolPermissions>;
        map[group.id] = policy;
      };
      const card = ui.sheet({ title: group.label, en: group.id === 'memory' ? '只读' : group.id });
      const selected = tools.filter(tool => policy.tools[tool.name]).length;
      const bar = ui.rowbar();
      const detail = ui.button('工具明细', { onClick: () => {
        const id = section.key + '/' + group.id;
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        render();
      } });
      detail.setAttribute('aria-expanded', String(expanded.has(section.key + '/' + group.id)));
      bar.append(toggle(group.label + ' ' + section.title, policy.enabled, value => change(() => { policy.enabled = value; })),
        ui.msgline((policy.enabled ? '已开启' : '已暂停') + ' · 选中 ' + selected + '/' + tools.length), ui.h('span', 'grow'), detail);
      card.body.append(bar);
      const list = ui.h('div'); list.hidden = !expanded.has(section.key + '/' + group.id);
      for (const tool of tools) {
        const row = ui.h('div', 'continuity-subagent-tool');
        const text = ui.h('div');
        text.append(ui.h('div', 'mono', tool.name), ui.msgline(tool.description));
        const state = !tool.available ? '当前对主线不可用' : !policy.enabled ? '工具组已暂停' : '';
        if (state) text.append(ui.msgline(state));
        row.append(text, toggle(tool.name + ' ' + section.title, policy.tools[tool.name] === true,
          value => change(() => { policy.tools[tool.name] = value; })));
        list.append(row);
      }
      card.body.append(list);
      return [card.el];
      }));
      if (!cards.childElementCount) cards.append(ui.msgline('暂无已挂载的 World 工具。'));
      return block;
    }));
    const table = ui.table({ head: ['任务 / 来源', '状态 / 原因', '额度使用', '摘要', '操作'] });
    const page = taskPage ?? { tasks: draft.state.records, total: draft.state.total, nextOffset: draft.state.nextOffset };
    for (const task of page.tasks) {
      const title = ui.h('div'); title.append(ui.h('div', 'txt', task.task), ui.msgline((task.worldId ?? '主线') + ' · ' + (task.context === 'main' ? '主线上下文快照' : '独立上下文')));
      const state = ui.h('div'); state.append(ui.h('div', '', STATUS[task.status]), ui.msgline(reasonText(task.endReason)));
      const usage = ui.h('div'); usage.append(ui.msgline('模型轮数 ' + task.rounds + '/' + task.maxRounds), ui.msgline('单次输入峰值 ' + (task.peakInputTokens?.toLocaleString() ?? '未知') + ' token'));
      const actions = ui.h('div', 'continuity-subagent-actions');
      actions.append(ui.button('查看结果', { onClick: () => { void showResult(task.id); } }));
      if (task.reminders.length) actions.append(ui.button(task.reminders.length + ' 条提醒', { onClick: () => {
        const body = ui.h('div', 'continuity-subagent-reminders');
        for (const reminder of task.reminders) {
          const row = ui.rowbar();
          row.append(ui.msgline(reminder.index + ' · ' + reminder.summary), ui.button('读取提醒 ' + reminder.index, { onClick: () => { void showResult(task.id, reminder.index, reminder.summary); } }));
          body.append(row);
        }
        ui.drawer('子代理提醒 · ' + task.id, body);
      } }));
      if (task.status === 'running' || task.status === 'stopping') {
        const cancel = ui.button(task.status === 'stopping' ? '停止中…' : '取消任务', { onClick: () => { void cancelTask(task.id, cancel); } });
        cancel.disabled = task.status === 'stopping'; actions.append(cancel);
      }
      table.addRow([{ el: title }, { el: state }, { el: usage }, { text: task.summary || '暂无摘要', cls: 'txt' }, { el: actions }]);
    }
    const pages = ui.rowbar();
    const previous = ui.button('上一页任务', { onClick: () => { void loadTasks(Math.max(0, taskOffset - 20)); } }); previous.disabled = taskOffset === 0;
    const next = ui.button('下一页任务', { onClick: () => { if (page.nextOffset !== null) void loadTasks(page.nextOffset); } }); next.disabled = page.nextOffset === null;
    pages.append(ui.msgline('运行中 ' + draft.state.running + '/' + draft.values['subagents.maxWorkers'] + ' · 共 ' + page.total + ' 项'), ui.h('span', 'grow'), previous, next);
    tasks.body.replaceChildren(pages, table.el);
    table.el.scrollLeft = taskScroll;
    if (!page.tasks.length) tasks.body.append(ui.msgline('暂无任务。'));
  }
  async function loadTasks(offset: number): Promise<void> {
    taskOffset = offset;
    try {
      const page = await ctx.invoke<TaskPage>('list', [{ offset, limit: 20 }]);
      if (ctx.signal.aborted || taskOffset !== offset) return;
      taskPage = page; render();
    } catch (error) { tasks.body.append(ui.msgline(String(error))); }
  }
  async function cancelTask(taskId: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await ctx.invoke('spawn', [{ mode: 'cancel', taskId }]);
      draft.state = await ctx.invoke<SubagentsState>('state');
      if (taskOffset) await loadTasks(taskOffset); else { taskPage = null; render(); }
    } catch (error) { button.disabled = false; tasks.body.append(ui.msgline(String(error))); }
  }
  async function showResult(taskId: string, reminderIndex?: number, summary?: string): Promise<void> {
    const body = ui.h('div');
    const text = ui.h('pre', 'mono txt');
    const status = ui.msgline('读取中…');
    let offset = 0;
    const next = ui.button('读取下一页', { onClick: () => { void read(); } });
    next.disabled = true;
    if (summary) body.append(ui.msgline(summary));
    body.append(status, text, next); ui.drawer((reminderIndex === undefined ? '子代理结果' : '提醒 ' + reminderIndex) + ' · ' + taskId, body);
    async function read(): Promise<void> {
      next.disabled = true;
      try {
        const page = await ctx.invoke<ResultPage>('get', [{ taskId, offsetChars: offset, ...(reminderIndex === undefined ? {} : { reminderIndex }) }]);
        if (ctx.signal.aborted || !body.isConnected) return;
        status.textContent = STATUS[page.status] + (page.nextOffset === null ? ' · 已到末尾' : ''); text.textContent += page.result;
        if (page.nextOffset !== null) { offset = page.nextOffset; next.disabled = false; }
      } catch (error) { status.textContent = String(error); status.classList.add('bad'); }
    }
    await read();
  }
  render();
}

function reasonText(reason?: string): string {
  const labels: Record<string, string> = { natural: '自然结束', finish: '主动结束', ends_turn: '工具结束任务', round_limit: '轮数用尽', context_limit: '上下文已满', cancelled: '取消请求', timeout: '超过时限', disabled: '子代理已关闭', world_disabled: 'World 权限已关闭', shutdown: '停止运行', world_unmounted: 'World 已卸载', world_unmounted_or_restarted: 'World 已卸载或重启', process_restart: '进程已重启', error: '执行错误' };
  return reason ? labels[reason] ?? reason : '';
}
