/** 统一重置面板：先回滚工作区，再按服务端清单清除存储，session 最后重建。清单不完整时禁止执行。 */

import type {
  WebUiPanelContext,
  WebUiPanel,
} from 'cortico/web/shared/client-panel.ts';
import { autoload, carriedMsg, errText, gitLine, setMsg, type CarriedMsg } from '../base/webui/shared.ts';
import type { OpsResetResult, OpsResetState } from '../webui-page.ts';

export const resetPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const notice = carriedMsg();
    autoload<OpsResetState>(ctx, {
      loading: '读取重置范围…',
      failed: '统一重置不可用',
      load: () => ctx.invoke<OpsResetState>('state'),
      render: (st, reload) => [runCard(ctx, st, notice, reload), scopeCard(ctx, st)],
    });
  },
};

function runCard(ctx: WebUiPanelContext, st: OpsResetState, notice: CarriedMsg, reload: () => void): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '统一重置',
    desc: '将工作区回滚到选定存档点，再按清单清除存储。',
  });

  const bar = ui.rowbar();
  bar.append(ui.pill(gitLine(st.status), st.status.repo ? 'on' : 'off'), ui.h('span', 'grow'));
  card.body.appendChild(bar);
  const msg = ui.msgline('');
  notice.show(msg);

  if (!st.ready) {
    card.body.append(ui.placeholder(st.reason), msg);
    return card.el;
  }
  if (!st.checkpoints.length) {
    card.body.append(ui.placeholder('没有可用存档点，请先在「存档点」面板创建。'), msg);
    return card.el;
  }

  const pick = ui.select({
    options: st.checkpoints.map((c) => ({
      value: c.name,
      label: `${c.name} · ${c.hash}${c.message ? ` · ${c.message}` : ''}`,
    })),
  });
  const run = ui.button('回滚并清空', {
    variant: 'danger',
    onClick: () => { void execute(ctx, pick.value, { msg, btn: run, notice, reload }); },
  });
  const line = ui.actions();
  line.append(msg, ui.h('span', 'grow'), run);
  card.body.append(ui.field('回滚到', pick), line);
  return card.el;
}

/** 执行重置所需的面板部件：失败写入 msg；成功的回执经 notice 带到 reload 后的面板。 */
export interface ResetView {
  msg: HTMLElement;
  btn: HTMLButtonElement;
  notice: CarriedMsg;
  reload: () => void;
}

async function execute(ctx: WebUiPanelContext, checkpoint: string, view: ResetView): Promise<void> {
  const { ui } = ctx;
  const first = await ui.confirm({
    title: `回滚到存档点「${checkpoint}」并清空全部存储?`,
    body: '工作区恢复到该存档点，然后清除清单中的全部存储。已提交的工作区版本可查询；清除的数据不可恢复。',
    danger: true,
  });
  if (!first) return;
  const second = await ui.confirm({
    title: '再确认',
    body: `确认回滚到「${checkpoint}」并清除清单中的全部存储？`,
    danger: true,
  });
  if (!second) return;
  await runReset(ctx, 'run', checkpoint, view);
}

/**
 * 执行统一重置并刷新面板；存档点面板的回滚共用此流程。
 * 回执在刷新后仍显示，部分失败标红并打开逐项结果。
 */
export async function runReset(
  ctx: WebUiPanelContext,
  method: 'run' | 'rollback',
  checkpoint: string,
  view: ResetView,
): Promise<void> {
  const { ui } = ctx;
  const busy = ui.busy('正在重置', '正在回滚工作区并清除存储。');
  view.btn.disabled = true;
  try {
    const out = await ctx.invoke<OpsResetResult>(method, [checkpoint]);
    const bad = out.results.filter((r) => !r.ok);
    view.notice.keep(
      `${out.ok ? '✓ ' : '部分失败: '}${out.persona};清理 ${out.results.length} 项`
      + (bad.length ? `(${bad.map((r) => r.key).join('、')} 失败)` : ''),
      bad.length > 0,
    );
    if (bad.length) {
      ui.drawer('逐项结果', out.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.key}: ${r.result}`).join('\n'));
    }
    view.reload();
  } catch (err) {
    setMsg(view.msg, `重置失败: ${errText(err)}`, true);
  } finally {
    busy.dispose();
    view.btn.disabled = false;
  }
}

function scopeCard(ctx: WebUiPanelContext, st: OpsResetState): HTMLElement {
  const { ui } = ctx;
  const card = ui.sheet({
    title: '清除范围',
    desc: '工作区回滚后按清单逐项清除。session 最后清除，并用回滚后的工作区重建前缀。',
  });
  if (!st.parts.length) {
    card.body.appendChild(ui.placeholder('拿不到存储清单'));
    return card.el;
  }
  const table = ui.table({ head: ['项', '位置', '清掉之后'] });
  for (const p of st.parts) {
    const name = ui.h('span', null, p.label);
    const cell = ui.h('div', 'ct-cellops');
    cell.append(name);
    if (p.danger) cell.appendChild(ui.pill('不可恢复', 'off'));
    table.addRow([
      { el: cell },
      { text: p.location ?? (p.kind === 'memory' ? '(内存)' : '—'), cls: 'mono' },
      { text: p.note ?? '—', cls: 'txt' },
    ]);
  }
  card.body.appendChild(table.el);
  return card.el;
}
