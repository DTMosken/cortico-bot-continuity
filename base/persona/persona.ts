/**
 * 文件式工作区 Persona：声明 session 与工具，装配前缀，管理心跳、上下文压力和交接。
 * memory.ts 提供存储，workspaceTools.ts 与 blobs.ts 提供工具，handoffNote.ts 渲染交接笔记。
 * protected 成员供 ContinuityPersona 继承，不属于公共 API。
 */
import type { ToolSpec } from 'cortico/core/types.ts';
import { readTextFile } from 'cortico/core/util.ts';
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderSections, renderTemplate } from 'cortico/core/template.ts';
import { pick, type Language } from 'cortico/core/language.ts';
import { historyPanelDecl, workspaceInvoke, workspacePanelDecl } from './webUiSurface.ts';
import { HANDOFF_NOTE_TYPE, handoffNoteStamp, renderHandoffNote } from './handoffNote.ts';
import { saveBlobTool } from './blobs.ts';
import { BLOBS_DIR, GitWorkspaceMemory, type WorkspaceBlobStore } from './memory.ts';
import { workspaceTools } from './workspaceTools.ts';
import { Heartbeat, quietLine } from './heartbeat.ts';
import type { ContextRecord, Item } from 'cortico/protocol/open-responses/context.ts';
import type {
  ContextHandoffResult,
  EventEnvelope,
  CoreApi,
  World,
  WorldLifecycleEvent,
  OutputTap,
  PersonaWebUiDecl,
  Persona,
  PrefixSegment,
  PromptDocDecl,
  SessionDecl,
  SessionOpeningReason,
  SystemPrefixContext,
  ToolDef,
  ToolTag,
} from 'cortico/core/types.ts';
import { defaultExternalizes } from 'cortico/core/types.ts';

/**
 * 合成首轮对话(风格锚)三段的源文件名,住在部署目录的 `prompts/` 下。
 * 内容是部署者手写的私有文本,代码包不带默认;文件缺失或为空 = 不注入。
 */
export const FIRST_TURN_FILES = {
  user: 'FIRST_TURN_USER.md',
  thinking: 'FIRST_TURN_THINKING.md',
  reply: 'FIRST_TURN_REPLY.md',
} as const;

/** 控制台段名与可编辑源映射，不写入前缀。 */
const CORMINI_SEGMENT_TITLES: Record<string, string> = {
  'persona.orientation': 'ORIENTATION',
  'persona.constitution': 'CONSTITUTION',
  'persona.workspace': 'WORKSPACE',
};

const CORMINI_SEGMENT_SOURCES: Record<string, string> = {
  'persona.orientation': 'orientation',
  'persona.constitution': 'constitution',
};

const CONSTITUTION_FILE = 'CONSTITUTION.md';
/** 主 session 声明 id(子类的 sessionInfo 查询也用它) */
export const MAIN = 'main';
/** 交接笔记目录:每次交接一份,文件名是 UTC 时间戳(见 handoffNoteStamp) */
export const HANDOFF_DIR = 'handoffs/';

/** 前缀工作区清单里折叠为一行计数的目录。 */
const PREFIX_FOLDS: ReadonlyArray<{ prefix: string; line: (n: number) => string }> = [
  {
    prefix: HANDOFF_DIR,
    line: (n) => `${HANDOFF_DIR} (${n} 份交接笔记;list_files 指定 dir 为 ${HANDOFF_DIR.replace(/\/$/, '')} 可列出全部)`,
  },
  {
    prefix: BLOBS_DIR,
    line: (n) => `${BLOBS_DIR} (${n} 份二进制;list_files 指定 dir 为 ${BLOBS_DIR.replace(/\/$/, '')} 可列出全部,read_file 看图)`,
  },
];

/** 软轮数上限那一轮拼在回执末尾的提醒。 */
const SOFT_CAP_HINT = '[system] 这一轮已经连续行动很多步。手上的事做完就调 end_turn 结束这一轮。';

