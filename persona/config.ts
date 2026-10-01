/**
 * Persona发布的层 2 建议配置；层 3 的 `config.json` 部署值优先。
 * 内容是Persona参数与 session 阶段容量。用哪个模型、模型物理上下文上限
 * 都是 Provider 事实,不在这里。
 */
import type { CognitionConfig } from './cognition.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';

/** Persona建议的配置片段(会被 config.json 覆盖) */
export interface PersonaConfig {
  context: {
    /** 用于计算预警阈值和交接笔记预算。 */
    maxTokens: number;
    /** 交接笔记预算占阶段预算的比例。 */
    keepRatio: number;
    /** 超过阶段预算的此比例时先提示；下一批结束时仍超出则交接。 */
    softRatio: number;
    /** 是否把部署 prompts/ 里的首轮对话作为合成开头送进请求。 */
    firstTurn: boolean;
  };
  loop: { softCap: number; hardCap: number };
  memo: { residentCap: number; activeCap: number };
  tick: {
    dayIntervalMinutes: [number, number];
    nightIntervalMinutes: number | null;
    nightStartHour: number;
    nightEndHour: number;
  };
  dream: { maxRounds: number; softRounds?: number; maxInputTokens?: number; maxBackgroundTokens?: number; maxRetries?: number; retryDelaySec?: number;
    materialRetentionDays?: number; traceRetentionDays?: number; recordDetailedTrace?: boolean };
  cognition: CognitionConfig;
  appraisal: {
    provider: 'random' | 'laya' | 'jev';
    debugLog: boolean;
    laya: {
      idleTtlMinutes: number;
      variant: 'english' | 'multilingual';
      pythonExecutable: string;
    };
    jev: { allowRemoteText: boolean; endpoint: string; timeoutMs: number; source?: 'typesafe' | 'openrouter' | 'custom' };
  };
}

export type JevSource = NonNullable<PersonaConfig['appraisal']['jev']['source']>;
export const TYPESAFE_JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const OPENROUTER_JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

export function jevSource(config: PersonaConfig['appraisal']['jev']): JevSource {
  if (config.source) return config.source;
  if (config.endpoint === TYPESAFE_JEV_ENDPOINT) return 'typesafe';
  if (config.endpoint.includes('openrouter.ai')) return 'openrouter';
  return 'custom';
}

export function jevSecretName(source: JevSource): string {
  return source === 'openrouter' ? 'CORTICO_JEV_OPENROUTER_API_KEY'
    : source === 'typesafe' ? 'CORTICO_JEV_TYPESAFE_API_KEY' : 'CORTICO_JEV_API_KEY';
}

/**
 * 这份Persona声明的可调项。控制台只按 JSON Schema 渲染,不解释
 * "memo 三级缓存""梦"等人格概念。
 *
 * 模型不归Persona:用哪个模型、怎么想整组归 Provider,它拿不到也不问。
 */
