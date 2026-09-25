import type { ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';

interface KeyState {
  source: 'typesafe' | 'openrouter' | 'custom';
  keySet: boolean;
}

export function createJevKey(ctx: ConsolePanelContext, current: KeyState): HTMLElement {
  const { ui } = ctx;
  const sourceName = current.source === 'openrouter' ? 'OpenRouter'
    : current.source === 'typesafe' ? 'TypeSafe' : '自定义 Jev';
  const message = ui.msgline(current.keySet ? '密钥已配置' : '密钥未配置');
  const open = ui.button(`打开 ${sourceName} 密钥文件`, {
    onClick: () => {
      open.disabled = true;
      void ctx.invoke<{ file: string }>('openKeyFile', [current.source]).then(({ file }) => {
        message.textContent = `已打开 ${file}`;
        message.classList.remove('bad');
      }).catch((error) => {
        message.textContent = `打开失败：${error instanceof Error ? error.message : String(error)}`;
        message.classList.add('bad');
      }).finally(() => { open.disabled = false; });
    },
  });
  const actions = ui.rowbar();
  actions.append(message, open);
  return actions;
}