/** 软阈值那一轮的速记提醒。 */
const PRESSURE_NOTE =
  '[system] 交接快来了。交接会把上文全部清空,清空前最近的一段会写成交接笔记送到新会话。' +
  '很早以前的事里,你还在跟的、还想做的,现在就写进文件,再过一会儿上下文就没了。';

/**
 * 显式结束本次唤醒的 yield 工具，仅挂在主 session。fork 以最后一段文本作为返回值，不挂终止工具。
 */
export function endTurnTool(): ToolDef {
  return {
    ...BASE_TOOL_DECLS[0],
    barrierAfter: true,
    endsTurn: true,
    handler: async () => '[turn ended]'
  };
}

/** 阶段预算、软阈值比例和交接笔记预算比例。 */
export interface ContextStagePolicy {
  maxTokens: number;
  softRatio: number;
  keepRatio: number;
  /** 是否把部署 prompts/ 里的首轮对话作为合成开头送进请求;内容为空时不送。 */
  firstTurn: boolean;
}

export const CORMINI_CONTEXT_DEFAULTS: ContextStagePolicy = { maxTokens: 64000, softRatio: 0.85, keepRatio: 1 / 3, firstTurn: false };

export interface CorminiOptions {
  /** 工作区目录 = 记忆。不存在则创建。 */
  memoryDir: string;
  /** 上下文阶段裁量。每次现读,控制台改了即生效;不给=CORMINI_CONTEXT_DEFAULTS。 */
  context?: () => ContextStagePolicy;
  /**
   * 工作区还没有宪法时写进去的初始文本(出厂内容)。
   * 只在首次创建时用一次;之后这份文件归 bot 与运维,种子不再覆盖它。
   */
  seedConstitution?: string;
  /** 单次唤醒的工具循环上限 */
  rounds?: { soft: number; hard: number };
  /**
   * 已挂载 World。工具表由Persona声明(schema/handler 归人格),
   * core 只按可见性摘掉隐藏 World 的那些名字。
   */
  worlds?: World[];
  /**
   * 存在方式自述的源文件。Persona把它自报为可编辑的静态前缀源(Persona卡
   * 与「设置 → 静态前缀」共用同一份);前缀每次从它现读。
   */
  orientationFile: string;
  /**
   * 这份自述在**部署侧**的覆盖文件。存在就用它(前缀与控制台读同一份),不存在则用
   * 包里那份;控制台保存一律写到这里——部署者微调出来的提示词是私有资产,不进代码包。
   */
  orientationOverrideFile?: string;
  /**
   * 首轮对话(风格锚)三份源文件所在目录,即这份部署的 `prompts/`。
   * 不给 = 这个Persona没有首轮对话(不注入,控制台也不列源)。
   */
  firstTurnDir?: string;
  /**
   * 心跳基线:距下次主动 tick 的毫秒数,null=现在不心跳。不给=从不心跳,
   * 纯被动人格。连着空拍时基线逐次翻倍(见 heartbeat.ts);World 要更密的
   * 唤醒就自己投 flush 事件。
   */
  tickDelayMs?: (now: Date) => number | null;
  /** save_blob 不带目录的名字提示落进哪个工作区子目录。不给=blobs/。 */
  blobsDir?: string;
}

