import { coerceGroupValues, type ConfigGroup } from 'cortico/core/config-schema.ts';

export interface ToolPermissions {
  enabled: boolean;
  tools: Record<string, boolean>;
}

export interface SubagentsConfig {
  enabled: boolean;
  maxWorkers: number;
  softRounds: number;
  maxRounds: number;
  timeoutMs: number;
  maxSummaryChars: number;
  resultPageChars: number;
  permissions: Record<string, ToolPermissions>;
  cognitionPermissions: Record<string, ToolPermissions>;
}

export const SUBAGENTS_DEFAULTS: SubagentsConfig = {
  enabled: true, maxWorkers: 4, softRounds: 16, maxRounds: 64, timeoutMs: 900_000,
  maxSummaryChars: 1000, resultPageChars: 2000, permissions: {}, cognitionPermissions: {},
};

const integer = (title: string, maximum: number, suffix: string) =>
  ({ type: 'integer' as const, title, minimum: 1, maximum, 'x-suffix': suffix, 'x-hot': true });

export const SUBAGENTS_CONFIG_GROUP: ConfigGroup = {
  id: 'continuity-subagents', owner: 'persona',
  schema: { type: 'object', title: '子代理', properties: {
    'subagents.enabled': { type: 'boolean', title: '启用子代理', 'x-hot': true },
    'subagents.maxWorkers': integer('同时运行上限', 64, '项'),
    'subagents.softRounds': integer('轮数提醒起点', 200, '轮'),
    'subagents.maxRounds': { ...integer('硬结束轮次', 200, '轮'), minimum: 2 },
    'subagents.timeoutMs': { ...integer('任务时限', 900_000, '分钟'), 'x-scale': 60_000 },
    'subagents.maxSummaryChars': integer('摘要上限', 16000, '字符'),
    'subagents.resultPageChars': integer('结果默认页长', 32000, '字符'),
  } },
};
Object.assign(SUBAGENTS_CONFIG_GROUP.schema.properties, {
  'subagents.permissions': {
    type: 'object', title: '主线子代理权限', 'x-hot': true,
    additionalProperties: { type: 'object', required: ['enabled', 'tools'], additionalProperties: false, properties: {
      enabled: { type: 'boolean' }, tools: { type: 'object', additionalProperties: { type: 'boolean' } },
    } },
  },
});
SUBAGENTS_CONFIG_GROUP.schema.properties['subagents.cognitionPermissions'] = {
  ...SUBAGENTS_CONFIG_GROUP.schema.properties['subagents.permissions'], title: 'World扩展子代理权限',
};

export function subagentsConfig(raw?: Partial<SubagentsConfig>): SubagentsConfig {
  return { ...SUBAGENTS_DEFAULTS, ...raw, permissions: structuredClone(raw?.permissions ?? {}),
    cognitionPermissions: structuredClone(raw?.cognitionPermissions ?? {}) };
}

export function validateSubagentsDraft(input: Record<string, unknown>, current: SubagentsConfig): SubagentsConfig {
  for (const key of Object.keys(input)) {
    if (!SUBAGENTS_CONFIG_GROUP.schema.properties[key]) throw new Error('未知配置项：' + key);
  }
  const checked = coerceGroupValues(SUBAGENTS_CONFIG_GROUP, input);
  if ('error' in checked) throw new Error(checked.error);
  const next = subagentsConfig(current);
  for (const [key, value] of Object.entries(checked.values)) {
    (next as unknown as Record<string, unknown>)[key.slice('subagents.'.length)] = value;
  }
  for (const key of ['permissions', 'cognitionPermissions'] as const) {
    if (!('subagents.' + key in input)) continue;
    const permissions = input['subagents.' + key];
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) throw new Error('工具权限格式无效');
    const entries: Array<[string, ToolPermissions]> = [];
    for (const [id, raw] of Object.entries(permissions)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工具组格式无效');
      const group = raw as Record<string, unknown>;
      if (Object.keys(group).some(key => key !== 'enabled' && key !== 'tools') || typeof group.enabled !== 'boolean'
        || !group.tools || typeof group.tools !== 'object' || Array.isArray(group.tools)) throw new Error('工具组权限格式无效');
      const tools = Object.entries(group.tools);
      if (tools.some(([name, allowed]) => !/^[a-zA-Z0-9_]+$/.test(name) || typeof allowed !== 'boolean')) throw new Error('工具权限必须为开关值');
      entries.push([id, { enabled: group.enabled, tools: Object.fromEntries(tools) as Record<string, boolean> }]);
    }
    next[key] = Object.fromEntries(entries);
  }
  if (next.softRounds >= next.maxRounds) throw new Error('轮数提醒起点必须小于硬结束轮次');
  return next;
}
