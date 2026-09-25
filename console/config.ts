import type { ConfigValue } from 'cortico/core/config-schema.ts';
import type { ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { PERSONA_CONFIG_GROUP } from '../persona/config.ts';
import { createJevKey } from './jev-key.ts';

interface ConfigState {
  values: Record<string, ConfigValue>;
  provider: string;
  source: 'typesafe' | 'openrouter' | 'custom';
  keySet: boolean;
}

export async function mountConfig(ctx: ConsolePanelContext): Promise<void> {
  const { ui } = ctx;
  const options = await ctx.invoke<Array<{ value: string; label: string }>>('options');
  let state = await ctx.invoke<ConfigState>('state');
  const sheet = ui.sheet({ title: '配置' });
  const fields = ui.h('div');
  const status = ui.msgline();
  sheet.body.append(fields, status);
  ctx.root.replaceChildren(sheet.el);
  renderFields();

  ctx.interval(() => {
    void ctx.invoke<ConfigState>('state').then((next) => {
      if (JSON.stringify(next) !== JSON.stringify(state)) {
        state = next;
        renderFields();
      }
    }).catch(() => undefined);
  }, 2_000);

  async function save(path: string, value: ConfigValue): Promise<void> {
    try {
      await ctx.invoke('save', [path, value]);
      state = await ctx.invoke<ConfigState>('state');
      status.textContent = '已保存';
      status.classList.remove('bad');
    } catch (error) {
      status.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
      status.classList.add('bad');
    }
    renderFields();
  }

  function renderFields(): void {
    const rows: HTMLElement[] = [];
    for (const [path, property] of Object.entries(PERSONA_CONFIG_GROUP.schema.properties)) {
      if (path.startsWith('appraisal.laya.') && state.provider !== 'laya') continue;
      if (path.startsWith('appraisal.jev.') && state.provider !== 'jev') continue;
      if (path === 'appraisal.jev.endpoint' && state.source !== 'custom') continue;
      const value = state.values[path];
      const label = property['x-suffix'] ? `${property.title} (${property['x-suffix']})` : property.title;
      let field: HTMLElement;
      if (property.type === 'boolean') {
        field = ui.checkbox(label, {
          checked: value === true,
          onChange: (next) => { void save(path, next); },
        }).el;
      } else if (property.type === 'array') {
        const pair = Array.isArray(value) ? value : [0, 0];
        const first = ui.input({ type: 'number', value: String(pair[0]) });
        const second = ui.input({ type: 'number', value: String(pair[1]) });
        const commit = (): void => { void save(path, [Number(first.value), Number(second.value)]); };
        first.addEventListener('change', commit, { signal: ctx.signal });
        second.addEventListener('change', commit, { signal: ctx.signal });
        const controls = ui.h('div');
        controls.append(first, ui.h('span', '', '–'), second);
        field = ui.field(label, controls);
      } else if (property.enum || property['x-options']) {
        const choices = property.enum
          ? property.enum.map((item) => ({ value: item, label: item }))
          : options.map((item) => ({ value: item.value, label: item.label }));
        if (!choices.some((item) => item.value === value)) {
          choices.unshift({ value: String(value ?? ''), label: String(value ?? '') });
        }
        field = ui.field(label, ui.select({
          value: String(value ?? ''),
          options: choices,
          onChange: (next) => { void save(path, next); },
        }));
      } else {
        field = ui.field(label, ui.input({
          type: property.type === 'integer' || property.type === 'number' ? 'number' : 'text',
          value: value == null ? '' : String(value),
          onChange: (next) => {
            void save(path, property.type === 'integer' || property.type === 'number'
              ? next === '' && property.nullable ? null : Number(next)
              : next);
          },
        }));
      }
      if (path === 'appraisal.jev.source') {
        const row = ui.rowbar();
        row.append(field, createJevKey(ctx, state));
        rows.push(row);
      } else rows.push(field);
      if (path === 'appraisal.provider') {
        const testStatus = ui.msgline();
        const test = ui.button('测试连接', { onClick: () => {
          test.disabled = true;
          testStatus.textContent = '测试中…';
          testStatus.classList.remove('bad');
          void ctx.invoke<{ ok: boolean; error?: string }>('testConnection').then((out) => {
            testStatus.textContent = out.ok ? '连接成功' : `连接失败：${out.error || '模型没有返回有效评估'}`;
            testStatus.classList.toggle('bad', !out.ok);
          }).catch((error) => {
            testStatus.textContent = `连接失败：${error instanceof Error ? error.message : String(error)}`;
            testStatus.classList.add('bad');
          }).finally(() => { test.disabled = false; });
        } });
        test.disabled = state.provider === 'random';
        const testRow = ui.rowbar();
        testRow.append(test, testStatus);
        rows.push(testRow);
      }
      if (property.description) rows.push(ui.msgline(property.description));
    }
    fields.replaceChildren(...rows);
  }
}