/** 控制台文案,两种语言各一张表;`en: typeof zh` 由 tsc 保证键集一致。 */
const CONSOLE_TEXT = {
  zh: {
    orientation: 'Persona的存在方式与元认知说明。',
    constitution: 'Persona 的长期原则。重载系统前缀或开始新上下文后生效。',
    workspaceLabel: '工作区(她自己写的记忆文件)',
    workspaceNote: '宪法之外的全部工作区文件不可恢复地删除;宪法与人格检查点不动',
    workspaceStat: (n: number) => `${n}个文件(宪法之外)`,
    workspaceCleared: (n: number) => `已删除 ${n} 个工作区文件;宪法未动`,
    firstTurnUser: '首轮·用户输入',
    firstTurnUserDesc: '合成首轮对话的 user 消息。与回复任一为空则整轮不注入。',
    firstTurnThinking: '首轮·思维链',
    firstTurnThinkingDesc: '合成首轮 assistant 的思维链(reasoning_content);为空则该轮不带。注:openai-responses-compat 方言不回传思维链,这段在该类端点上不出线。',
    firstTurnReply: '首轮·回复',
    firstTurnReplyDesc: '合成首轮对话的 assistant 回复正文。',
  },
  en: {
    orientation: 'How the Persona exists and its metacognition notes.',
    constitution: 'The Persona\'s long-term principles. Changes take effect after a system prefix reload or when a new context starts.',
    workspaceLabel: 'Workspace (memory files she wrote herself)',
    workspaceNote: 'Every workspace file except the constitution is deleted irrecoverably; the constitution and persona checkpoints are untouched',
    workspaceStat: (n: number) => `${n} file${n === 1 ? '' : 's'} (besides the constitution)`,
    workspaceCleared: (n: number) => `Deleted ${n} workspace file${n === 1 ? '' : 's'}; the constitution is untouched`,
    firstTurnUser: 'First turn · user input',
    firstTurnUserDesc: 'The user message of the synthesized first turn. When either this or the reply is empty, the whole turn is not injected.',
    firstTurnThinking: 'First turn · reasoning',
    firstTurnThinkingDesc: 'The reasoning (reasoning_content) of the synthesized first assistant turn; empty = the turn carries none. The openai-responses-compat dialect does not return reasoning, so this part never goes on the wire for such endpoints.',
    firstTurnReply: 'First turn · reply',
    firstTurnReplyDesc: 'The assistant reply text of the synthesized first turn.',
  },
};

export abstract class Cormini implements Persona {
  readonly memoryDir: string;
  protected readonly caps: { soft: number; hard: number };
  /** 挂载表的活引用(装配层与 core 共用);用时按 id 排序,顺序决定前缀缓存命中。 */
  private readonly worlds: World[];
  private readonly orientationFile: string;
  private readonly orientationOverrideFile: string | null;
  protected readonly firstTurnDir: string | null;
  private readonly heartbeat: Heartbeat;
  protected core: CoreApi | null = null;
  protected readonly context: () => ContextStagePolicy;
  /** 软压力速记提醒已注入(交接时重置) */
  protected pressureWarned = false;
  /** 这一批第一次投递的时刻(epoch ms);批末清空 */
  protected batchOpenedAt: number | null = null;
  /** 越过软阈值那一批的开始时刻(epoch ms);交接后重置 */
  protected pressureSplitAt: number | null = null;
  /** 最近一份交接笔记的工作区路径;子类的 read_file 遇到它时让她改用事件正文 */
  protected lastHandoffFile: string | null = null;
  readonly memory: GitWorkspaceMemory;
  /** 工作区二进制附件；mem: 句柄保存相对路径。 */
  readonly blobs: WorkspaceBlobStore;

  constructor(opts: CorminiOptions) {
    this.memory = new GitWorkspaceMemory({
      memoryDir: opts.memoryDir,
      ...(opts.blobsDir !== undefined ? { blobsDir: opts.blobsDir } : {}),
      // attach 前使用 console；闭包在调用时选择当前日志入口。
      warn: (msg, data) => {
        if (this.core) this.core.log.warn(msg, data);
        else console.warn(`[workspaceGit] ${msg}`, data ?? '');
      },
    });
    this.memoryDir = this.memory.memoryDir;
    this.blobs = this.memory.blobs;
    this.context = opts.context ?? ((): ContextStagePolicy => CORMINI_CONTEXT_DEFAULTS);
    this.caps = opts.rounds ?? { soft: 6, hard: 12 };
    this.orientationFile = opts.orientationFile;
    this.orientationOverrideFile = opts.orientationOverrideFile ?? null;
    this.firstTurnDir = opts.firstTurnDir ?? null;
    this.worlds = opts.worlds ?? [];
    const baseline = opts.tickDelayMs ?? ((): null => null);
    this.heartbeat = new Heartbeat(
      baseline,
      () => {
        // 心跳文本在投递时按当前安静时长生成，并以同一文本入库。
        this.core?.injectDeferred('tick', () => this.tickText(this.heartbeat.quietSeconds()));
      },
    );
    this.memory.seed([[
      CONSTITUTION_FILE,
      opts.seedConstitution ?? '# Who I am\n\n(Write here, or let the bot write here.)\n',
    ]]);
  }

