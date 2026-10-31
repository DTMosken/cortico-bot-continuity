/** bot 的服务端控制台入口。统一重置先回滚 Persona 工作区，再按清单顺序清除框架存储。 */
import type { StoragePart } from 'cortico/core/types.ts';
import type { WebUiCheckpointEntry, WebAppCheckpointDeps } from 'cortico/web/server.ts';
import type { GitStatus } from './base/persona/workspaceGit.ts';
import type { DreamStatus } from './persona/subconscious/index.ts';
import {
  pageIdFor,
  type WebUiPanelDecl,
  type WebUiPageContribution,
} from 'cortico/web/shared/webui-protocol.ts';

// ---------------------------------------------------------------------------
// 面板声明
// ---------------------------------------------------------------------------

/**
 * 统一重置与强制入梦的 bot 侧接口；人格领域类型由提供方持有。
 */
export interface CortiResetDeps {
  /** `parts` 是 `CortiOpsDeps.storage()` 给出的权威存储清单;实现决定执行顺序。 */
  run(checkpoint: string, parts: StoragePart[]): Promise<OpsResetResult>;
}

/** 手动强制"入梦→截断→唤醒"(人工操作)。 */
export interface CortiDreamDeps {
  /** 已在入梦或截断中则不重复触发,返回 ok:false 说明原因。 */
  trigger(): { ok: boolean; message: string };
  resume(): { ok: boolean; message: string };
}

export const CORTI_OPS_PANELS: WebUiPanelDecl[] = [
  { id: 'checkpoints', title: '存档点' },
  { id: 'reset', title: '统一重置' },
  { id: 'subagents', title: '子代理' },
  { id: 'dream', title: '梦' },
];

// ---------------------------------------------------------------------------
// 返回形状(浏览器面板以 import type 引用)
// ---------------------------------------------------------------------------

export interface OpsApplied {
  ok: true;
  result: string;
}

export interface OpsCheckpointsState {
  status: GitStatus;
  checkpoints: WebUiCheckpointEntry[];
}

/** 重置面板要展示"到底会清掉哪些东西",所以把清单的可显示部分一起回。 */
export type OpsStoragePart = Pick<StoragePart, 'key' | 'label' | 'kind' | 'location' | 'danger' | 'note'>;

/** 清单齐不齐。不齐就不许按下去——半次重置比不重置危险得多。`reason` 原样显示。 */
type Readiness = { ready: true; reason: null } | { ready: false; reason: string };

export type OpsResetState = Readiness & {
  status: GitStatus;
  checkpoints: WebUiCheckpointEntry[];
  parts: OpsStoragePart[];
};

export interface OpsResetResult {
  ok: boolean;
  persona: string;
  results: Array<{ key: string; ok: boolean; result: string }>;
}

/** `dream.trigger` / `dream.resume` 的回执:一句原样显示的话 + 之后的状态。 */
export interface OpsDreamResult {
  ok: boolean;
  message: string;
  state: DreamStatus;
}

// ---------------------------------------------------------------------------
// 重置的存储清单闸门
// ---------------------------------------------------------------------------

/** 重置要求权威存储清单中包含 session 和 events；核查键名，不依赖条目总数。 */
const REQUIRED_PART_KEYS = ['session', 'events'];

