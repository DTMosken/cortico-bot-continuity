import type { ConfigValue } from 'cortico/core/config-schema.ts';
import type { ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { PERSONA_CONFIG_GROUP } from '../persona/config.ts';
import { mountJevKey } from './jev-key.ts';

interface ConfigState {
  values: Record<string, ConfigValue>;
}

export async function mountConfig(ctx: ConsolePanelContext): Promise<void> {
  const { ui } = ctx;
  const options = await ctx.invoke<Array<{ value: string; label: string }>>('options');
  let state = await ctx.invoke<ConfigState>('state');
  const sheet = ui.sheet({ title: '配置' });
  const fields = ui.h('div');
  const status = ui.msgline();
  const key = ui.h('div');
  sheet.body.append(fields, status, key);
  ctx.root.replaceChildren(sheet.el);
  renderFields();
  await mountJevKey(ctx, key);

  ctx.interval(() => {
    void ctx.invoke<ConfigState>('state').then((next) => {
      if (JSON.stringify(next.values) !== JSON.stringify(state.values)) {
        state = next;
        renderFields();
      }
    }).catch(() => undefined);
  }, 2_000);

  async function save(path: string, value: ConfigValue): Promise<void> {
    try {
      state = await ctx.invoke<ConfigState>('save', [path, value]);
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
      rows.push(field);
      if (property.description) rows.push(ui.msgline(property.description));
    }
    fields.replaceChildren(...rows);
  }
}
