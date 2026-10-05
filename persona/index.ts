import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import type { Core } from 'cortico/core/core.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
/**
 * 继承文件式工作区 Persona，增加 MEMORY 0–4、memo 写入容量检查、角色权限矩阵和后台整理。
 * 交接快照进入串行梦队列，结果经 MEMORY 3 与事件回到主 session。
 * 工作区改动按批次提交 Git；rhythm.ts 提供昼夜心跳和 schedule_wake。
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { updateJsonObject } from 'cortico/config-file.ts';
import { coerceGroupValues, readGroupValues, setByPath } from 'cortico/core/config-schema.ts';
import type {
  CoreApi, World, WorldLifecycleEvent, PersonaCognition, MemoryAssemblyContext, PersonaConsoleDecl, SessionOpeningReason,
  SessionDecl, SystemPrefixContext, ToolDef, ToolSpec, ContextHandoffResult,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { BotConfig } from '../index.ts';
import { hourIn } from 'cortico/core/util.ts';
import { renderTemplate } from 'cortico/core/template.ts';
import { renderWorldEnvPrompt } from 'cortico/core/prefix.ts';
import { Subagents } from './subagents/index.ts';
import { SUBAGENTS_CONFIG_GROUP, subagentsConfig, validateSubagentsDraft } from './subagents/config.ts';
import { subagentTaskText, subagentVars } from './subagents/prompts.ts';
import { Cormini, MAIN, type CorminiOptions } from '../base/persona/persona.ts';
import { HANDOFF_NOTE_TYPE } from '../base/persona/handoffNote.ts';
import { WorkspaceError, normalizeWorkspacePath } from '../base/persona/memory.ts';
import { AUTHOR_SELF, type WorkspaceGit } from '../base/persona/workspaceGit.ts';
import { MemoTiers } from './memoTiers.ts';
import { personaConsoleDecl } from './consoleSurface.ts';
import { memoryVars } from './memory.ts';
import { memoCapGuard, moveFileTool, scheduleWakeSpec, toolUsageText } from './tools.ts';
import { asPersonaRole, checkAccess } from './permissions.ts';
import { WakeManager, tickTimeText } from './rhythm.ts';
import { DREAM, Dream } from './subconscious/index.ts';
import { CharacterState } from './character-state.ts';
import { Appraiser } from './appraisal.ts';
import { AppraisalHistory, sceneFor, toAppraisalMessage, eventMatch } from './appraisal-context.ts';
import { cleanSnapshot } from './context-material.ts';
import { decideFrame, ruleError, StateRefresh, validateRules, type ObservedEvent } from './cognition.ts';
import { jevSecretName, jevSource, PERSONA_CONFIG_GROUP, PERSONA_DEFAULTS, COGNITION_CONFIG_GROUP, DREAM_CONFIG_GROUP, GENERAL_CONFIG_GROUP, dreamConfig } from './config.ts';
import { discoverCondaPythonOptions } from './conda-environments.ts';
import { ensureSecretPlaceholder, openSecretFile } from './secret-file.ts';

export { MAIN };

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** MEMORY 3 反射层最多保留几缕浮现 */
const EMERGENCE_KEEP = 3;

/** CORE.md 是包内只读机制文档；readOverride 提供读取，writeGuard 拒绝写入。 */
const CORE_NAME = 'core.md';

export const WORKSPACE_DIRS = [
  '', 'note', 'note/playbook', 'note/library',
  'people', 'memo', 'memo/active', 'memo/archived',
  'state',
] as const;

/** 仅供控制台显示的段名，不写入前缀。 */
const SEGMENT_TITLES: Record<string, string> = {
  'persona.orientation': 'ORIENTATION',
  'persona.constitution': '宪法',
  'persona.toolUsage': 'Using your tools',
  'persona.subagents': '子代理',
  'memory.all': '记忆',
};

/** 段 → 可编辑源的 key。没列的段(工具用法)是代码拼的,控制台标只读。 */
const SEGMENT_SOURCES: Record<string, string> = {
  'persona.orientation': 'orientation',
  'persona.constitution': 'constitution',
  'persona.subagents': 'persona.subagents',
  'memory.all': 'persona.memory',
};

