/** Frame rules gate appraisal; STATE refresh counts every external delivery batch. */
import { RE2JS } from 're2js';

export interface FrameValues {
  world?: string;
  eventType?: string;
  sceneKind?: string;
  sceneKey?: string;
  senderKey?: string;
}
export interface RegexCondition { kind: 'regex'; pattern: string; ignoreCase: boolean }
export type FrameMatch = { [K in keyof FrameValues]?: string | RegexCondition };
export interface FrameRule { id: string; label: string; enabled: boolean; match: FrameMatch }
export interface CognitionConfig { stateReminderBatches: number; blacklist: FrameRule[]; whitelist: FrameRule[] }
export interface FrameDecision { trigger: boolean; reason: 'whitelist' | 'blacklist' | 'default'; ruleId?: string }
export interface ObservedEvent extends Required<FrameValues> { cursor: number; ts: string; text: string }
const MATCH_KEYS = ['world', 'eventType', 'sceneKind', 'sceneKey', 'senderKey'] as const;
const compiled = new WeakMap<RegexCondition, { signature: string; expression?: RE2JS; error?: string }>();

function compile(condition: RegexCondition): { expression?: RE2JS; error?: string } {
  const signature = JSON.stringify(condition);
  const cached = compiled.get(condition);
  if (cached?.signature === signature) return cached;
  let result: { expression?: RE2JS; error?: string };
  try { result = { expression: RE2JS.compile(condition.pattern, condition.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0) }; }
  catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
  compiled.set(condition, { signature, ...result });
  return result;
}

export function conditionError(value: unknown): string | null {
  if (typeof value === 'string') return value.length <= 200 ? null : '条件最多 200 个字符';
  const item = value as RegexCondition | null;
  if (!item || typeof item !== 'object' || item.kind !== 'regex' || typeof item.pattern !== 'string'
    || typeof item.ignoreCase !== 'boolean' || Object.keys(item).some((key) => !['kind', 'pattern', 'ignoreCase'].includes(key))) return '匹配条件格式无效';
  if (item.pattern.length > 200) return '正则最多 200 个字符';
  return compile(item).error ?? null;
}

export function ruleError(rule: FrameRule): string | null {
  try { validateRules([rule]); return null; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

export function decideFrame(event: FrameValues, lists: Pick<CognitionConfig, 'blacklist' | 'whitelist'>): FrameDecision {
  const match = (rule: FrameRule): boolean => rule.enabled && !ruleError(rule) && MATCH_KEYS.every((key) => {
    const condition = rule.match[key];
    if (condition === undefined || condition === '' || (typeof condition !== 'string' && condition.pattern === '')) return true;
    return typeof condition === 'string' ? condition === event[key] : compile(condition).expression!.matches(event[key] ?? '');
  });
  const white = lists.whitelist.find(match);
  if (white) return { trigger: true, reason: 'whitelist', ruleId: white.id };
  const black = lists.blacklist.find(match);
  return black ? { trigger: false, reason: 'blacklist', ruleId: black.id } : { trigger: true, reason: 'default' };
}

export function validateRules(value: unknown): FrameRule[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('名单必须是数组，最多 500 条规则');
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 100
      || ids.has(raw.id) || typeof raw.label !== 'string' || raw.label.length > 160 || typeof raw.enabled !== 'boolean'
      || !raw.match || typeof raw.match !== 'object' || Array.isArray(raw.match)) throw new Error('规则格式无效或 ID 重复');
    ids.add(raw.id);
    const match: FrameMatch = {};
    for (const [key, item] of Object.entries(raw.match)) {
      if (!MATCH_KEYS.includes(key as typeof MATCH_KEYS[number])) throw new Error('未知匹配条件：' + key);
      const error = conditionError(item);
      if (error) throw new Error(key + '：' + error);
      if (typeof item === 'string') { if (item.trim()) match[key as keyof FrameMatch] = item.trim(); }
      else if ((item as RegexCondition).pattern) match[key as keyof FrameMatch] = { ...(item as RegexCondition) };
    }
    return { id: raw.id, label: raw.label.trim(), enabled: raw.enabled, match };
  });
}

export class StateRefresh {
  private previous: string | null = null;
  private batches = 0;
  restore(value: unknown): void {
    const saved = value as { previous?: unknown; batches?: unknown } | undefined;
    if (typeof saved?.previous === 'string' && Number.isInteger(saved.batches) && (saved.batches as number) >= 0) {
      this.previous = saved.previous; this.batches = saved.batches as number;
    }
  }
  snapshot(): { previous: string | null; batches: number } { return { previous: this.previous, batches: this.batches }; }
  reset(): void { this.previous = null; this.batches = 0; }
  next(text: string, interval: number): boolean {
    this.batches++;
    if (text !== this.previous || (interval > 0 && this.batches >= interval)) {
      this.previous = text;
      this.batches = 0;
      return true;
    }
    return false;
  }
}
