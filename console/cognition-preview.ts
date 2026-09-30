/** Preview fold keys include the deployment; polling retains the existing details nodes. */
import type { ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { decideFrame, type ObservedEvent, type FrameRule, type FrameValues } from '../persona/cognition.ts';
import type { SettingsDraft } from './config.ts';

interface PreviewGroup { el: HTMLDetailsElement; summary: HTMLElement; body: HTMLElement; limit: number }

export function createPreview(ctx: ConsolePanelContext, draft: SettingsDraft,
  edit: (list: string, original?: FrameRule, initial?: FrameValues) => void): { el: HTMLElement; render(): void } {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: '近期消息匹配预览 · 最近最多 200 条' });
  const host = ui.h('div');
  const groups = new Map<string, PreviewGroup>();
  let showTriggered = true;
  let showBlocked = true;
  const rules = (): { blacklist: FrameRule[]; whitelist: FrameRule[] } => ({
    blacklist: draft.values['cognition.blacklist'] as FrameRule[], whitelist: draft.values['cognition.whitelist'] as FrameRule[],
  });
  const key = (parts: string[]): string => 'preview:' + draft.state.deploymentKey + ':' + JSON.stringify(parts);
  function group(parts: string[], parent: HTMLElement): PreviewGroup {
    const id = key(parts);
    let existing = groups.get(id);
    if (!existing) {
      const el = ui.h('details', 'continuity-preview-group');
      const summary = ui.h('summary');
      const body = ui.h('div', 'continuity-preview-body');
      el.open = ctx.memo.get(id, parts.length === 1);
      el.dataset.previewGroup = JSON.stringify(parts);
      el.append(summary, body);
      el.addEventListener('toggle', () => ctx.memo.set(id, el.open), { signal: ctx.signal });
      existing = { el, summary, body, limit: 10 }; groups.set(id, existing);
    }
    if (existing.el.parentElement !== parent) parent.append(existing.el);
    return existing;
  }
  function expand(open: boolean): void {
    for (const [id, item] of groups) if (item.el.isConnected) { item.el.open = open; ctx.memo.set(id, open); }
  }
  const triggerFilter = ui.checkbox('触发', { checked: true, onChange: (value) => { showTriggered = value; render(); } });
  const blockedFilter = ui.checkbox('屏蔽', { checked: true, onChange: (value) => { showBlocked = value; render(); } });
  triggerFilter.el.dataset.previewFilter = 'trigger';
  blockedFilter.el.dataset.previewFilter = 'blocked';
  const actions = ui.rowbar();
  actions.append(triggerFilter.el, blockedFilter.el, ui.h('span', 'grow'),
    ui.button('全部展开', { onClick: () => expand(true) }), ui.button('全部折叠', { onClick: () => expand(false) }));
  sheet.body.append(ui.msgline('使用当前草稿；分类计数仅覆盖当前筛选的最近消息。'), actions, host);
  function title(label: string, events: ObservedEvent[]): string {
    const triggered = events.filter((event) => decideFrame(event, rules()).trigger).length;
    return label + ' · ' + events.length + ' 条 · 触发 ' + triggered + ' · 屏蔽 ' + (events.length - triggered);
  }
  function item(event: ObservedEvent): HTMLElement {
    const lists = rules();
    const decision = decideFrame(event, lists);
    const matched = [...lists.whitelist, ...lists.blacklist].find((rule) => rule.id === decision.ruleId);
    const row = ui.rowbar();
    row.append(ui.pill(decision.trigger ? '触发' : '屏蔽', decision.trigger ? 'on' : 'off'),
      ui.h('span', '', event.sceneKey + ' · ' + (event.senderKey || '无发送者')),
      ui.h('span', '', decision.reason === 'default' ? '默认' : (decision.reason === 'whitelist' ? '白名单：' : '黑名单：') + (matched?.label || decision.ruleId)),
      ui.button('设为黑名单', { onClick: () => edit('blacklist', undefined, { world: event.world, eventType: event.eventType, sceneKey: event.sceneKey, senderKey: event.senderKey }) }),
      ui.button('设为白名单', { onClick: () => edit('whitelist', undefined, { world: event.world, eventType: event.eventType, sceneKey: event.sceneKey, senderKey: event.senderKey }) }));
    const el = ui.h('div', 'continuity-preview-event'); el.dataset.cursor = String(event.cursor);
    el.append(row, ui.msgline(event.ts + ' · ' + event.text)); return el;
  }
  function render(): void {
    const events = (draft.state.recentEvents ?? []).slice(0, 200);
    const decisions = events.map((event) => ({ event, trigger: decideFrame(event, rules()).trigger }));
    triggerFilter.el.querySelector('span')!.textContent = '触发 ' + decisions.filter(({ trigger }) => trigger).length;
    blockedFilter.el.querySelector('span')!.textContent = '屏蔽 ' + decisions.filter(({ trigger }) => !trigger).length;
    const visible = decisions.filter(({ trigger }) => trigger ? showTriggered : showBlocked).map(({ event }) => event);
    const available = new Set(events.flatMap((event) => [key([event.world]), key([event.world, event.eventType])]));
    const worlds = new Map<string, Map<string, ObservedEvent[]>>();
    for (const event of visible) {
      let types = worlds.get(event.world);
      if (!types) { types = new Map(); worlds.set(event.world, types); }
      types.set(event.eventType, [...(types.get(event.eventType) ?? []), event]);
    }
    const retained = new Set<string>();
    for (const [world, types] of worlds) {
      const worldGroup = group([world], host); retained.add(key([world]));
      worldGroup.summary.textContent = title(world, [...types.values()].flat());
      for (const [type, messages] of types) {
        const typeGroup = group([world, type], worldGroup.body); retained.add(key([world, type]));
        typeGroup.summary.textContent = title(type, messages);
        const nodes: HTMLElement[] = messages.slice(0, typeGroup.limit).map(item);
        if (messages.length > typeGroup.limit) nodes.push(ui.button('再显示 10 条（剩余 ' + (messages.length - typeGroup.limit) + '）', {
          onClick: () => { typeGroup.limit += 10; render(); },
        }));
        typeGroup.body.replaceChildren(...nodes);
      }
    }
    for (const [id, old] of groups) if (!retained.has(id)) {
      old.el.remove();
      if (!available.has(id)) groups.delete(id);
    }
    if (!visible.length) host.replaceChildren(ui.msgline(events.length ? '当前筛选没有消息' : '尚无近期投递事件'));
    else for (const node of [...host.children]) if (node.tagName !== 'DETAILS') node.remove();
  }
  return { el: sheet.el, render };
}