export interface ContinuityPersonaOptions {
  memoryDir: string;
  /** 热配置；轮数、memo 容量与上下文预算在使用时读取。 */
  cfg: BotConfig;
  /** 已挂载的 World(挂载表活引用) */
  worlds?: World[];
  /** 首轮对话三份源文件的目录(这份部署的 `prompts/`);不给 = 没有首轮对话。 */
  firstTurnDir?: string;
  appraiser?: Appraiser;
  deploymentDir?: string;
  dataDir?: string;
  getSecret?: (name: string) => string;
  /**
   * 部署侧的人格文本覆盖目录(这份部署的 `prompts/`)。ORIENTATION / PREFIX / ENV_SECTION /
   * MEMORY、CORE 与子代理模板；同名文件替换包内默认，控制台保存只写这里。
   */
  promptsDir?: string;
}

/** 机制说明那份虚拟文件的名字判定(大小写不敏感)。 */
function isHarnessPath(relPath: string): boolean {
  return normalizeWorkspacePath(relPath).toLowerCase() === CORE_NAME;
}

/** 昼夜作息:深夜按固定间隔(或不心跳),白天在区间内取随机。 */
function tickDelayMs(cfg: BotConfig, now: Date): number | null {
  const t = cfg.tick;
  const h = hourIn(cfg.timezone, now);
  const night = t.nightStartHour <= t.nightEndHour
    ? h >= t.nightStartHour && h < t.nightEndHour
    : h >= t.nightStartHour || h < t.nightEndHour;
  if (night) return t.nightIntervalMinutes === null ? null : t.nightIntervalMinutes * 60_000;
  const [min, max] = t.dayIntervalMinutes;
  return Math.round((min + Math.random() * Math.max(0, max - min)) * 60_000);
}

export class ContinuityPersona extends Cormini {
  private readonly memo: MemoTiers;
  private readonly cfg: BotConfig;
  private readonly promptsDir: string | null;
  private readonly character: CharacterState;
  private readonly appraiser: Appraiser;
  private readonly appraisalHistory: AppraisalHistory;
  private pendingQqDraft: { scene: string; text: string } | null = null;
  private readonly qqMessageScenes = new Map<string, string>();
  private readonly deploymentDir: string | null;
  private ruleDiagnostics = '';
  private readonly getSecret: (name: string) => string;
  private handoffBackgroundText = '';
  private readonly stateRefresh = new StateRefresh();
  private recentEvents: ObservedEvent[] = [];
  private readonly dataDir: string | null;
  private dreamer: Dream | null = null;
  private wakes: WakeManager | null = null;
  private readonly workers: Subagents;
  private subagentsCore: Core | null = null;
  private subagentsRunState: () => boolean = () => true;
  private subagentsWorldVisibility: (id: string) => boolean = () => true;

