/** Declared scalar settings use page drafts; polling leaves dirty controls intact. */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { GENERAL_CONFIG_GROUP } from '../persona/config.ts';
import type { CognitionConfig, ObservedEvent } from '../persona/cognition.ts';
import { createJevKey } from './jev-key.ts';

export interface SettingsState {
  values: Record<string, unknown>; revision?: string; provider: string;
  source: 'typesafe' | 'openrouter' | 'custom'; keySet: boolean; keys?: Record<string, boolean>;
  rules?: CognitionConfig; recentEvents?: ObservedEvent[];
}
export interface SettingsDraft {
  values: Record<string, unknown>; state: SettingsState; changed(): void;
  onRefresh?: (state: SettingsState) => void; onReset?: () => void; editing?: () => boolean;
}

export async function mountSettings(ctx: ConsolePanelContext, group: ConfigGroup, title: string,
  extend?: (draft: SettingsDraft, host: HTMLElement) => void): Promise<void> {
  const { ui } = ctx;
  const cognitive = group.id === 'continuity-cognition';
  const options = cognitive ? await ctx.invoke<Array<{ value: string; label: string }>>('options') : [];
  let saved = await ctx.invoke<SettingsState>('state');
  const flatten = (state: SettingsState): Record<string, unknown> => ({
    ...state.values, ...(cognitive ? { 'cognition.blacklist': state.rules?.blacklist ?? [], 'cognition.whitelist': state.rules?.whitelist ?? [] } : {}),
  });
  const draft: SettingsDraft = { values: structuredClone(flatten(saved)), state: saved, changed: () => paintStatus() };
  const sheet = ui.sheet({ title });
  const fields = ui.h('div');
  const extra = ui.h('div');
  const status = ui.msgline();
  const save = ui.button('保存整页', { variant: 'primary', onClick: () => { void commit(); } });
  const reset = ui.button('重新加载', { onClick: () => { void reload(); } });
  const actions = ui.actions(); actions.append(status, ui.h('span', 'grow'), reset, save);
  sheet.body.append(fields, extra, actions);
  ctx.root.replaceChildren(sheet.el);
  extend?.(draft, extra);
  const dirty = (): boolean => JSON.stringify(draft.values) !== JSON.stringify(flatten(saved)) || !!draft.editing?.();
  ctx.guardLeave(() => dirty() ? '此页有未保存的配置，离开将丢弃草稿。' : null);
  renderFields(); paintStatus();
  ctx.interval(() => {
    void ctx.invoke<SettingsState>('state').then((next) => {
      if (ctx.signal.aborted) return;
      if (!dirty() && JSON.stringify(flatten(next)) !== JSON.stringify(flatten(saved))) {
        saved = next; draft.values = structuredClone(flatten(next)); renderFields(); draft.onReset?.();
      } else if (!dirty()) { saved = next; }
      draft.state = next;
      draft.onRefresh?.(next);
    }).catch(() => undefined);
  }, 4000);

  function paintStatus(): void {
    const changed = dirty();
    save.disabled = !changed;
    status.textContent = changed ? '未保存；保存后从下一批投递生效' : '已保存';
    status.classList.remove('bad');
  }
  async function reload(): Promise<void> {
    if (dirty() && !await ui.confirm({ title: '丢弃未保存草稿并重新加载？' })) return;
    saved = await ctx.invoke<SettingsState>('state');
    draft.state = saved; draft.values = structuredClone(flatten(saved));
    renderFields(); draft.onReset?.(); draft.onRefresh?.(saved); paintStatus();
  }
  async function commit(): Promise<void> {
    const controls = ui.disable(save, reset);
    try {
      saved = await ctx.invoke<SettingsState>('saveDraft', [draft.values, saved.revision]);
      draft.state = saved; draft.values = structuredClone(flatten(saved));
      renderFields(); draft.onReset?.(); paintStatus();
    } catch (error) {
      status.textContent = '保存失败：' + (error instanceof Error ? error.message : String(error)); status.classList.add('bad');
    } finally { controls.dispose(); save.disabled = !dirty(); }
  }
  function change(path: string, value: unknown, rerender = false): void {
    draft.values[path] = value;
    if (rerender) renderFields();
    paintStatus();
  }
  function renderFields(): void {
    const rows: HTMLElement[] = [];
    const provider = String(draft.values['appraisal.provider'] ?? saved.provider);
    const source = String(draft.values['appraisal.jev.source'] || saved.source || 'typesafe') as SettingsState['source'];
    for (const [path, property] of Object.entries(group.schema.properties)) {
      if (path.endsWith('blacklist') || path.endsWith('whitelist')) continue;
      if (path.startsWith('appraisal.laya.') && provider !== 'laya') continue;
      if (path.startsWith('appraisal.jev.') && provider !== 'jev') continue;
      if (path === 'appraisal.jev.endpoint' && source !== 'custom') continue;
      const value = draft.values[path];
      const label = property['x-suffix'] ? property.title + ' (' + property['x-suffix'] + ')' : property.title;
      let field: HTMLElement;
      if (property.type === 'boolean') {
        field = ui.checkbox(label, { checked: value === true, onChange: (next) => change(path, next) }).el;
      } else if (property.type === 'array') {
        const pair = Array.isArray(value) ? value : [0, 0];
        const first = ui.input({ type: 'number', value: String(pair[0]) });
        const second = ui.input({ type: 'number', value: String(pair[1]) });
        const update = (): void => change(path, [Number(first.value), Number(second.value)]);
        first.addEventListener('input', update, { signal: ctx.signal });
        second.addEventListener('input', update, { signal: ctx.signal });
        const controls = ui.rowbar(); controls.append(first, ui.h('span', '', '–'), second);
        field = ui.field(label, controls);
      } else if (property.enum || property['x-options']) {
        const choices = property.enum ? property.enum.map((item) => ({ value: item, label: item })) : [...options];
        if (!choices.some((item) => item.value === value)) choices.unshift({ value: String(value ?? ''), label: String(value ?? '') });
        field = ui.field(label, ui.select({ value: String(value ?? ''), options: choices,
          onChange: (next) => change(path, next, path === 'appraisal.provider' || path === 'appraisal.jev.source' || path === 'appraisal.laya.variant') }));
      } else {
        const numeric = property.type === 'integer' || property.type === 'number';
        const input = ui.input({ type: numeric ? 'number' : 'text', value: value == null ? '' : String(value),
          onInput: (next) => change(path, numeric ? next === '' && property.nullable ? null : Number(next) : next) });
        if (numeric) { if (property.minimum !== undefined) input.min = String(property.minimum);
          if (property.maximum !== undefined) input.max = String(property.maximum); input.step = String(property.multipleOf ?? (property.type === 'integer' ? 1 : 'any')); }
        field = ui.field(label, input);
      }
      if (path === 'appraisal.jev.source') {
        const row = ui.rowbar(); row.append(field, createJevKey(ctx, { source, keySet: draft.state.keys?.[source] ?? (source === saved.source && saved.keySet) })); rows.push(row);
      } else rows.push(field);
      if (property.description) rows.push(ui.msgline(property.description));
      if (path === 'appraisal.provider') {
        const result = ui.msgline('连接测试使用已保存配置');
        const test = ui.button('测试连接', { onClick: () => {
          test.disabled = true; result.textContent = '测试中…';
          void ctx.invoke<{ ok: boolean; error?: string }>('testConnection').then((out) => {
            result.textContent = out.ok ? '连接成功（已保存配置）' : '连接失败：' + (out.error ?? '评估不可用');
            result.classList.toggle('bad', !out.ok);
          }).catch((error) => { result.textContent = String(error); result.classList.add('bad'); })
            .finally(() => { test.disabled = saved.provider === 'random'; });
        } }); test.disabled = saved.provider === 'random';
        const row = ui.rowbar(); row.append(test, result); rows.push(row);
      }
    }
    fields.replaceChildren(...rows);
  }
}
export async function mountConfig(ctx: ConsolePanelContext): Promise<void> {
  await mountSettings(ctx, GENERAL_CONFIG_GROUP, '配置');
}
