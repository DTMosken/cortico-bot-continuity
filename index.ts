import { resolve } from 'node:path';

import type { BotDefinition, BotParts, ConsoleContribution } from 'cortico/bot.ts';
import type { World, ModelSpec } from 'cortico/core/types.ts';
import type { LoadedConfig } from 'cortico/deploy.ts';
import { CORE_DEFAULTS } from 'cortico/core/config.ts';
import type { WorldDeclaration } from 'cortico/world.ts';
import type { WebAppCheckpointDeps } from 'cortico/web/server.ts';

import { ContinuityPersona } from './persona/index.ts';
import {
  cortiConsolePages,
  type CortiResetDeps,
} from './console-page.ts';
import { AUTHOR_OPERATOR } from './base/persona/workspaceGit.ts';
import { jevSource, PERSONA_DEFAULTS } from './persona/config.ts';
import type { PersonaConfig } from './persona/config.ts';

import { type QQConfigSection } from 'cortico/worlds/qq/config.ts';
import type { TerminalConfigSection } from 'cortico/worlds/terminal/config.ts';
import type { TerminalWorld } from 'cortico/worlds/terminal/world.ts';
import { type WebSearchConfigSection } from 'cortico/worlds/websearch/config.ts';
import type { CoreConfig } from 'cortico/core/types.ts';

export type { QQConfigSection, WebSearchConfigSection };

/**
 * 部署级配置组合 CoreConfig 与Persona及各挂载 World 的配置声明。
 * CoreConfig 保持框架边界,额外配置由各挂载方拥有。
 */
export interface BotConfig extends CoreConfig {
  /** 阶段长度三项与首轮对话开关归 Persona,摘思维链归 core;同住 context 段。 */
  context: CoreConfig['context'] & PersonaConfig['context'];
  loop: PersonaConfig['loop'];
  memo: PersonaConfig['memo'];
  tick: PersonaConfig['tick'];
  dream: PersonaConfig['dream'];
  appraisal?: PersonaConfig['appraisal'];
  cognition?: PersonaConfig['cognition'];
  subagents?: PersonaConfig['subagents'];
  worlds: {
    qq: QQConfigSection;
    terminal: TerminalConfigSection;
    websearch: WebSearchConfigSection;
  };
}

/** 这个Persona为之设计的渠道,默认启用。 */
const DECLARES: readonly WorldDeclaration[] = ['qq', 'terminal', 'websearch'];

/** 层 2 给云端那条端点的模型档:全局端点表里没写时用它。 */
const DEEPSEEK_SPEC: ModelSpec = {
  model: 'deepseek-flash',
  thinking: true,
  reasoningEffort: 'low',
  temperature: 1.0,
};

/** 层1+层2:框架默认 ← Persona的建议。World 段由启动器补。 */
export function composeDefaults(): BotConfig {
  return {
    ...CORE_DEFAULTS,
    providers: {
      ...structuredClone(CORE_DEFAULTS.providers),
      // 模型归 provider:云端那条端点默认跑哪个模型是部署事实,不是Persona的选择。
      deepseek: { ...structuredClone(CORE_DEFAULTS.providers.deepseek), kind: 'deepseek', spec: { ...DEEPSEEK_SPEC } },
    },
    displayName: 'Continuity',
    web: { ...CORE_DEFAULTS.web, theme: 'crab-daisy' },
    paths: { ...CORE_DEFAULTS.paths },
    batching: { ...CORE_DEFAULTS.batching },
    // context 分属两方:阶段长度三项归Persona,摘思维链两项归 core 的 LLM 层
    context: { ...PERSONA_DEFAULTS.context, ...CORE_DEFAULTS.context },
    loop: PERSONA_DEFAULTS.loop,
    memo: PERSONA_DEFAULTS.memo,
    tick: PERSONA_DEFAULTS.tick,
    dream: structuredClone(PERSONA_DEFAULTS.dream),
    cognition: structuredClone(PERSONA_DEFAULTS.cognition),
    subagents: structuredClone(PERSONA_DEFAULTS.subagents),
    appraisal: structuredClone(PERSONA_DEFAULTS.appraisal),
  } as unknown as BotConfig;
}

export function build(loaded: LoadedConfig<BotConfig>, worlds: World[]): BotParts<BotConfig> {
  const cfg = loaded.config;
  if (cfg.appraisal) cfg.appraisal.jev.source ??= jevSource(cfg.appraisal.jev);
  const persona = new ContinuityPersona({
    memoryDir: loaded.memoryDir,
    cfg,
    deploymentDir: loaded.rootDir,
    dataDir: loaded.dataDir,
    getSecret: loaded.secret,
    worlds: worlds,
    // 首轮对话由部署提供；同名模板覆盖包内默认。
    firstTurnDir: resolve(loaded.rootDir, 'prompts'),
    promptsDir: resolve(loaded.rootDir, 'prompts'),
  });

  return {
    persona,
    // Persona拥有工作区版本管理与昼夜心跳生命周期。
    onStart: ({ core }) => {
      persona.initGit(core.runlog.logger('persona.git'));
      persona.setSubagentsRuntime(core);
      persona.startRhythm();
    },
    onStop: async () => {
      persona.stopRhythm();
      persona.stopSubagents();
      await persona.dispose();
    },
    console: consoleContribution(loaded, { persona, worlds }),
  };
}