  constructor(opts: ContinuityPersonaOptions) {
    const { cfg } = opts;
    const base: CorminiOptions = {
      memoryDir: opts.memoryDir,
      context: () => cfg.context,
      // getter 在每次使用时读取热配置。
      rounds: { get soft() { return cfg.loop.softCap; }, get hard() { return cfg.loop.hardCap; } },
      seedConstitution: '(宪法尚未写入)\n',
      worlds: opts.worlds,
      orientationFile: join(MODULE_DIR, 'ORIENTATION.md'),
      ...(opts.promptsDir ? { orientationOverrideFile: join(opts.promptsDir, 'ORIENTATION.md') } : {}),
      ...(opts.firstTurnDir ? { firstTurnDir: opts.firstTurnDir } : {}),
      tickDelayMs: (now) => tickDelayMs(cfg, now),
      blobsDir: 'external/qq/images/',
    };
    super(base);
    this.cfg = cfg;
    this.cfg.subagents = validateSubagentsDraft(Object.fromEntries(Object.entries(cfg.subagents ?? {})
      .map(([key, value]) => ['subagents.' + key, value])), subagentsConfig());
    this.promptsDir = opts.promptsDir ?? null;
    this.memory.ensureDirs(WORKSPACE_DIRS);
    // 保留 cfg.memo 的活引用以读取热配置。
    this.memo = new MemoTiers(this.memory, this.cfg.memo);
    this.character = new CharacterState(this.memoryDir);
    this.appraisalHistory = new AppraisalHistory(this.memoryDir);
    this.deploymentDir = opts.deploymentDir ?? null;
    this.dataDir = opts.dataDir ?? (opts.deploymentDir ? join(opts.deploymentDir, 'data') : null);
    if (this.dataDir) {
      try { this.recentEvents = JSON.parse(readFileSync(join(this.dataDir, 'continuity', 'recent-events.json'), 'utf8')); } catch { /* No observed events yet. */ }
    }
    this.getSecret = opts.getSecret ?? ((name) => process.env[name] ?? '');
    this.appraiser = opts.appraiser ?? new Appraiser(this.cfg.appraisal ?? PERSONA_DEFAULTS.appraisal, {
      getEnv: this.getSecret,
    });
    this.workers = new Subagents({
      config: () => this.cfg.subagents!, core: () => this.core, runtime: () => this.subagentsCore,
      visibleTools: () => this.declareSessions().find(session => session.id === MAIN)!.tools(),
      contextTokens: () => this.cfg.context.maxTokens,
      memoryTools: () => this.tools(), worlds: opts.worlds ?? [],
      dataDir: this.dataDir ?? undefined, isRunning: () => this.subagentsRunState(),
      isWorldVisible: id => this.subagentsWorldVisibility(id),
      savePermissions: () => {
        if (this.deploymentDir) updateJsonObject(join(this.deploymentDir, 'config.json'), raw => {
          setByPath(raw, 'subagents.permissions', this.cfg.subagents!.permissions);
        });
      },
      messages: async (assignment, config, selected) => {
        const ids = new Set(selected.filter(entry => entry.owner !== 'memory').map(entry => entry.owner));
        if (assignment.worldId) ids.add(assignment.worldId);
        const worlds = (opts.worlds ?? []).filter(world => ids.has(world.id));
        const environments = await Promise.all(worlds.map(world => renderWorldEnvPrompt(world, {
          packageDir: dirname(MODULE_DIR), ...(this.deploymentDir ? { deploymentDir: this.deploymentDir } : {}),
        })));
        const available = selected.map(entry => entry.owner + ': ' + entry.tool.name).join('\n') || '(none)';
        const rules = renderTemplate(readFileSync(this.textFile('SUBAGENT_WORKER.md'), 'utf8'), subagentVars(config, available));
        return [
          message('system', [...(assignment.context === 'isolated' ? ['━━━ ORIENTATION ━━━', this.orientationText().trim(), '━━━ 宪法 ━━━',
            this.constitutionText().trim()] : []), '━━━ Worker ━━━', rules,
            ...environments.map((environment, index) => environment.text
              ? renderTemplate(readFileSync(this.textFile('ENV_SECTION.md'), 'utf8'),
                { 'world.id': worlds[index].id, 'world.envPrompt': environment.text }) : ''),
          ].filter(Boolean).join('\n\n')),
          message('user', subagentTaskText(assignment)),
        ];
      },
    });
  }

  /** Persona 的工作区 Git 版本管理。 */
  get git(): WorkspaceGit {
    return this.memory.git;
  }

  /** 启动时初始化 persona git 并创建 checkpoint0。历史设施初始化失败不阻止Persona运行。 */
  initGit(log?: { info(msg: string): void; warn(msg: string, data?: unknown): void }): void {
    try {
      if (this.git.init().created) log?.info('persona/ 已建 git 仓并打 checkpoint0(当前干净态)');
    } catch (e) {
      log?.warn('persona git 初始化失败(不影响运行)', { err: String(e) });
    }
  }

  override attach(core: CoreApi): void {
    super.attach(core);
    if (core.personaState) this.stateRefresh.restore(core.personaState().continuityStateRefresh);
    this.wakes = new WakeManager(core, () => this.cfg.timezone, (entry) => this.dreamer?.onRetryDue(entry) ?? false);
    this.dreamer = new Dream({
      cfg: this.cfg,
      core,
      dataDir: this.dataDir ?? undefined,
      memoryDir: this.memoryDir,
      semanticState: () => this.character.semanticState(Infinity),
      dreamTools: () => this.dreamTools(),
      toolUsageText: () => this.toolUsageText(DREAM),
      log: core.log.child('dream'),
      onEmergence: (text) => this.recordEmergence(text),
    });
  }

  /** 已接线的梦(控制台的强制入梦、状态仪表用) */
  get dream(): Dream {
    if (!this.dreamer) throw new Error('Persona尚未 attach 到 core');
    return this.dreamer;
  }

  private api(): CoreApi {
    if (!this.core) throw new Error('Persona尚未 attach 到 core');
    return this.core;
  }

  // ---------------------------------------------------------------------------
  // session 声明与工具
  // ---------------------------------------------------------------------------

  /** 主线接收事件；梦与单任务 worker 使用独立 fork。 */
  override declareSessions(): SessionDecl[] {
    const cfg = this.cfg;
    return [
      ...super.declareSessions(),
      {
        id: DREAM,
        label: '梦(交接后整理)',
        rounds: () => ({ soft: Math.min(cfg.dream.softRounds ?? 40, cfg.dream.maxRounds), hard: cfg.dream.maxRounds }),
        persistent: false,
        receivesEvents: false,
        tools: () => this.dreamTools(),
      },
      this.workers.session(),
    ];
  }