  attach(core: CoreApi): void {
    this.core = core;
  }

  /** 心跳那一行的文本(投递刻渲染);变体覆写(如带上时刻)。 */
  protected tickText(quietSeconds: number): string {
    return quietLine(quietSeconds);
  }

  /** 此刻该读哪份自述:部署侧有覆盖就是它,否则是包里那份。 */
  protected orientationSource(): string {
    return this.orientationOverrideFile && existsSync(this.orientationOverrideFile)
      ? this.orientationOverrideFile
      : this.orientationFile;
  }

  /** 按界面语言声明控制台文案；源 key、路径与清除动作保持一致。 */
  webUi(language: Language = 'zh'): PersonaWebUiDecl {
    const t = pick(language, CONSOLE_TEXT);
    return {
      promptDocs: [
        {
          key: 'orientation',
          title: 'ORIENTATION',
          description: t.orientation,
          path: this.orientationSource(),
          ...(this.orientationOverrideFile ? { deploymentPath: this.orientationOverrideFile } : {}),
        },
        {
          key: 'constitution',
          title: 'CONSTITUTION',
          description: t.constitution,
          path: join(this.memoryDir, CONSTITUTION_FILE),
        },
        ...this.firstTurnDocs(language),
      ],
      memory: {
        panels: [workspacePanelDecl(language), historyPanelDecl(language)],
        // 工作区记忆跨场保留，但属于“清除所有数据”的范围。宪法由人格检查点管理，不随数据清除。
        storage: [
          {
            key: 'workspace',
            label: t.workspaceLabel,
            kind: 'disk',
            location: 'workspace/',
            danger: true,
            note: t.workspaceNote,
            stat: () => t.workspaceStat(this.workspaceFiles().length),
            clear: () => {
              const files = this.workspaceFiles();
              for (const f of files) rmSync(join(this.memoryDir, f), { force: true });
              return t.workspaceCleared(files.length);
            },
          },
        ],
      },
      invoke: workspaceInvoke(this.memory),
    };
  }

  /** 工作区里可清除的文件:宪法之外的全部(walk 本就跳过点开头,.git 不在其中) */
  private workspaceFiles(): string[] {
    return this.memory.walkFiles().filter((f) => f !== CONSTITUTION_FILE);
  }

  startRhythm(): void {
    this.heartbeat.start();
  }

  stopRhythm(): void {
    this.heartbeat.stop();
  }


  /**
   * 前缀 = 一份顶层装配模板 + 若干段模板,全部可编辑。段的数量、顺序、标题与
   * 分隔样式都在 `PREFIX.md` 里,代码只负责把值算出来。
   */
  async systemSegments(ctx: SystemPrefixContext): Promise<PrefixSegment[]> {
    // 每个 World 独占前缀段,使可见性变更保持原子性;段的外壳套同一份模板。
    const envSection = readTextFile(this.templateFile('ENV_SECTION.md'));
    const moduleSections = ctx.worlds
      .filter((m) => m.envPrompt.trim())
      .map((m) => ({
        id: m.id,
        sourceKey: m.sourceKey,
        text: renderTemplate(envSection, {
          'world.id': m.id,
          'world.envPrompt': m.envPrompt.trim(),
        }).trimEnd(),
      }));

    const rendered = renderSections(readTextFile(this.templateFile('PREFIX.md')), {
      ...this.prefixVars(ctx),
      'worlds.envPrompts': moduleSections.map((s) => s.text).join('\n'),
    });

    const sources = this.segmentSources();
    const titles = this.segmentTitles();

    return rendered.sections.flatMap((section): PrefixSegment[] => {
      if (section.name !== 'worlds.envPrompts') {
        return [{
          title: titles[section.name] ?? section.name,
          text: section.text,
          ...(sources[section.name] ? { sourceKey: sources[section.name] } : {}),
        }];
      }
      if (moduleSections.length === 0) return [{ title: 'ENVIRONMENT(无)', text: section.text }];
      // 段内 World 正文之前的模板文字给第一段,之后的给最后一段。
      const joined = moduleSections.map((s) => s.text).join('\n');
      const at = section.text.indexOf(joined);
      const lead = at < 0 ? '' : section.text.slice(0, at);
      const tail = at < 0 ? '' : section.text.slice(at + joined.length);
      const last = moduleSections.length - 1;
      return moduleSections.map((s, i) => ({
        title: `ENVIRONMENT · ${s.id}`,
        text: (i === 0 ? lead : '\n') + s.text + (i === last ? tail : ''),
        ...(s.sourceKey ? { sourceKey: s.sourceKey } : {}),
      }));
    });
  }

