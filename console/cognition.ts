/** Structured rules edit as page drafts; previews use the same matcher as delivery. */
import type { ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { COGNITION_CONFIG_GROUP } from '../persona/config.ts';
import { decideFrame, type FrameMatch, type FrameRule } from '../persona/cognition.ts';
import { mountSettings, type SettingsDraft } from './config.ts';

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
  const preview = ui.sheet({ title: '近期消息匹配预览' });
  const previews = ui.h('div');
  preview.body.append(ui.msgline('预览使用当前草稿。候选来自最近投递事件，也可手填 ID。'), previews);
  host.append(lists.el, preview.el);
  const rules = (name: string): FrameRule[] => draft.values['cognition.' + name] as FrameRule[];
  draft.editing = () => !!editor?.isConnected && editorChanged;
  draft.onRefresh = () => renderPreview();
  draft.onReset = () => { removed = null; render(); renderPreview(); };
  function changed(): void { draft.changed(); render(); renderPreview(); }
  function render(): void {
    undo.disabled = !removed;
    const selected = rules(kind);
    const shown = selected.filter((rule) => JSON.stringify(rule).toLowerCase().includes(filter.toLowerCase()));
    const elements = shown.map((rule) => {
      const row = ui.rowbar();
      row.append(ui.checkbox(rule.label || '未命名规则', { checked: rule.enabled, onChange: (value) => { rule.enabled = value; changed(); } }).el,
        ui.h('span', 'mono', CONDITIONS.filter(([key]) => rule.match[key]).map(([key, label]) => label + '=' + rule.match[key]).join(' · ') || '所有消息'),
        ui.button('编辑', { onClick: () => edit(kind, rule) }),
        ui.button('删除', { onClick: () => { const index = selected.indexOf(rule); removed = { kind, rule, index }; selected.splice(index, 1); changed(); } }));
      return row;
    });
    rows.replaceChildren(ui.msgline(selected.length + ' 条规则 · ' + shown.length + ' 条匹配搜索'), ...elements);
  }
  function edit(list: string, original?: FrameRule, initial?: FrameMatch): void {
    const body = ui.h('div');
    editor = body; editorChanged = false;
    const rule: FrameRule = original ? structuredClone(original) : { id: crypto.randomUUID(), label: '', enabled: true, match: initial ?? {} };
    const name = ui.input({ value: rule.label, placeholder: '规则名称', onInput: (value) => { rule.label = value; editorChanged = true; draft.changed(); } });
    body.append(ui.field('名称', name));
    for (const [key, label] of CONDITIONS) {
      const input = ui.input({ value: rule.match[key] ?? '', placeholder: '留空匹配所有', onInput: (value) => { rule.match[key] = value.trim(); editorChanged = true; draft.changed(); } });
      const id = 'rule-options-' + crypto.randomUUID();
      input.setAttribute('list', id);
      const suggestions = ui.h('datalist'); suggestions.id = id;
      const values = new Set((draft.state.recentEvents ?? []).map((event) => event[key]).filter(Boolean));
      if (key === 'sceneKind') for (const value of ['group', 'private', 'channel', 'scene', 'unknown']) values.add(value);
      for (const value of values) { const option = ui.h('option'); option.setAttribute('value', value); suggestions.append(option); }
      body.append(ui.field(label, input), suggestions);
    }
    body.append(ui.checkbox('启用', { checked: rule.enabled, onChange: (value) => { rule.enabled = value; editorChanged = true; draft.changed(); } }).el);
    const warning = ui.msgline('条件留空的规则匹配所有消息；在黑名单中会屏蔽全部认知帧。');
    const localPreview = ui.msgline();
    const show = (): void => {
      const events = draft.state.recentEvents ?? [];
      const temporary = { blacklist: list === 'blacklist' ? [rule] : [], whitelist: list === 'whitelist' ? [rule] : [] };
      localPreview.textContent = '近期 ' + events.filter((event) => decideFrame(event, temporary).ruleId === rule.id).length + '/' + events.length + ' 条命中本规则';
    };
    body.addEventListener('input', show, { signal: ctx.signal }); show();
    const drawer = ui.drawer(original ? '编辑规则' : '添加' + (list === 'whitelist' ? '白名单' : '黑名单') + '规则', body);
    const actions = ui.actions();
    actions.append(ui.button('取消', { onClick: () => { editorChanged = false; drawer.dispose(); draft.changed(); } }),
      ui.button('加入页面草稿', { variant: 'primary', onClick: () => {
        const entries = rules(list);
        if (original) entries.splice(entries.indexOf(original), 1, rule); else entries.push(rule);
        editorChanged = false; drawer.dispose(); changed();
      } }));
    body.append(warning, localPreview, actions);
  }
  function renderPreview(): void {
    const events = (draft.state.recentEvents ?? []).slice(0, 30);
    const nodes = events.map((event) => {
      const decision = decideFrame(event, { blacklist: rules('blacklist'), whitelist: rules('whitelist') });
      const row = ui.rowbar();
      const matched = [...rules('whitelist'), ...rules('blacklist')].find((rule) => rule.id === decision.ruleId);
      row.append(ui.pill(decision.trigger ? '触发' : '屏蔽', decision.trigger ? 'on' : 'off'),
        ui.h('span', '', event.world + ' · ' + event.sceneKey + ' · ' + (event.senderKey || '无发送者')),
        ui.h('span', '', decision.reason === 'default' ? '默认' : (decision.reason === 'whitelist' ? '白名单：' : '黑名单：') + (matched?.label || decision.ruleId)),
        ui.button('设为黑名单', { onClick: () => edit('blacklist', undefined, { world: event.world, sceneKey: event.sceneKey, senderKey: event.senderKey }) }),
        ui.button('设为白名单', { onClick: () => edit('whitelist', undefined, { world: event.world, sceneKey: event.sceneKey, senderKey: event.senderKey }) }));
      const item = ui.h('div'); item.append(row, ui.msgline(event.ts + ' · ' + event.text)); return item;
    });
    previews.replaceChildren(...(nodes.length ? nodes : [ui.msgline('尚无近期投递事件')]));
  }
  render(); renderPreview();
}