  protected override mainTailTools(): ToolDef[] {
    return [...super.mainTailTools(), this.scheduleWakeTool(), ...this.workers.mainTools()];
  }

  /** 文件工具之上加 move_file(memo 三级之间搬运;people/ 改名归梦)。 */
  protected override tools(): ToolDef[] {
    return [
      ...super.tools(),
      moveFileTool({
        ws: this.memory,
        guard: (op, path, role) => this.writeGuard(op, path, role),
        capGuard: (to, from) => memoCapGuard(this.memory, this.memo, to, from),
      }),
    ];
  }

  /** 梦的工具面:文件工具 + 只读的 World 工具(翻历史、看图取证)。 */
  private dreamTools(): ToolDef[] {
    return [...this.tools(), ...this.ioTools('read')];
  }

  protected override ioTools(tag?: import('cortico/core/types.ts').ToolTag): ToolDef[] {
    const tools = super.ioTools(tag);
    if (tag) return tools;
    return tools.map((tool) => {
      if (tool.name !== 'qq_draft' && tool.name !== 'qq_confirm') return tool;
      return {
        ...tool,
        handler: async (args, ctx) => {
          const result = await tool.handler(args, ctx);
          const output = typeof result === 'string' ? result : result.text;
          if (tool.name === 'qq_draft' && output.startsWith('[draft staged')) {
            const address = typeof args.to === 'string' ? args.to : '';
            const replyId = args.reply_to === undefined ? '' : String(args.reply_to).replace(/^#/, '');
            const scene = /^(group|private):\d+$/.test(address)
              ? `qq:${address}` : this.qqMessageScenes.get(replyId);
            this.pendingQqDraft = scene && typeof args.text === 'string' ? { scene, text: args.text } : null;
          }
          if (tool.name === 'qq_confirm') {
            if (args.decision === 'cancel') this.pendingQqDraft = null;
            if (args.decision === 'send' && /^\[sent(?: #[^ ]+)? → /u.test(output)) {
              if (this.pendingQqDraft) {
                const { scene, text } = this.pendingQqDraft;
                this.appraisalHistory.add(scene, [{ ts: new Date().toISOString(), source: 'qq', type: 'qq.self', speaker: 'bot', text, role: 'bot' }]);
              }
              this.pendingQqDraft = null;
            }
          }
          return result;
        },
      };
    });
  }

  private scheduleWakeTool(): ToolDef {
    return {
      ...scheduleWakeSpec(),
      handler: async (args) => {
        if (!this.wakes) return '[tool failed] Persona not attached';
        return this.wakes.schedule(args);
      },
    };
  }

  /** 供控制台工具编辑器列 schema:主 session 之外还有梦那一面。 */
  primitiveToolSpecs(): ToolSpec[] {
    return [scheduleWakeSpec()];
  }

  // ---------------------------------------------------------------------------
  // 写纪律
  // ---------------------------------------------------------------------------

  /** 写入需通过角色权限、memo 容量和 CORE.md 只读检查；拒绝原因返回给 agent。 */
  protected override writeGuard(op: 'write' | 'append' | 'rename' | 'delete', path: string, role: string): string | null {
    const rel = normalizeWorkspacePath(path);
    if (isHarnessPath(rel)) return 'CORE.md is a system mechanics doc; read-only.';
    const res = checkAccess(asPersonaRole(role), op, rel);
    if (!res.ok) return res.reason;
    if (op === 'write' || op === 'append') return memoCapGuard(this.memory, this.memo, rel);
    return null;
  }

  override onOpening(ctx: { reason: SessionOpeningReason }): void {
    if (ctx.reason === 'cleared') this.lastHandoffFile = null;
    if (ctx.reason !== 'restarted') { this.stateRefresh.reset(); this.refreshState(0); }
    super.onOpening(ctx);
  }

  /** CORE.md 随软件走,不在工作区里;read_file 照样读得到。 */
  protected override readOverride(path: string, role: string = MAIN): string | null {
    if (role !== 'subagent' && this.lastHandoffFile !== null && normalizeWorkspacePath(path) === this.lastHandoffFile) {
      return '[这份交接笔记已作为事件送入当前 session;请使用事件帧中的正文。]';
    }
    if (!isHarnessPath(path)) return null;
    const file = this.textFile('CORE.md');
    if (!existsSync(file)) throw new WorkspaceError('CORE.md 暂不可用(软件包内未找到该文件)');
    return readFileSync(file, 'utf8');
  }

  /** 读取部署 prompts/ 同名覆盖文件；不存在时读取包内默认文件。 */
  textFile(name: string): string {
    const override = this.promptsDir ? join(this.promptsDir, name) : null;
    return override && existsSync(override) ? override : join(MODULE_DIR, name);
  }

  /** 控制台保存人格文本落到哪:部署 `prompts/`;没给部署目录就写包内那份。 */
  textWritePath(name: string): string {
    return this.promptsDir ? join(this.promptsDir, name) : join(MODULE_DIR, name);
  }

  // ---------------------------------------------------------------------------
  // 前缀
  // ---------------------------------------------------------------------------

  protected override templateFile(name: string): string {
    return this.textFile(name);
  }

  protected override prefixVars(ctx: SystemPrefixContext): Record<string, string> {
    return {
      'persona.orientation': this.orientationText().trim(),
      'persona.constitution': this.constitutionText().trim(),
      'persona.toolUsage': this.toolUsageText(MAIN).trim(),
      'persona.subagents': this.subagentUsageText(),
      'memory.all': this.assembleMemory({ now: ctx.now, timezone: ctx.timezone }),
    };
  }

  protected override segmentTitles(): Record<string, string> {
    return SEGMENT_TITLES;
  }

  protected override segmentSources(): Record<string, string> {
    return SEGMENT_SOURCES;
  }

  orientationText(): string {
    return readFileSync(this.orientationSource(), 'utf8');
  }

  constitutionText(): string {
    return readFileSync(join(this.memoryDir, 'CONSTITUTION.md'), 'utf8');
  }

  private subagentUsageText(): string {
    if (!this.cfg.subagents!.enabled) return '';
    return renderTemplate(readFileSync(this.textFile('SUBAGENTS.md'), 'utf8'),
      subagentVars(this.cfg.subagents!, this.workers.availableToolsText())).trim();
  }

  readonly cognition: PersonaCognition = {
    enabled: () => this.cfg.subagents!.enabled,
    request: (request, context) => this.workers.request(request, context),
  };

  setSubagentsRuntime(core: Core): void {
    this.subagentsCore = core;
    this.subagentsRunState = () => core.loop.getStatus().running;
    this.subagentsWorldVisibility = id => core.isWorldVisible(id);
  }
  override onWorldLifecycle(event: WorldLifecycleEvent): void {
    if (event.kind === 'unmounted' || event.kind === 'restarted') this.workers.stopWorld(event.id);
    super.onWorldLifecycle(event);
  }
  stopSubagents(): void { this.workers.stop(); }

  subagentsState() {
    const state = this.workers.state();
    const values: Record<string, unknown> = Object.fromEntries(Object.keys(SUBAGENTS_CONFIG_GROUP.schema.properties)
      .map(path => [path, structuredClone(this.cfg.subagents![path.slice('subagents.'.length) as keyof NonNullable<BotConfig['subagents']>])]));
    return { ...state, values, revision: JSON.stringify(values) };
  }

  async subagentsInvoke(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'state') return this.subagentsState();
    if (method === 'get') return this.workers.get((args[0] ?? {}) as Record<string, unknown>);
    if (method === 'list') return this.workers.list((args[0] ?? {}) as Record<string, unknown>);
    if (method === 'spawn') return this.workers.spawn((args[0] ?? {}) as Record<string, unknown>);
    if (method === 'saveDraft') {
      const state = this.subagentsState();
      if (args[1] !== undefined && args[1] !== state.revision) throw new Error('配置已被其他操作修改，请重新加载后保存');
      const input = args[0];
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置草稿格式无效');
      const next = validateSubagentsDraft(input as Record<string, unknown>, this.cfg.subagents!);
      this.workers.normalizePermissions(next);
      if (!this.deploymentDir) throw new Error('部署目录不可用');
      updateJsonObject(join(this.deploymentDir, 'config.json'), raw => { raw.subagents = next; });
      this.cfg.subagents = next;
      this.workers.permissionsChanged();
      return this.subagentsState();
    }
    throw new Error('未知子代理面板方法：' + method);
  }

  toolUsageText(sessionId: string): string {
    return toolUsageText(asPersonaRole(sessionId), {
      residentCap: this.cfg.memo.residentCap,
      activeCap: this.cfg.memo.activeCap,
    });
  }

  /** 各模板占位符此刻的值(纯展示,控制台的旁注用)。`worlds.*` 那几个由各 World 自报。 */
  override promptVarValues(ctx: { now: Date; timezone: string }): Record<string, string> {
    return {
      ...this.prefixVars({ ...ctx, worlds: [] }),
      ...memoryVars(this.memory, this.memo, ctx, this.emergences()),
      ...subagentVars(this.cfg.subagents!, this.workers.availableToolsText()),
    };
  }

  /** MEMORY 0~4:模板 + 活数据。五层的引导语与空态措辞全在 MEMORY.md 里。 */
  assembleMemory(ctx: MemoryAssemblyContext): string {
    return renderTemplate(
      readFileSync(this.textFile('MEMORY.md'), 'utf8'),
      memoryVars(this.memory, this.memo, ctx, this.emergences()),
    ).trim();
  }

  // ---------------------------------------------------------------------------
  // 时机
  // ---------------------------------------------------------------------------

  /** 心跳提供日期和时间；普通消息时间行不含日期。 */
  protected override tickText(quietSeconds: number): string {
    return `[system/tick] Time is ${tickTimeText(this.cfg.timezone, new Date())}. `
      + `About ${Math.round(quietSeconds / 60)} min since the last messages.`;
  }

  /** 交接照 Cormini(空尾 + 交接笔记);交接前的快照另排进并行梦。 */
  override async onHandoff(snapshot: ContextRecord[], ctx: { hardTokens: number | null }): Promise<ContextHandoffResult> {
    const { records: retained, background } = cleanSnapshot(snapshot);
    this.handoffBackgroundText = background;
    if (retained.some((m) => !hasRole(m, 'system'))) this.dream.schedule(snapshot);
    try {
      const result = await super.onHandoff(retained, ctx);
      this.stateRefresh.reset();
      this.refreshState(0);
      return result;
    } finally { this.handoffBackgroundText = ''; }
  }

  protected override handoffBackground(): string { return this.handoffBackgroundText; }

  protected override handoffNoteLines(): string[] {
    const lines = super.handoffNoteLines();
    const at = lines.findIndex((l) => l.startsWith('对外交流的工具不要输出空内容'));
    lines.splice(at, 0, '后台正在入梦整理工作区(people/、memo/、WORLDVIEW.md);有值得说的会以 [surfaced from dream] 送来。');
    return lines;
  }

  override async onDelivery(ctx: { events: import('cortico/core/types.ts').EventEnvelope[] }): Promise<void> {
    super.onDelivery(ctx);
    const external = ctx.events.filter((event) => event.origin === 'external' && event.type !== HANDOFF_NOTE_TYPE);
    if (external.length === 0) return;
    const appraisalConfig = structuredClone(this.cfg.appraisal ?? PERSONA_DEFAULTS.appraisal);
    const cognition = structuredClone(this.cfg.cognition ?? PERSONA_DEFAULTS.cognition);
    const errors = [...cognition.whitelist, ...cognition.blacklist].map((rule) => ({ id: rule.id, error: ruleError(rule) })).filter((item) => item.error);
    const diagnostic = JSON.stringify(errors);
    if (diagnostic !== this.ruleDiagnostics) {
      this.ruleDiagnostics = diagnostic;
      if (errors.length) this.core?.log.warn('认知帧跳过无效规则', { rules: errors });
    }
    this.refreshState(cognition.stateReminderBatches);
    const groups = new Map<string, import('cortico/core/types.ts').EventEnvelope[]>();
    for (const event of external) {
      const key = sceneFor(event).key;
      groups.set(key, [...(groups.get(key) ?? []), event]);
      this.recentEvents = this.recentEvents.filter((seen) => seen.cursor !== event.cursor);
      this.recentEvents.push({ ...eventMatch(event), cursor: event.cursor, ts: event.ts, text: event.text?.slice(0, 240) ?? '' });
    }
    this.recentEvents = this.recentEvents.slice(-200);
    if (this.dataDir) {
      const dir = join(this.dataDir, 'continuity');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'recent-events.json'), JSON.stringify(this.recentEvents));
    }
    const histories = new Map([...groups].map(([key, events]) => [key, this.appraisalHistory.recent(key, events[0]!.ts)]));
    this.character.recordExternalBatch(external.map((event) => ({
      cursor: event.cursor, senderKey: event.senderKey, source: event.source, ts: event.ts,
      sceneKey: sceneFor(event).key, sceneKind: sceneFor(event).kind,
    })));
    for (const event of external) {
      const message = toAppraisalMessage(event);
      if (message.messageId) {
        this.qqMessageScenes.set(message.messageId, sceneFor(event).key);
        if (this.qqMessageScenes.size > 500) this.qqMessageScenes.delete(this.qqMessageScenes.keys().next().value!);
      }
      const scene = sceneFor(event);
      if (scene.kind !== 'unknown') this.appraisalHistory.add(scene.key, [message]);
    }
    for (const [key, selected] of groups) {
      if (!selected.some((event) => decideFrame(eventMatch(event), cognition).trigger)) continue;
      const scene = sceneFor(selected[0]!);
      const appraisal = await this.appraiser.assess({
        scene: key, current: selected.map(toAppraisalMessage), history: histories.get(key)!,
        mechanical: this.character.mechanicalCategories(scene),
      }, appraisalConfig);
      if (appraisalConfig.debugLog) this.api().log.info('appraisal result', {
        source: appraisal.source, available: appraisal.available !== false, variant: appraisal.variant,
        initiative: appraisal.initiative, topicPersistence: appraisal.topicPersistence, playfulness: appraisal.playfulness,
      });
      const frame = this.character.frameForCurrentState(appraisal, scene, false)
        .replace('[system/cognitive-frame]', `[system/cognitive-frame]\nScene: ${key}. Apply only to this scene.`);
      this.api().injectInternal(frame + '\n[/system/cognitive-frame]', 'cognitive-frame');
    }
  }

