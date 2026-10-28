/** Migration controls sit beside the saved STATE review setting. */
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { SettingsDraft } from './config.ts';
import { MIGRATION_OPTIONS_GROUP, MIGRATION_DEFAULT_MINUTES, type MigrationState } from '../persona/state-migration/contracts.ts';

export function mountStateMigration(ctx: WebUiPanelContext, draft: SettingsDraft, host: HTMLElement): () => void {
  const { ui } = ctx;
  const row = ui.rowbar(); row.classList.add('continuity-state-migration');
  const status = ui.msgline();
  const feedback = ui.msgline('', true);
  let busy = false;
  const start = ui.button('迁移旧约束', { onClick: () => { void launch(); } });
  const cancel = ui.button('取消', { onClick: () => { void cancelTask(); } });
  row.append(start, status, cancel, feedback); host.prepend(row);
  const current = (): MigrationState => draft.state.stateMigration ?? { status: 'idle' };
  function render(): void {
    const field = ctx.root.querySelector('[data-state-review]');
    if (field) field.after(row);
    const migration = current(), review = draft.state.stateReview;
    row.hidden = !review?.enabled || !review.migrationPending && migration.status === 'idle';
    const active = ['running', 'waiting', 'applying'].includes(migration.status);
    start.hidden = active || migration.status === 'complete';
    start.disabled = busy || !review?.available;
    cancel.hidden = !active || migration.status === 'applying'; cancel.disabled = busy;
    cancel.textContent = migration.status === 'running' ? '取消' : '取消迁移';
    status.textContent = migration.status === 'running' ? '正在整理…' : migration.status === 'waiting' ? '待下次入梦应用'
      : migration.status === 'applying' ? 'Dream 正在应用' : migration.status === 'complete' ? 'STATE 已更新'
        : migration.status === 'failed' ? migration.reason ?? '整理失败' : '';
    status.hidden = !status.textContent;
  }
  async function refresh(): Promise<void> {
    const next = await ctx.invoke<typeof draft.state>('state');
    draft.state.stateMigration = next.stateMigration; draft.state.stateReview = next.stateReview;
    render();
  }
  async function launch(): Promise<void> {
    if (busy) return;
    busy = true; render(); feedback.textContent = '';
    try {
      if (!await ui.confirm({ title: '迁移旧约束', body: '将使用当前 LLM 和决策服务整理、验证 STATE。这会发起真实模型请求并消耗额度。\n\n整理完成后，STATE 将在下次正常入梦时更新。' })) return;
      const minutes = await durationDialog(ctx);
      if (minutes === null || ctx.signal.aborted) return;
      draft.state.stateMigration = await ctx.invoke<MigrationState>('startStateMigration', [minutes]);
    } catch (error) { feedback.textContent = String(error); }
    finally { busy = false; render(); }
  }
  async function cancelTask(): Promise<void> {
    if (busy) return;
    busy = true; render(); feedback.textContent = '';
    try { await ctx.invoke('cancelStateMigration'); await refresh(); }
    catch (error) { feedback.textContent = String(error); }
    finally { busy = false; render(); }
  }
  render();
  return render;
}

function durationDialog(ctx: WebUiPanelContext): Promise<number | null> {
  const { ui } = ctx;
  const property = MIGRATION_OPTIONS_GROUP.schema.properties.maxMinutes;
  const dialog = ui.h('dialog', 'continuity-migration-dialog');
  dialog.append(ui.h('h3', '', '开始迁移？'));
  const label = ui.h('label', '', `最长整理时间　${MIGRATION_DEFAULT_MINUTES} 分钟`);
  const slider = ui.h('input'); slider.type = 'range'; slider.min = String(property.minimum); slider.max = String(property.maximum);
  slider.step = String(property.multipleOf); slider.value = String(MIGRATION_DEFAULT_MINUTES); slider.setAttribute('aria-label', property.title);
  slider.addEventListener('input', () => { label.textContent = `最长整理时间　${slider.value} 分钟`; });
  dialog.append(label, slider, ui.msgline(`${property.minimum} 分钟 — ${property.maximum} 分钟`),
    ui.h('p', '', '过程可能持续一段时间，并持续消耗模型额度。整理完成后暂存候选，下次正常入梦时更新 STATE。'));
  const actions = ui.rowbar(); dialog.append(actions);
  ctx.root.append(dialog);
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return; settled = true; ctx.signal.removeEventListener('abort', abort); dialog.close(); dialog.remove(); resolve(value);
    };
    const abort = () => finish(null);
    actions.append(ui.button('返回', { onClick: () => finish(null) }), ui.button('开始迁移', { variant: 'primary', onClick: () => finish(Number(slider.value)) }));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    ctx.signal.addEventListener('abort', abort, { once: true });
    if (ctx.signal.aborted) finish(null); else dialog.showModal();
  });
}