function readiness(parts: StoragePart[]): Readiness {
  const missing = REQUIRED_PART_KEYS.filter((k) => !parts.some((p) => p.key === k));
  if (missing.length === 0) return { ready: true, reason: null };
  return {
    ready: false,
    reason: `存储清单不完整（缺 ${missing.join(' / ')}），无法执行统一重置。`,
  };
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

export interface CortiOpsDeps {
  /** 这一页的名字(冒号后那截),必须等于 bot id:装配层才会把它与 Persona 自报的那半合成一页,asset key 才对得上按目录出的产物。 */
  name: string;
  checkpoints: WebAppCheckpointDeps;
  /** 介质状态(HEAD / 脏 / 存档点),存档点与重置两个面板都要显示 */
  status(): GitStatus;
  reset: CortiResetDeps;
  /** 重置要清的权威存储清单,由装配层从框架的页面上下文取得。 */
  storage(): StoragePart[];
  dream: CortiDreamDeps;
  dreamState(): DreamStatus;
  dreamConfigInvoke(method: string, args: unknown[]): Promise<unknown>;
  subagentsInvoke(method: string, args: unknown[]): Promise<unknown>;
}

async function runReset(deps: CortiOpsDeps, args: unknown[]): Promise<OpsResetResult> {
  const checkpoint = typeof args[0] === 'string' ? args[0].trim() : '';
  if (!checkpoint) throw new Error('缺少 checkpoint 名');
  const parts = deps.storage();
  const gate = readiness(parts);
  if (!gate.ready) throw new Error(gate.reason);
  return deps.reset.run(checkpoint, parts);
}

/**
 * `persona:<name>` 的部署操作；面板 id 与本包 webui/client.ts 一致。
 */
export function cortiWebUiPages(deps: CortiOpsDeps): WebUiPageContribution[] {
  return [{
    id: pageIdFor('persona', deps.name),
    kind: 'persona',
    // Persona 自报的那半先合并,页面标题取它的;这里只填必需字段。
    label: deps.name,
    panels: CORTI_OPS_PANELS,
    invoke: async (panel: string, method: string, args: unknown[]): Promise<unknown> => {
      if (panel === 'checkpoints') {
        switch (method) {
          case 'state':
            return { status: deps.status(), checkpoints: deps.checkpoints.list() } satisfies OpsCheckpointsState;
          case 'create': {
            const name = typeof args[0] === 'string' ? args[0].trim() : '';
            if (!name) throw new Error('缺少 checkpoint 名');
            const note = typeof args[1] === 'string' ? args[1] : '';
            return { ok: true, result: deps.checkpoints.create(name, note) } satisfies OpsApplied;
          }
          case 'remove': {
            const name = typeof args[0] === 'string' ? args[0].trim() : '';
            if (!name) throw new Error('缺少 checkpoint 名');
            return { ok: true, result: deps.checkpoints.remove(name) } satisfies OpsApplied;
          }
          // 存档点列表上的「回滚到此」与「统一重置」面板是同一次事务,
          // 走同一个 `runReset`——两个入口、一份实现。
          case 'rollback':
            return runReset(deps, args);
          default:
            throw new Error(`未知面板方法: ${panel}.${method}`);
        }
      }
      if (panel === 'reset') {
        if (method === 'state') {
          const parts = deps.storage();
          const gate = readiness(parts);
          const out: OpsResetState = {
            status: deps.status(),
            checkpoints: deps.checkpoints.list(),
            parts: parts.map((p) => ({
              key: p.key,
              label: p.label,
              kind: p.kind,
              ...(p.location ? { location: p.location } : {}),
              ...(p.danger ? { danger: true } : {}),
              ...(p.note ? { note: p.note } : {}),
            })),
            ...gate,
          };
          return out;
        }
        if (method === 'run') return runReset(deps, args);
        throw new Error(`未知面板方法: ${panel}.${method}`);
      }
      if (panel === 'subagents') return deps.subagentsInvoke(method, args);
      if (panel === 'dream') {
        if (method === 'state') return deps.dreamState();
        if (method === 'trigger' || method === 'resume') {
          const out = method === 'trigger' ? deps.dream.trigger() : deps.dream.resume();
          return { ...out, state: deps.dreamState() } satisfies OpsDreamResult;
        }
        const out = await deps.dreamConfigInvoke(method, args);
        return method === 'save' || method === 'saveDraft' ? { ...deps.dreamState(), ...out as object } : out;
      }
      throw new Error(`未知面板: ${panel}`);
    },
  }];
}