  private refreshState(interval: number): void {
    const text = this.character.semanticState(Infinity);
    if (this.stateRefresh.next(text, interval)) this.core?.injectInternal(`[system/continuity-state]\n${text || '(empty)'}\n[/system/continuity-state]`, 'continuity-state');
    if (this.core?.personaState) {
      this.core.personaState().continuityStateRefresh = this.stateRefresh.snapshot();
      this.core.savePersonaState();
    }
  }

  async dispose(): Promise<void> {
    this.workers.stop();
    this.dreamer?.stop();
    await this.appraiser.dispose();
  }

  onTurnEnded(): void {
    this.pendingQqDraft = null;
  }

  /** 每批空闲时提交 persona 改动;梦的改动包含在同一次提交中。提交失败不影响主循环。 */
  onIdle(): void {
    try {
      this.git.commitAll('本轮记忆改动', AUTHOR_SELF);
    } catch {
      /* 提交失败不影响主循环 */
    }
  }

  // ---------------------------------------------------------------------------
  // MEMORY 3 反射
  // ---------------------------------------------------------------------------

  emergences(): string[] {
    if (!this.core) return [];
    const raw = this.core.personaState().emergences;
    return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
  }

  private recordEmergence(text: string): void {
    const tagged = `[surfaced from dream] ${text}`;
    const state = this.api().personaState();
    state.emergences = [...this.emergences(), tagged].slice(-EMERGENCE_KEEP);
    this.api().savePersonaState();
    this.api().injectInternal(tagged, 'emergence');
  }