  /** PREFIX.md、ENV_SECTION.md 等模板的路径;模板随子类的软件包走。 */
  protected abstract templateFile(name: string): string;

  /** 前缀模板各占位符的值(`worlds.envPrompts` 由 systemSegments 自己算);子类覆写成自己的那组。 */
  protected prefixVars(_ctx: SystemPrefixContext): Record<string, string> {
    return {
      'persona.orientation': readTextFile(this.orientationSource()).trim(),
      'persona.constitution': readTextFile(join(this.memoryDir, CONSTITUTION_FILE)).trim(),
      'persona.workspace': this.prefixWorkspaceListing(),
    };
  }

  /** 段名 → 控制台标签(不进前缀)。 */
  protected segmentTitles(): Record<string, string> {
    return CORMINI_SEGMENT_TITLES;
  }

  /** 段名 → 可编辑源的 promptDoc key。 */
  protected segmentSources(): Record<string, string> {
    return CORMINI_SEGMENT_SOURCES;
  }

  /**
   * 合成开头 = 首轮对话(风格锚):三份源文件各一段,开关 context.firstTurn。user 或 reply
   * 为空白时整轮不送,文件缺失当空,其他读取错误照常抛出。item id 固定:内容不变时每次请求的前缀逐字相同。
   */
  sessionHead(): Item[] {
    const dir = this.firstTurnDir;
    if (!dir || !this.context().firstTurn) return [];
    const read = (name: string): string => {
      try {
        return readTextFile(join(dir, name)).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    };
    const user = read(FIRST_TURN_FILES.user);
    const reply = read(FIRST_TURN_FILES.reply);
    if (!user || !reply) return [];
    const thinking = read(FIRST_TURN_FILES.thinking);
    const items: Item[] = [
      { type: 'message', id: 'msg_first_turn_user', status: 'completed', role: 'user', content: [{ type: 'input_text', text: user }] },
    ];
    if (thinking) items.push({ type: 'reasoning', id: 'rs_first_turn', summary: [], content: [{ type: 'reasoning_text', text: thinking }] });
    items.push({ type: 'message', id: 'msg_first_turn_reply', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: reply, annotations: [] }] });
    return items;
  }

  /** 首轮对话三份源文件的控制台声明(Persona 页提示词页签经 /api/prompts 读写)。 */
  protected firstTurnDocs(language: Language = 'zh'): PromptDocDecl[] {
    const dir = this.firstTurnDir;
    if (!dir) return [];
    const t = pick(language, CONSOLE_TEXT);
    return [
      {
        key: 'firstTurn.user',
        title: t.firstTurnUser,
        description: t.firstTurnUserDesc,
        path: join(dir, FIRST_TURN_FILES.user),
      },
      {
        key: 'firstTurn.thinking',
        title: t.firstTurnThinking,
        description: t.firstTurnThinkingDesc,
        path: join(dir, FIRST_TURN_FILES.thinking),
      },
      {
        key: 'firstTurn.reply',
        title: t.firstTurnReply,
        description: t.firstTurnReplyDesc,
        path: join(dir, FIRST_TURN_FILES.reply),
      },
    ];
  }

  /** 各模板占位符此刻的值(纯展示,控制台旁注用)。 */
  promptVarValues(_ctx?: { now: Date; timezone: string }): Record<string, string> {
    return {
      'persona.orientation': readTextFile(this.orientationSource()).trim(),
      'persona.constitution': readTextFile(join(this.memoryDir, CONSTITUTION_FILE)).trim(),
      'persona.workspace': this.prefixWorkspaceListing(),
    };
  }

  /**
   * 前缀里的工作区清单。大目录折叠为一行计数(每场几十份交接笔记会撑爆缓存前缀);
   * list_files 指定目录时全量。
   */
  private prefixWorkspaceListing(): string {
    const files = this.memory.walkFiles();
    if (files.length === 0) return 'Your workspace is empty.';
    const shown = files.filter((f) => !PREFIX_FOLDS.some((d) => f.startsWith(d.prefix)));
    for (const d of PREFIX_FOLDS) {
      const n = files.filter((f) => f.startsWith(d.prefix)).length;
      if (n > 0) shown.push(d.line(n));
    }
    return `Files in your workspace:\n${shown.map((f) => `- ${f}`).join('\n')}`;
  }

  onOpening(ctx: { reason: SessionOpeningReason }): void {
    const text = ctx.reason === 'restarted' ? '[system] 进程重启,session 已续上。' : '[system] session 已开始。';
    this.core?.injectInternal(text, 'opening');
  }

  /** World 装卸与可见性变化只报一句;工具与环境提示词的增减随前缀重载自然体现。 */
  onWorldLifecycle(event: WorldLifecycleEvent): void {
    if (event.kind === 'failed') {
      this.core?.injectInternal(`[system] World 「${event.label}」运行中出错,已卸载,本次运行里没有它:${event.reason}`, 'notice');
      return;
    }
    const what = event.kind === 'visibility'
      ? (event.visible ? '重新对你可见' : '已对你隐藏,它的事件不再送到你这里')
      : event.kind === 'mounted' ? '已激活'
        : event.kind === 'unmounted' ? '已停用' : '已重启';
    this.core?.injectInternal(`[system] World 「${event.label}」${what}。`, 'notice');
  }

  onDelivery(ctx: { events: EventEnvelope[] }): void {
    this.batchOpenedAt ??= Date.now();
    // 交接笔记由 onHandoff 自己投递,不算新事件。
    const externals = ctx.events.filter((e) => e.origin === 'external' && e.type !== HANDOFF_NOTE_TYPE);
    if (externals.length === 0) return;
    // 外部事件投递复位静默时长。
    this.heartbeat.noteActivity();
    this.core?.injectInternal(`[system] ${externals.length} 条新事件。`, 'notice');
  }

  /**
   * 批末压力裁量:超软阈值先注入速记提醒(她拿到一轮落笔时间——提醒项挂 flush,
   * 下一批必含它),再超就请求交接。阶段预算是自己的裁量;越过模型物理上限的
   * 强制交接在 core。
   */
  onBatchEnd(): void {
    const openedAt = this.batchOpenedAt;
    this.batchOpenedAt = null;
    const core = this.core;
    if (!core) return;
    const info = core.sessionInfo(MAIN);
    if (info.estTokens === null) return;
    const { maxTokens, softRatio } = this.context();
    if (info.estTokens <= maxTokens * softRatio) return;
    if (!this.pressureWarned) {
      this.pressureWarned = true;
      // 最近段包含越过软阈值的整批投递、发言和回执。
      this.pressureSplitAt = openedAt ?? Date.now();
      core.injectInternal(PRESSURE_NOTE, 'notice');
      return;
    }
    core.requestContextHandoff();
  }

  /**
   * 卡住恢复的成文:core 只报 {count, quietMs} 机械事实。一次抖动不值得占一条上下文。
   */
  onStallsRecovered({ count, quietMs }: { count: number; quietMs: number }): string | null {
    if (count < 2) return null;
    const span = quietMs >= 60_000
      ? `约 ${Math.round(quietMs / 60_000)} 分钟`
      : `约 ${Math.round(quietMs / 1000)} 秒`;
    return `[系统] 你刚才卡住了 ${count} 次,${span}没能说出话——不是你选择不说。现在恢复了。`;
  }

  /**
   * 交接:交回空尾,上一窗的 assistant 消息与思维链签名不回灌。清空前的一段按越过软阈值那批的开始时刻
   * 切成"更早"与"最近"两段渲染成交接笔记,写进 handoffs/,再各以外部事件投递进新 session
   * 第一批;醒来那句话经 injectInternal 同批到达。事务期间总线不投递。
   */
  async onHandoff(snapshot: ContextRecord[], ctx: { hardTokens: number | null }): Promise<ContextHandoffResult> {
    const tagged = (tag: ToolTag): ReadonlySet<string> => this.core?.toolsTagged(tag) ?? new Set<string>();
    const now = new Date();
    const { maxTokens, keepRatio } = this.context();
    const note = renderHandoffNote(snapshot, {
      speechTools: tagged('speak'),
      flowTools: tagged('flow'),
      snapshotTools: tagged('snapshot'),
      previousBackground: this.handoffBackground(),
      // 笔记预算 = 阶段预算 × keepRatio,阶段预算超过模型上限 hardTokens 时按 hardTokens 算:清空前最近的一段按它装进笔记
      budgetTokens: Math.floor(Math.min(maxTokens, ctx.hardTokens ?? Infinity) * keepRatio),
      splitAtMs: this.pressureSplitAt,
    });
    const file = `${HANDOFF_DIR}${handoffNoteStamp(now)}.md`;
    const abs = join(this.memoryDir, file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, note.text, 'utf8');
    this.lastHandoffFile = file;
    this.pressureWarned = false;
    this.pressureSplitAt = null;
    // 醒来那句话不读存档;笔记正文随后作为事件投递。
    this.core?.injectInternal(this.handoffNoteLines().join(''), 'handoff');
    // 两段各是一条事件,同批投递(渲染进同一帧);远近之分靠各自的抬头与时间范围。
    for (const part of note.parts) this.core?.injectExternal(part.text, HANDOFF_NOTE_TYPE);
    // 空尾:新 session 只有前缀、醒来那句话和交接笔记。
    return { tail: [] };
  }

  protected handoffBackground(): string { return ''; }

  /**
   * 交接醒来那句话的各句;子类在其间插自己的句子。
   * 交接告知使用中文以保持上下文语种。先说明空台词不能播出，再给出可执行的后续动作。
   */
  protected handoffNoteLines(): string[] {
    return [
      '[system] 交接完了。之前的上下文已经全部清空,工作区的文件都还在。',
      '交接笔记会作为 external_event_frame 随这一批送到;工作区的文件是存档副本。恢复时使用事件正文,不要再读存档。',
      '按时间分段,有内容的段才送到;「最近的一段」接着现在,「更早的一段」只作参考。',
      '只有最近段保留对外发言的具体入参与实际回执,更早段整条省略这类调用。',
      '入参是当时拟发出的内容,对方是否收到、收到多少要看回执和后续事件;已受理不代表已经送达。',
      '自然接续当前话题或动作,不必口头表示意识到暂停、清空或交接。旧发言和折叠后的片段不作句式或长短的范本。',
      '对外交流的工具不要输出空内容,空的一个字也发不出去。',
      '想说话就把话直接写进调用里。这轮不想说,就调 end_turn。',
    ];
  }


  declareSessions(): SessionDecl[] {
    const self = this;
    return [
      {
        id: MAIN,
        label: 'main',
        rounds: () => ({ soft: this.caps.soft, hard: this.caps.hard, softHint: () => SOFT_CAP_HINT }),
        persistent: true,
        receivesEvents: true,
        get outputTap() { return self.outputTap(); },
        // 自有尾巴排在 World 工具之后:工具表顺序直接影响请求前缀的缓存命中
        tools: () => [...this.tools(), ...this.ioTools(), ...this.mainTailTools()],
      },
    ];
  }

  /** 主 session 排在 World 工具之后的自有工具;变体追加自己的(闹钟)。 */
  protected mainTailTools(): ToolDef[] {
    return [endTurnTool()];
  }

  /** 自有工具 = 文件工具面 + 主 session 尾巴;各 session 声明里 World 之外的都出自这两处。 */
  ownToolNames(): string[] {
    return [...new Set([...this.tools(), ...this.mainTailTools()].map((t) => t.name))];
  }

  private sortedWorlds(): World[] {
    return [...this.worlds].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 挂载 World 的工具(可给 tag 只取一类,如 fork 只拿 read 类);World 可见性由 core 在工具装配后过滤。 */
  protected ioTools(tag?: ToolTag): ToolDef[] {
    const all = this.sortedWorlds().flatMap((m) => m.tools());
    return tag ? all.filter((t) => t.tags.includes(tag)) : all;
  }

  /**
   * 主 session 的输出旁路:挂载 World 的接收器扇成一个 tap。没有任何接收器时不声明,
   * session 不走流式。每批投递时现取,World 运行中挂载/卸载即生效。
   */
  private outputTap(): OutputTap | undefined {
    const taps = this.sortedWorlds().flatMap((m) => {
      const tap = m.outputTap?.();
      return tap ? [tap] : [];
    });
    if (taps.length === 0) return undefined;
    if (taps.length === 1) return taps[0];
    return {
      onEvent: (event) => { for (const t of taps) t.onEvent(event); },
      externalizes: (event) => taps.some((t) => t.externalizes?.(event) ?? defaultExternalizes(event)),
      onRoundEnd: () => { for (const t of taps) t.onRoundEnd?.(); },
      onAbort: (reason) => { for (const t of taps) t.onAbort?.(reason); },
    };
  }


  /**
   * 她对记忆的全部动作面(见 workspaceTools.ts);传进去的几项是工具要问 Persona 的事,
   * 子类覆写哪个方法就改哪处行为。逐字进系统前缀的宪法,delete_file 与整份移动都不认。
   */
  protected tools(): ToolDef[] {
    return [
      ...workspaceTools({
        memory: this.memory,
        blob: handle => this.core?.blob(handle) ?? null,
        wholeReadFallbackChars: () => this.wholeReadFallbackChars(),
        moveGuard: this.moveGuard?.bind(this),
        writeGuard: (op, path, role) => this.writeGuard(op, path, role),
        readOverride: (path, role) => this.readOverride(path, role),
        prefixResidentFiles: () => [join(this.memoryDir, CONSTITUTION_FILE)],
      }),
      saveBlobTool({
        blobs: this.blobs,
        core: () => this.core,
        guard: (path, role) => this.writeGuard('write', path, role),
      }),
    ];
  }

  protected wholeReadFallbackChars(): number {
    const { maxTokens, softRatio } = this.context();
    return Math.max(1, Math.floor(maxTokens * (1 - softRatio)));
  }

  /** 整份移动的准入;不覆写时文件工具按源 rename、目标 write 走 writeGuard。 */
  protected moveGuard?(from: string, to: string, role: string): string | null;

  /**
   * 写类工具的准入:返回一句拒绝理由就不动文件,null 放行。基类不设限;变体按自己的
   * 写纪律覆写(按 session 角色分区、容量守门)。`role` 是调用方 session id。
   */
  protected writeGuard(_op: 'write' | 'append' | 'rename' | 'delete', _path: string, _role: string): string | null {
    return null;
  }

  /** read_file 的虚拟文件:返回正文就不读盘(如随软件走的机制说明);null 走正常读取。 */
  protected readOverride(_path: string, _role: string): string | null {
    return null;
  }

}

export const BASE_TOOL_DECLS: ToolSpec[] = [
  {
    name: 'end_turn',
    description:
      'End this turn: nothing more you want to say or do right now. ' +
      'New events or the heartbeat will wake you again. ' +
      'This is the normal way to finish a turn — do not idle with empty actions.',
    tags: ['flow'],
    parameters: { type: 'object', properties: {}, required: [] }
  }
];