interface ConsoleParts {
  persona: ContinuityPersona;
  /** 挂载表的活引用 */
  worlds: World[];
}

function consoleContribution(loaded: LoadedConfig<BotConfig>, p: ConsoleParts): ConsoleContribution {
  const cfg = loaded.config;
  const { persona, worlds } = p;
  // 梦在 core attach 后创建;控制台通过闭包延迟取值。
  const dream = () => persona.dream;
  const terminal = (): TerminalWorld | undefined => worlds.find((m) => m.id === 'terminal') as TerminalWorld | undefined;

  // 各 World 的环境提示词由 World 自报(console().promptDocs);这里只声明Persona自己那份。
  const promptDocs = [{
    key: 'orientation',
    title: 'ORIENTATION',
    description: 'Persona的存在方式与元认知说明。',
    path: persona.textFile('ORIENTATION.md'),
    deploymentPath: persona.textWritePath('ORIENTATION.md'),
  }];

  const checkpointDeps: WebAppCheckpointDeps = {
    list: () => persona.git.listTags(),
    create: (name, note) => {
      persona.git.tag(name, note, AUTHOR_OPERATOR);
      return `checkpoint「${name}」已创建`;
    },
    remove: (name) => {
      persona.git.deleteTag(name);
      return `checkpoint「${name}」已删除`;
    },
  };

  // 顺序要紧:persona 先回滚,storage 的 session 项(order 10 最后清)清完即用
  // 回滚后的 persona 重建前缀,保证"重开"落在该 checkpoint 的世界上。
  const resetDeps: CortiResetDeps = {
    run: async (checkpoint, parts) => {
      let note = '';
      try {
        persona.git.checkoutTag(checkpoint);
        note = `persona 已回滚到 checkpoint「${checkpoint}」`;
      } catch (e) {
        throw new Error(`回滚 persona 失败,未清数据: ${String(e)}`);
      }
      const ordered = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const results: Array<{ key: string; ok: boolean; result: string }> = [];
      for (const part of ordered) {
        try {
          results.push({ key: part.key, ok: true, result: String(await part.clear()) });
        } catch (err) {
          results.push({ key: part.key, ok: false, result: String(err) });
        }
      }
      return { ok: results.every((r) => r.ok), persona: note, results };
    },
  };

  // 强制入梦(那一页的「梦」面板数据面):走统一交接入口,交接后梦在后台跑。
  const dreamDeps = {
    resume: (): { ok: boolean; message: string } => dream().resumePending()
      ? { ok: true, message: '已继续未完成整理' }
      : { ok: false, message: '没有待处理材料，或梦已在进行中' },
    trigger: (): { ok: boolean; message: string } => {
      if (!dream().forceDreamAndTruncate()) {
        return { ok: false, message: '入梦或交接已经在进行中,没有重复触发' };
      }
      return { ok: true, message: '已触发交接;交接完成后梦在后台整理工作区' };
    },
  };

  return {
    promptDocs,
    // 梦 session 的工具 schema。
    extraToolSchemas: () => dream().getBaseToolSchemas(),
    status: () => ({
      // 「梦」是人格概念,框架不认识它:自报成一枚通用筹码,状态条照文本画。
      chips: dream().getStatus().dreaming ? [{ label: '梦中', tone: 'accent' }] : [],
      terminalOnline: terminal()?.onlineCount() ?? 0,
      memo: { residentCap: cfg.memo.residentCap, activeCap: cfg.memo.activeCap },
      // Persona的阶段预算与软预警线(终端页上下文圈的分母与黄线);计数与物理上限由 core 报
      context: {
        maxTokens: cfg.context.maxTokens,
        softRatio: cfg.context.softRatio,
      },
    }),
    /**
     * 部署操作页与 Persona 面板共用同一页 id。
     *
     * 认知绑定的三块(工作区 / Memory / 版本历史)不在这里,由Persona自报
     * (`ContinuityPersona.console()`)。
     */
    consolePages: (ctx) => cortiConsolePages({
      name: definition.id,
      label: `${cfg.displayName || definition.id} · 部署`,
      checkpoints: checkpointDeps,
      status: () => persona.git.status(),
      reset: resetDeps,
      // 框架在问这一页时把**权威**清单交进来(core 派生 + 各 World
      // console().storage + 本 bot 追加),与 /api/storage 看到的是同一批对象。
      // 统一重置要清的正是它们;bot 自己再拼一份就是两套实现。
      storage: () => [...ctx.storage],
      dream: dreamDeps,
      dreamState: () => ({ ...dream().getStatus(), ...persona.configState('dream') }),
      dreamConfigInvoke: (method, args) => persona.configInvoke('dream', method, args),
      subagentsInvoke: (method, args) => persona.subagentsInvoke(method, args),
    }),
  };
}

const definition: BotDefinition<BotConfig> = {
  id: 'continuity',
  // 工作区即记忆,由 Git 记账;分层记忆建在它上面。
  memoryName: 'GitMem',
  declares: DECLARES,
  defaults: composeDefaults,
  build,
};

export default definition;