export const PERSONA_CONFIG_GROUP: ConfigGroup = {
  // id 是配置组的实例身份;同一进程中的多个 bot 必须可区分。
  id: 'continuity',
  // owner 是**角色**,词表由框架定(core / persona / module:*)。它回答的是
  // "这组参数归四分法里的哪一块",不包含具体实现名称。
  owner: 'persona',
  schema: {
    type: 'object',
    title: '认知节奏',
    description: '一个 session 阶段有多长、一次唤醒能行动几轮、备忘分层容量、作息与梦的成本边界。',
    properties: {
      'context.maxTokens': {
        type: 'integer',
        title: '上下文阶段预算',
        minimum: 8000,
        maximum: 2_000_000,
        multipleOf: 1000,
        'x-suffix': 'tok',
        'x-hot': true,
        description:
          '上下文超过阶段预算 × 软阈值比例时先提示；下一批结束时仍超出则交接，并启动后台整理。'
          + '模型窗口与单次输出上限在「语言模型」页配置；达到模型硬限制时由 Core 强制交接。',
      },
      'context.keepRatio': {
        type: 'number',
        title: '交接保留比例',
        minimum: 0.05,
        maximum: 0.9,
        multipleOf: 0.01,
        'x-suffix': '×',
        'x-hot': true,
        description: '交接笔记的 token 预算 = 阶段预算 × 此比例。笔记保留最近内容。',
      },
      'context.softRatio': {
        type: 'number',
        title: '软阈值比例',
        minimum: 0.1,
        maximum: 1,
        multipleOf: 0.01,
        'x-suffix': '×',
        'x-hot': true,
        description: '上下文预警阈值 = 阶段预算 × 此比例。',
      },
      'context.firstTurn': {
        type: 'boolean',
        title: '合成首轮对话',
        'x-hot': true,
        description: '把部署 prompts/ 里的首轮对话(FIRST_TURN_USER / THINKING / REPLY)作为合成开头送进每次请求,不写入 session;内容为空时不送。',
      },
      'loop.softCap': {
        type: 'integer',
        title: '工具循环软上限',
        minimum: 1,
        maximum: 100,
        multipleOf: 1,
        'x-suffix': '轮',
        'x-hot': true,
        description: '单次唤醒行动到这一轮,追加一条疲劳提示。',
      },
      'loop.hardCap': {
        type: 'integer',
        title: '工具循环硬上限',
        minimum: 1,
        maximum: 200,
        multipleOf: 1,
        'x-suffix': '轮',
        'x-hot': true,
        description: '到这一轮直接结束本次唤醒。应 ≥ 软上限。',
      },
      'memo.residentCap': {
        type: 'integer',
        title: 'memo 常驻条数',
        minimum: 1,
        maximum: 50,
        multipleOf: 1,
        'x-suffix': '条',
        'x-hot': true,
        description: 'MEMORY 2 常驻区容量；前缀包含这一层的全文。',
      },
      'memo.activeCap': {
        type: 'integer',
        title: 'memo active 条数',
        minimum: 1,
        maximum: 200,
        multipleOf: 1,
        'x-suffix': '条',
        'x-hot': true,
        description: 'memo/active/ 区容量(前缀只列文件名那层)。',
      },
      'tick.dayIntervalMinutes': {
        type: 'array',
        title: '白天 tick 间隔 [最小,最大]',
        items: { type: 'integer', minimum: 1, maximum: 1440 },
        minItems: 2,
        maxItems: 2,
        'x-suffix': 'min',
        'x-hot': true,
        description: '白天两次主动 tick 的间隔在此区间内取随机。',
      },
      'tick.nightIntervalMinutes': {
        type: 'integer',
        title: '深夜 tick 间隔',
        minimum: 0,
        maximum: 1440,
        multipleOf: 1,
        nullable: true,
        'x-suffix': 'min',
        'x-hot': true,
        description: '深夜 tick 间隔分钟;留空(null)＝深夜完全不 tick。',
      },
      'tick.nightStartHour': {
        type: 'integer',
        title: '深夜起始',
        minimum: 0,
        maximum: 23,
        multipleOf: 1,
        'x-suffix': '点',
        'x-hot': true,
        description: '深夜起始整点(含)。',
      },
      'tick.nightEndHour': {
        type: 'integer',
        title: '深夜结束',
        minimum: 0,
        maximum: 23,
        multipleOf: 1,
        'x-suffix': '点',
        'x-hot': true,
        description: '深夜结束整点。',
      },
      'dream.maxRounds': {
        type: 'integer',
        title: '梦 fork 轮数上限',
        minimum: 1,
        maximum: 200,
        multipleOf: 1,
        'x-suffix': '轮',
        'x-hot': true,
        description: '梦的硬结束轮次；软提示不会增加硬上限之外的请求。',
      },
      'appraisal.provider': {
        type: 'string',
        title: '即时评估来源',
        enum: ['random', 'laya', 'jev'],
        'x-hot': true,
        description: 'random 使用本地可复现实验值；laya 使用本地运行时；jev 只在远程文本处理已启用时调用。',
      },
      'appraisal.debugLog': {
        type: 'boolean',
        title: '记录即时评估输出',
        'x-hot': true,
        description: '将来源和三个评分写入运行日志；不包含消息原文或发送者信息。',
      },
      'appraisal.laya.idleTtlMinutes': {
        type: 'integer',
        title: 'Laya 空闲释放时间',
        minimum: 0,
        multipleOf: 1,
        'x-suffix': 'min',
        'x-hot': true,
        description: 'Laya 在最后一次评估后保留的分钟数；与其他使用者共用时取最长 TTL。',
      },
      'appraisal.laya.variant': {
        type: 'string',
        title: 'Laya 模型',
        enum: ['english', 'multilingual'],
        'x-hot': true,
        description: 'english 使用本地 ONNX 运行时；multilingual 使用 Conda 中的官方 Python 模型。',
      },
      'appraisal.laya.pythonExecutable': {
        type: 'string',
        title: '多语言 Laya Python 环境',
        'x-options': 'continuity-conda-python',
        'x-hot': true,
        description: '仅 multilingual 使用；从本机 Conda 环境清单中选择，运行时直接启动该环境的 Python。',
      },
      'appraisal.jev.allowRemoteText': {
        type: 'boolean',
        title: '允许 Jev 处理文本',
        'x-hot': true,
        description: '允许后才会把去标识化的当前消息摘要发送到配置的 Jev 服务。',
      },
      'appraisal.jev.source': {
        type: 'string',
        title: 'Jev 来源',
        enum: ['typesafe', 'openrouter', 'custom'],
        'x-hot': true,
      },
      'appraisal.jev.endpoint': {
        type: 'string',
        title: '自定义 Jev 服务地址',
        'x-hot': true,
        description: '仅自定义来源使用；保留已有部署中的地址。',
      },
      'appraisal.jev.timeoutMs': {
        type: 'integer',
        title: 'Jev 超时',
        minimum: 100,
        maximum: 5_000,
        multipleOf: 100,
        'x-suffix': 'ms',
        'x-hot': true,
        description: '远程评估的最长等待时间；失败时标记评估不可用。',
      },
    },
  },
};