  // ---------------------------------------------------------------------------
  // 控制台
  // ---------------------------------------------------------------------------

  /** 工作区、Memory 分层、版本历史三块归 Memory 页,模板归 Persona 页;部署级控制在 console-page.ts。工作区排除在统一清除清单外。 */
  override console(language: Language = 'zh'): PersonaConsoleDecl {
    const { panels, ...decl } = personaConsoleDecl({
      memory: this.memory,
      memo: this.memo,
      emergences: () => this.emergences(),
      firstTurnDocs: this.firstTurnDocs(language),
      texts: { path: (name) => this.textFile(name), writePath: (name) => this.textWritePath(name) },
    }, language);
    const invoke = decl.invoke;
    return {
      ...decl,
      memory: { panels },
      panels: [{ id: 'config', title: '配置' }, { id: 'cognition', title: '认知帧' }],
      invoke: async (panel, method, args) => {
        if (panel === 'subagents') return this.subagentsInvoke(method, args);
        if (panel !== 'config' && panel !== 'cognition' && panel !== 'dream') {
          if (!invoke) throw new Error('未知面板');
          return invoke(panel, method, args);
        }
        return this.configInvoke(panel, method, args, language);
      },
    };
  }
  configState(panel: string): Record<string, unknown> {
    const group = panel === 'cognition' ? COGNITION_CONFIG_GROUP : panel === 'dream' ? DREAM_CONFIG_GROUP : GENERAL_CONFIG_GROUP;
    const scalar = { ...group, schema: { ...group.schema, properties: Object.fromEntries(Object.entries(group.schema.properties).filter(([path]) => !path.endsWith('blacklist') && !path.endsWith('whitelist'))) } };
    const cfg = { ...this.cfg, dream: dreamConfig(this.cfg.dream), cognition: this.cfg.cognition ?? PERSONA_DEFAULTS.cognition };
    const appraisal = this.cfg.appraisal ?? PERSONA_DEFAULTS.appraisal;
    const source = jevSource(appraisal.jev);
    const values = readGroupValues(cfg, scalar);
    if (panel === 'cognition') values['appraisal.jev.source'] = source;
    const rules = structuredClone(cfg.cognition);
    const revision = JSON.stringify({ values, ...(panel === 'cognition' ? { rules } : {}) });
    return { values, revision, provider: appraisal.provider, source,
      keySet: !!(this.getSecret(jevSecretName(source)) || (source === 'typesafe' && this.getSecret('CORTICO_JEV_API_KEY'))),
      keys: Object.fromEntries(['typesafe', 'openrouter', 'custom'].map((kind) => [kind, !!(this.getSecret(jevSecretName(kind as 'typesafe' | 'openrouter' | 'custom')) || (kind === 'typesafe' && this.getSecret('CORTICO_JEV_API_KEY')))])),
      ...(panel === 'cognition' ? { rules, recentEvents: structuredClone(this.recentEvents).reverse(),
        deploymentKey: createHash('sha256').update(this.deploymentDir ?? this.memoryDir).digest('hex') } : {}),
    };
  }

