/** Structured rules edit as page drafts; previews use the same matcher as delivery. */
import type { ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { COGNITION_CONFIG_GROUP } from '../persona/config.ts';
import { conditionError, ruleError, decideFrame, type FrameMatch, type FrameRule } from '../persona/cognition.ts';
import { mountSettings, type SettingsDraft } from './config.ts';
import { createPreview } from './cognition-preview.ts';

const CONDITIONS: Array<[keyof FrameMatch, string]> = [
  ['world', 'World'], ['eventType', '事件类型'], ['sceneKind', '场景类型'], ['sceneKey', '场景 ID'], ['senderKey', '发送者 ID'],
];
export async function mountCognition(ctx: ConsolePanelContext): Promise<void> {
  await mountSettings(ctx, COGNITION_CONFIG_GROUP, '认知帧', (draft, host) => mountRules(ctx, draft, host));
}
function mountRules(ctx: ConsolePanelContext, draft: SettingsDraft, host: HTMLElement): void {
  const { ui } = ctx;
  const lists = ui.sheet({ title: '触发规则' });
  lists.body.append(ui.msgline('白名单强制触发；黑名单屏蔽；其余默认触发。同一规则的条件需全部满足。名单只控制认知帧。'));
  let kind = 'blacklist';
  let filter = '';
  let editor: HTMLElement | null = null;
  let editorChanged = false;
  let editorError: string | null = null;
  let refreshEditor: (() => void) | null = null;
  let removed: { kind: string; rule: FrameRule; index: number } | null = null;
  const rows = ui.h('div');
  const search = ui.input({ placeholder: '搜索名称、World、场景或发送者', onInput: (value) => { filter = value; render(); } });
  const selector = ui.segmented([{ value: 'blacklist', label: '黑名单' }, { value: 'whitelist', label: '白名单' }], { value: kind, onSelect: (value) => { kind = value; render(); } });
  const undo = ui.button('撤销删除', { onClick: () => {
    if (!removed) return;
    rules(removed.kind).splice(removed.index, 0, removed.rule); removed = null; changed();
  } });
  const bar = ui.rowbar(); bar.append(selector.el, search, ui.button('添加规则', { onClick: () => edit(kind) }), undo);
  lists.body.append(bar, rows);
  const preview = createPreview(ctx, draft, edit);
  host.append(lists.el, preview.el);
  const rules = (name: string): FrameRule[] => draft.values['cognition.' + name] as FrameRule[];
  draft.editing = () => !!editor?.isConnected && editorChanged;
  draft.validation = () => (editor?.isConnected ? editorError : null)
    || [...rules('whitelist'), ...rules('blacklist')].map((rule) => ruleError(rule)).find(Boolean) || null;
  draft.onRefresh = () => { preview.render(); if (editor?.isConnected) refreshEditor?.(); };
  draft.onReset = () => { removed = null; render(); preview.render(); };
  function changed(): void { draft.changed(); render(); preview.render(); }
  function render(): void {
    undo.disabled = !removed;
    const selected = rules(kind);
    const shown = selected.filter((rule) => JSON.stringify(rule).toLowerCase().includes(filter.toLowerCase()));
    const elements = shown.map((rule) => {
      const row = ui.rowbar();
      row.append(ui.checkbox(rule.label || '未命名规则', { checked: rule.enabled, onChange: (value) => { rule.enabled = value; changed(); } }).el,
        ui.h('span', 'mono', CONDITIONS.filter(([key]) => rule.match[key]).map(([key, label]) => {
          const value = rule.match[key]!;
          return label + '=' + (typeof value === 'string' ? value : '/' + value.pattern + '/' + (value.ignoreCase ? 'i' : ''));
        }).join(' · ') || '所有消息'),
        ui.button('编辑', { onClick: () => edit(kind, rule) }),
        ui.button('删除', { onClick: () => { const index = selected.indexOf(rule); removed = { kind, rule, index }; selected.splice(index, 1); changed(); } }));
      const error = ruleError(rule);
      const item = ui.h('div'); item.append(row);
      if (error) item.append(ui.msgline('规则已跳过：' + error, true));
      return item;
    });
    rows.replaceChildren(ui.msgline(selected.length + ' 条规则 · ' + shown.length + ' 条匹配搜索'), ...elements);
  }
  function edit(list: string, original?: FrameRule, initial?: FrameMatch): void {
    const body = ui.h('div', 'continuity-rule-form');
    editor = body; editorChanged = false; editorError = null;
    const rule: FrameRule = original ? structuredClone(original) : { id: crypto.randomUUID(), label: '', enabled: true, match: initial ?? {} };
    const name = ui.input({ value: rule.label, placeholder: '规则名称', onInput: (value) => { rule.label = value; editorChanged = true; show(); draft.changed(); } });
    name.maxLength = 160;
    const nameField = ui.field('名称', name); nameField.classList.add('continuity-rule-wide');
    body.append(nameField);
    const errors = new Map<keyof FrameMatch, string>();
    const validators: Array<() => void> = [];
    for (const [key, label] of CONDITIONS) {
      const current = rule.match[key];
      let mode = typeof current === 'object' ? 'regex' : 'exact';
      let ignoreCase = typeof current === 'object' ? current.ignoreCase : false;
      const input = ui.input({ value: typeof current === 'string' ? current : current?.pattern ?? '', placeholder: '留空匹配所有' });
      input.maxLength = 200;
      const error = ui.msgline('', true); error.id = 'rule-error-' + crypto.randomUUID();
      error.setAttribute('role', 'alert'); input.setAttribute('aria-describedby', error.id);
      const caseToggle = ui.checkbox('忽略大小写', { checked: ignoreCase, onChange: (value) => { ignoreCase = value; update(); } });
      const select = ui.select({ value: mode, options: [{ value: 'exact', label: '精确' }, { value: 'regex', label: '正则' }],
        onChange: (value) => { mode = value; update(); } });
      select.setAttribute('aria-label', label + '匹配方式');
      function validate(): void {
        const message = conditionError(rule.match[key] ?? '');
        if (message) errors.set(key, label + '：' + message); else errors.delete(key);
        error.textContent = message ?? ''; error.hidden = !message;
        input.setAttribute('aria-invalid', String(!!message));
        caseToggle.el.hidden = mode !== 'regex';
        if (mode === 'regex') input.removeAttribute('list'); else input.setAttribute('list', id);
      }
      function update(): void {
        rule.match[key] = mode === 'exact' ? input.value.trim() : { kind: 'regex', pattern: input.value, ignoreCase };
        validate(); editorChanged = true; show(); draft.changed();
      }
      input.addEventListener('input', update, { signal: ctx.signal });
      const id = 'rule-options-' + crypto.randomUUID();
      input.setAttribute('list', id);
      const suggestions = ui.h('datalist'); suggestions.id = id;
      const values = new Set((draft.state.recentEvents ?? []).map((event) => event[key]).filter(Boolean));
      if (key === 'sceneKind') for (const value of ['group', 'private', 'channel', 'scene', 'unknown']) values.add(value);
      for (const value of values) { const option = ui.h('option'); option.setAttribute('value', value); suggestions.append(option); }
      const controls = ui.rowbar(); controls.append(select, caseToggle.el);
      const field = ui.h('div'); field.dataset.condition = key;
      field.append(ui.field(label, input), controls, error, suggestions); body.append(field);
      validators.push(validate);
    }
    const enabled = ui.checkbox('启用', { checked: rule.enabled, onChange: (value) => { rule.enabled = value; editorChanged = true; show(); draft.changed(); } });
    enabled.el.classList.add('continuity-rule-wide'); body.append(enabled.el);
    const warning = ui.msgline(list === 'blacklist' ? '空条件会屏蔽全部认知帧。' : '空条件会强制触发全部认知帧。');
    warning.classList.add('continuity-rule-wide');
    const localPreview = ui.msgline();
    const apply = ui.button('加入页面草稿', { variant: 'primary', onClick: () => {
      if (editorError) return;
      const entries = rules(list);
      const index = entries.findIndex((entry) => entry.id === rule.id);
      if (index >= 0) entries.splice(index, 1, rule); else entries.push(rule);
      editorChanged = false; drawer.dispose(); changed();
    } });
    const show = (): void => {
      editorError = [...errors.values()][0] ?? ruleError(rule);
      apply.disabled = !!editorError;
      warning.hidden = Object.values(rule.match).some((value) => typeof value === 'string' ? !!value : !!value?.pattern);
      const events = (draft.state.recentEvents ?? []).slice(0, 200);
      const temporary = { blacklist: list === 'blacklist' ? [rule] : [], whitelist: list === 'whitelist' ? [rule] : [] };
      localPreview.textContent = editorError ? '修复条件后可预览' : '近期 ' + events.filter((event) => decideFrame(event, temporary).ruleId === rule.id).length + '/' + events.length + ' 条命中本规则';
    };
    refreshEditor = show;
    for (const validate of validators) validate(); show();
    const drawer = ui.drawer(original ? '编辑规则' : '添加' + (list === 'whitelist' ? '白名单' : '黑名单') + '规则', body);
    const observer = new MutationObserver(() => {
      if (!body.isConnected) {
        observer.disconnect();
        if (editor === body) { editorChanged = false; editorError = null; refreshEditor = null; draft.changed(); }
      }
    });
    observer.observe(body.getRootNode(), { childList: true, subtree: true });
    ctx.own({ dispose: () => observer.disconnect() });
    const actions = ui.actions();
    localPreview.classList.add('continuity-rule-wide'); actions.classList.add('continuity-rule-wide');
    const feedback = ui.h('div'); feedback.append(warning, localPreview);
    actions.append(feedback, ui.h('span', 'grow'), ui.button('取消', { onClick: () => { editorChanged = false; drawer.dispose(); draft.changed(); } }), apply);
    const help = ui.h('details', 'continuity-rule-wide');
    const summary = ui.h('summary', '', '正则语法与 dungeon 示例');
    help.append(summary, ui.msgline('整值匹配，默认区分大小写。支持字符组 [a-z]、分组 (...)、或 |、重复 * + ? {m,n}。不支持回溯引用与前后查找。输入表达式正文；/ 按字面字符匹配，大小写使用开关。'),
      ui.msgline('点号 . 匹配单个非换行字符；\\. 匹配字面点号。dungeon(\\..*)? 匹配 dungeon 及 dungeon.chat 等子类。也可建两条规则：精确 dungeon，加正则 dungeon\\..*。'));
    body.append(help, actions); draft.changed();
  }
  render(); preview.render();
}
