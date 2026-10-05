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
    const tasks = ctx.ui.sheet({ title: '子代理任务' });
    tasks.el.classList.add('continuity-subagent-tasks');
    const settings = ctx.ui.h('div');
    ctx.root.replaceChildren(settings, tasks.el);
    await mountSettings<SubagentsState>({ ...ctx, root: settings }, SUBAGENTS_CONFIG_GROUP, '额度与权限',
      (draft, host) => mountSubagents(ctx, draft, host, tasks.body), { folded: true });
  },
};

function mountSubagents(ctx: ConsolePanelContext, draft: SettingsDraft<SubagentsState>, host: HTMLElement, tasks: HTMLElement): void {
  const { ui } = ctx;
  draft.pendingMessage = '未保存';
  draft.validation = () => Number(draft.values['subagents.softRounds']) >= Number(draft.values['subagents.maxRounds'])
    ? '轮数提醒起点必须小于硬结束轮次' : null;
  const note = ui.msgline('权限保存后生效；主线说明需手动重载系统前缀。新任务使用新额度，运行中的任务保持启动额度。');
  const groups = ui.h('div');
  host.append(note, groups);
  const expanded = new Set<string>();
  let taskOffset = 0;
  let taskPage: TaskPage | null = null;
  let source = '';
  let status = '';
  let permissionsKey = '';
  let tasksKey = '';
  const overview = ui.rowbar();
  const filters = ui.h('div', 'continuity-subagent-filters');
  const list = ui.h('div', 'continuity-subagent-list');
  const pages = ui.rowbar();
  const errors = ui.msgline(); errors.setAttribute('role', 'status');
  const sourceFilter = ui.select({ value: '', options: [
    { value: '', label: '全部来源' }, { value: 'main', label: '主线' }, { value: 'world', label: 'World' },
  ], onChange: value => { source = value; void loadTasks(0); } });
  const statusFilter = ui.select({ value: '', options: [
    { value: '', label: '全部状态' }, ...Object.entries(STATUS).map(([value, label]) => ({ value, label })),
  ], onChange: value => { status = value; void loadTasks(0); } });
  filters.append(ui.field('任务来源', sourceFilter), ui.field('任务状态', statusFilter));
  tasks.append(overview, filters, errors, list, pages);
  draft.onRefresh = () => {
    renderPermissions();
    if (taskOffset || source || status) void loadTasks(taskOffset);
    else { taskPage = null; renderTasks(); }
  };
  draft.onReset = () => { renderPermissions(); renderTasks(); };

  function permissions(group: ToolGroup, key: string): ToolPermissions {
    const map = draft.values[key] as Record<string, ToolPermissions>;
    return { enabled: map[group.id]?.enabled ?? group.enabled,
      tools: Object.fromEntries(group.tools.map(tool => [tool.name, map[group.id]?.tools[tool.name] ?? tool.allowed])) };
  }
  function toggle(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLButtonElement {
    const button = ui.button('', { onClick: () => { onChange(button.getAttribute('aria-checked') !== 'true'); draft.changed(); renderPermissions(); } });
    button.className = 'continuity-subagent-switch';
    button.setAttribute('role', 'switch'); button.setAttribute('aria-label', label); button.setAttribute('aria-checked', String(checked));
    return button;
  }
  function renderPermissions(): void {
    const key = JSON.stringify([draft.state.groups, draft.state.cognitionGroups, draft.values['subagents.permissions'], draft.values['subagents.cognitionPermissions'], [...expanded]]);
    if (key === permissionsKey) return;
    permissionsKey = key;
    const active = groups.ownerDocument.activeElement;
    const focusLabel = active && groups.contains(active) ? active.getAttribute('aria-label') : null;
    const sections = [
      { key: 'subagents.permissions', title: '主线子代理权限', groups: draft.state.groups,
        note: '主线发起任务时，仍需选择本次使用的工具。Memory 只读；World 工具还需对主线可见。' },
      { key: 'subagents.cognitionPermissions', title: 'World扩展子代理权限', groups: draft.state.cognitionGroups,
        note: 'World 仅可请求自己的工具，默认允许。隐藏 World 仍可发起任务；关闭本组会停止它的在途任务。Memory 沿用上方已开启的只读工具。' },
    ];
    groups.replaceChildren(...sections.map(section => {
      const block = ui.h('section', 'continuity-subagent-permissions');
      const cards = ui.h('div', 'continuity-subagent-groups');
      block.append(ui.h('h3', '', section.title), ui.msgline(section.note), cards);
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
        renderPermissions();
      } });
      detail.setAttribute('aria-expanded', String(expanded.has(section.key + '/' + group.id)));
      detail.setAttribute('aria-label', group.label + ' ' + section.title + ' 工具明细');
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
    if (focusLabel) [...groups.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === focusLabel)?.focus();
  }
  function renderTasks(): void {
    const page = taskPage ?? { tasks: draft.state.records, total: draft.state.total, nextOffset: draft.state.nextOffset };
    const key = JSON.stringify([page, draft.state.running, draft.state.values['subagents.enabled'], draft.state.values['subagents.maxWorkers'], draft.state.total, taskOffset, source, status]);
    if (key === tasksKey) return;
    tasksKey = key;
    const enabled = draft.state.values['subagents.enabled'] === true;
    overview.replaceChildren(ui.pill(enabled ? '已启用' : '已关闭', enabled ? 'on' : 'off'),
      ui.h('span', '', '运行中 ' + draft.state.running + '/' + draft.state.values['subagents.maxWorkers']),
      ui.msgline('共 ' + draft.state.total + ' 项'));
    const cards: HTMLElement[] = [];
    for (const task of page.tasks) {
      const card = ui.h('article', 'continuity-subagent-task');
      card.setAttribute('aria-label', task.task);
      const title = ui.h('h4', 'continuity-subagent-task-title', task.task);
      const state = ui.rowbar();
      state.append(ui.pill(STATUS[task.status], task.status === 'complete' ? 'on' : 'plain'), ui.msgline(reasonText(task.endReason)));
      const context = ui.msgline((task.source === 'world' ? 'World · ' + task.worldId : '主线') + ' · ' + (task.context === 'main' ? '主线上下文快照' : '独立上下文'));
      const usage = ui.h('div', 'continuity-subagent-usage');
      usage.append(ui.msgline('模型轮数 ' + task.rounds + '/' + task.maxRounds),
        ui.msgline('单次输入峰值 ' + (task.peakInputTokens == null ? '未知' : task.peakInputTokens.toLocaleString() + ' token')));
      const actions = ui.h('div', 'continuity-subagent-actions');
      actions.append(ui.button('查看结果', { onClick: () => { showResult(task); } }));
      if (task.reminders.length) actions.append(ui.button(task.reminders.length + ' 条提醒', { onClick: () => {
        const body = ui.h('div', 'continuity-subagent-reminders');
        const evidence = ui.h('div');
        for (const reminder of task.reminders) {
          const row = ui.rowbar();
          row.append(ui.msgline(reminder.index + ' · ' + reminder.summary), ui.button('读取提醒 ' + reminder.index, { onClick: () => {
            const result = resultReader(task.id, reminder.index);
            evidence.replaceChildren(ui.h('h4', '', '提醒 ' + reminder.index), result.body);
            void result.read();
          } }));
          body.append(row);
        }
        body.append(evidence);
        ui.drawer('任务提醒 · ' + task.task, body);
      } }));
      if (task.status === 'running' || task.status === 'stopping') {
        const cancel = ui.button(task.status === 'stopping' ? '停止中…' : '取消任务', { onClick: () => { void cancelTask(task.id, cancel); } });
        cancel.disabled = task.status === 'stopping'; actions.append(cancel);
      }
      card.append(title, context, state, ui.h('p', 'continuity-subagent-summary', task.summary || '暂无摘要'), usage, actions);
      cards.push(card);
    }
    list.replaceChildren(...cards);
    const previous = ui.button('上一页任务', { onClick: () => { void loadTasks(Math.max(0, taskOffset - 20)); } }); previous.disabled = taskOffset === 0;
    const next = ui.button('下一页任务', { onClick: () => { if (page.nextOffset !== null) void loadTasks(page.nextOffset); } }); next.disabled = page.nextOffset === null;
    pages.replaceChildren(ui.msgline(page.total ? '第 ' + (taskOffset + 1) + '–' + (taskOffset + page.tasks.length) + ' 项 / ' + page.total : '0 项'), ui.h('span', 'grow'), previous, next);
    if (!page.tasks.length) list.append(ui.placeholder(source || status ? '没有符合筛选条件的任务。' : '暂无任务。'));
  }
  async function loadTasks(offset: number): Promise<void> {
    taskOffset = offset;
    const requestedSource = source, requestedStatus = status;
    try {
      const page = await ctx.invoke<TaskPage>('list', [{ offset, limit: 20, ...(source ? { source } : {}), ...(status ? { status } : {}) }]);
      if (ctx.signal.aborted || taskOffset !== offset || source !== requestedSource || status !== requestedStatus) return;
      if (offset && !page.tasks.length) { await loadTasks(Math.max(0, offset - 20)); return; }
      errors.textContent = ''; taskPage = page; renderTasks();
    } catch (error) { errors.textContent = String(error); errors.classList.add('bad'); }
  }
  async function cancelTask(taskId: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await ctx.invoke('spawn', [{ mode: 'cancel', taskId }]);
      draft.state = await ctx.invoke<SubagentsState>('state');
      if (taskOffset || source || status) await loadTasks(taskOffset); else { taskPage = null; renderTasks(); }
    } catch (error) { button.disabled = false; errors.textContent = String(error); errors.classList.add('bad'); }
  }
  function showResult(task: SubagentsState['records'][number]): void {
    const result = resultReader(task.id);
    ui.drawer('任务结果 · ' + task.task, result.body);
    void result.read();
  }
  function resultReader(taskId: string, reminderIndex?: number): { body: HTMLElement; read(): Promise<void> } {
    const body = ui.h('div', 'continuity-subagent-result');
    const text = ui.h('pre', 'mono');
    const status = ui.msgline('读取中…');
    let offset = 0;
    const next = ui.button('读取下一页', { onClick: () => { void read(); } });
    next.disabled = true;
    body.append(ui.msgline(taskId), status, text, next);
    async function read(): Promise<void> {
      next.disabled = true;
      try {
        const page = await ctx.invoke<ResultPage>('get', [{ taskId, offsetChars: offset, ...(reminderIndex === undefined ? {} : { reminderIndex }) }]);
        if (ctx.signal.aborted || !body.isConnected) return;
        status.textContent = STATUS[page.status] + (page.nextOffset === null ? ' · 已到末尾' : ''); text.textContent += page.result;
        if (page.nextOffset !== null) { offset = page.nextOffset; next.disabled = false; }
      } catch (error) { status.textContent = String(error); status.classList.add('bad'); }
    }
    return { body, read };
  }
  renderPermissions(); renderTasks();
}

function reasonText(reason?: string): string {
  const labels: Record<string, string> = { natural: '自然结束', finish: '主动结束', ends_turn: '工具结束任务', round_limit: '轮数用尽', context_limit: '上下文已满', cancelled: '取消请求', timeout: '超过时限', disabled: '子代理已关闭', world_disabled: 'World 权限已关闭', shutdown: '停止运行', world_unmounted: 'World 已卸载', world_unmounted_or_restarted: 'World 已卸载或重启', process_restart: '进程已重启', error: '执行错误' };
  return reason ? labels[reason] ?? reason : '';
}