  async configInvoke(panel: string, method: string, args: unknown[], language: Language = 'zh'): Promise<unknown> {
    if (method === 'state') return this.configState(panel);
    if (panel === 'cognition' && method === 'options') return discoverCondaPythonOptions();
    if (panel === 'cognition' && method === 'testConnection') return this.appraiser.testConnection();
    if (panel === 'cognition' && method === 'openKeyFile') {
      const source = args[0];
      if (source !== 'typesafe' && source !== 'openrouter' && source !== 'custom') throw new Error('未知 Jev 来源');
      if (!this.deploymentDir) throw new Error('部署目录不可用');
      const file = ensureSecretPlaceholder(this.deploymentDir, jevSecretName(source));
      await openSecretFile(file);
      return { file };
    }
    if (method === 'save' || method === 'saveDraft') {
      const group = panel === 'cognition' ? COGNITION_CONFIG_GROUP : panel === 'dream' ? DREAM_CONFIG_GROUP : GENERAL_CONFIG_GROUP;
      const input = method === 'save' ? { [String(args[0])]: args[1] } : args[0];
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置草稿格式无效');
      if (method === 'saveDraft' && args[1] !== undefined && args[1] !== this.configState(panel).revision) throw new Error('配置已被其他操作修改，请重新加载后保存');
      const values = { ...(input as Record<string, unknown>) };
      const rules: Record<string, unknown> = {};
      for (const path of Object.keys(values)) {
        if (!group.schema.properties[path]) throw new Error('未知配置项：' + path);
        if (path === 'cognition.blacklist' || path === 'cognition.whitelist') {
          rules[path] = validateRules(values[path]); delete values[path];
        }
      }
      const checked = coerceGroupValues(group, values, language);
      if ('error' in checked) throw new Error(checked.error);
      const next = structuredClone(this.cfg) as unknown as Record<string, unknown>;
      const updates = { ...checked.values, ...rules };
      for (const [path, value] of Object.entries(updates)) setByPath(next, path, value);
      const dream = dreamConfig(next.dream as BotConfig['dream']);
      if (dream.softRounds! > dream.maxRounds) throw new Error('梦收尾提示轮次必须 ≤ 硬结束轮次');
      if (dream.maxBackgroundTokens! >= dream.maxInputTokens!) throw new Error('旧背景预算必须小于梦初始输入预算');
      const loop = next.loop as BotConfig['loop'];
      if (loop.softCap > loop.hardCap) throw new Error('主循环软上限必须 ≤ 硬上限');
      if (!this.deploymentDir) throw new Error('部署目录不可用');
      updateJsonObject(join(this.deploymentDir, 'config.json'), (raw) => { for (const [path, value] of Object.entries(updates)) setByPath(raw, path, value); });
      for (const [path, value] of Object.entries(updates)) setByPath(this.cfg as unknown as Record<string, unknown>, path, value);
      return this.configState(panel);
    }
    throw new Error('未知操作');
  }

}
