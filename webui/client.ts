/**
 * Persona 与 bot 声明的面板合并到同一浏览器产物。
 * 声明分别位于 ../persona/webUiSurface.ts 与 ../webui-page.ts。
 * 工作区与版本历史面板及取数、渲染小件在本包 base/webui/。
 */

import type { WebUiClientBundle } from 'cortico/web/shared/client-panel.ts';
import '../base/webui/style.css';
import { historyPanel } from '../base/webui/history.ts';
import { createWorkspacePanel } from '../base/webui/workspace.ts';
import { memoryPanel } from './memory.ts';
import { checkpointsPanel } from './checkpoints.ts';
import { resetPanel } from './reset.ts';
import { dreamPanel } from './dream.ts';
import { subagentsPanel } from './subagents.ts';
import { mountCognition } from './cognition.ts';
import { mountConfig } from './config.ts';

const bundle: WebUiClientBundle = {
  panels: {
    workspace: createWorkspacePanel({
      templates: [
        { value: 'blank', label: '空白' },
        { value: 'note', label: '笔记', body: (title) => `# ${title}\n\n` },
        {
          value: 'person',
          label: '人',
          body: (title) => `# ${title}\n\n## 关系\n\n## 已知事实\n\n## 待确认\n`,
        },
        { value: 'memo', label: '备忘', body: (title) => `# ${title}\n\n- 状态：active\n- 记录：\n` },
      ],
      defaultDir: 'note',
    }),
    memory: memoryPanel,
    history: historyPanel,
    checkpoints: checkpointsPanel,
    reset: resetPanel,
    subagents: subagentsPanel,
    dream: dreamPanel,
    config: { mount: mountConfig },
    cognition: { mount: mountCognition },
  },
};

export default bundle;