export const PERSONA_DEFAULTS: PersonaConfig = {
  context: { maxTokens: 128000, keepRatio: 0.1, softRatio: 0.85, firstTurn: false },
  loop: { softCap: 8, hardCap: 16 },
  // MEMORY 2 的三层容量(7±2 的 7)
  memo: { residentCap: 7, activeCap: 21 },
  // 作息:白天随机间隔 tick,深夜放缓
  tick: { dayIntervalMinutes: [30, 60], nightIntervalMinutes: 120, nightStartHour: 0, nightEndHour: 8 },
  dream: { maxRounds: 60, softRounds: 40, maxInputTokens: 128000, maxBackgroundTokens: 8000,
    materialRetentionDays: 30, traceRetentionDays: 7, recordDetailedTrace: false, maxRetries: 2, retryDelaySec: 30 },
  cognition: { stateReminderBatches: 10, blacklist: [], whitelist: [] },
  appraisal: {
    provider: 'random',
    debugLog: false,
    laya: { idleTtlMinutes: 5, variant: 'english', pythonExecutable: '' },
    jev: { allowRemoteText: false, endpoint: 'https://api.typesafe.ai/v1/systemone', timeoutMs: 1000 },
  },
};

const integer = (title: string, minimum: number, maximum: number, suffix: string) =>
  ({ type: 'integer' as const, title, minimum, maximum, 'x-suffix': suffix, 'x-hot': true });
Object.assign(PERSONA_CONFIG_GROUP.schema.properties, {
  'dream.softRounds': integer('梦收尾提示轮次', 1, 200, '轮'),
  'dream.maxRetries': { ...integer('中断后最多重试次数', 0, 10, '次'), description: '未确认收尾时重新整理未完成材料；0 关闭自动重试。明确收尾为部分完成时不自动重试。' },
  'dream.retryDelaySec': integer('中断重试间隔', 0, 3600, '秒'),
  'dream.maxInputTokens': { ...integer('梦初始输入预算（本地估算）', 8000, 2000000, 'tok'), description: '包含前缀、引导、当前 STATE、背景和材料目录；后续工具结果及服务端工具声明不计入此初始预算。' },
  'dream.maxBackgroundTokens': integer('旧交接背景预算（本地估算）', 0, 100000, 'tok'),
  'dream.materialRetentionDays': integer('已完成原始材料保留时间', 1, 3650, '天'),
  'dream.traceRetentionDays': integer('详细追踪保留时间', 1, 365, '天'),
  'dream.recordDetailedTrace': { type: 'boolean', title: '记录详细工具追踪', 'x-hot': true },
  'cognition.stateReminderBatches': { ...integer('STATE 重复提醒间隔', 0, 10000, '批'), description: '每隔多少次投递提醒一次STATE；0 关闭重复提醒。' },
  ...Object.fromEntries(['blacklist', 'whitelist'].map((name) => [`cognition.${name}`, {
    type: 'array', title: name === 'blacklist' ? '黑名单' : '白名单', maxItems: 500,
    items: { type: 'object', properties: {
      id: { type: 'string' }, label: { type: 'string' }, enabled: { type: 'boolean' },
      match: { type: 'object', properties: Object.fromEntries(['world', 'eventType', 'sceneKind', 'sceneKey', 'senderKey'].map((key) => [key, {
        oneOf: [{ type: 'string', maxLength: 200 }, { type: 'object', required: ['kind', 'pattern', 'ignoreCase'], additionalProperties: false,
          properties: { kind: { const: 'regex' }, pattern: { type: 'string', maxLength: 200 }, ignoreCase: { type: 'boolean', default: false } } }],
      }])) },
    } }, 'x-hot': true,
  }])),
});

export const COGNITION_CONFIG_GROUP: ConfigGroup = { id: 'continuity-cognition', owner: 'persona', schema: {
  type: 'object', title: '认知帧', properties: Object.fromEntries(Object.entries(PERSONA_CONFIG_GROUP.schema.properties)
    .filter(([path]) => path.startsWith('appraisal.') || path.startsWith('cognition.'))),
} };
export const DREAM_CONFIG_GROUP: ConfigGroup = { id: 'continuity-dream', owner: 'persona', schema: {
  type: 'object', title: '梦', properties: Object.fromEntries(Object.entries(PERSONA_CONFIG_GROUP.schema.properties)
    .filter(([path]) => path.startsWith('dream.') || path === 'context.keepRatio')),
} };
export const GENERAL_CONFIG_GROUP: ConfigGroup = { id: 'continuity-general', owner: 'persona', schema: {
  type: 'object', title: '配置', properties: Object.fromEntries(Object.entries(PERSONA_CONFIG_GROUP.schema.properties)
    .filter(([path]) => !COGNITION_CONFIG_GROUP.schema.properties[path] && !DREAM_CONFIG_GROUP.schema.properties[path])),
} };

export function dreamConfig(raw: PersonaConfig['dream']): Required<PersonaConfig['dream']> {
  const merged = { ...PERSONA_DEFAULTS.dream, ...raw } as Required<PersonaConfig['dream']>;
  if (raw.softRounds === undefined) merged.softRounds = Math.min(merged.softRounds, merged.maxRounds);
  return merged;
}
