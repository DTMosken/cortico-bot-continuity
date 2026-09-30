/** Frame rules gate appraisal; STATE refresh counts every external delivery batch. */

export interface FrameMatch {
  world?: string;
  eventType?: string;
  sceneKind?: string;
  sceneKey?: string;
  senderKey?: string;
}
export interface FrameRule { id: string; label: string; enabled: boolean; match: FrameMatch }
export interface CognitionConfig { stateReminderBatches: number; blacklist: FrameRule[]; whitelist: FrameRule[] }
export interface FrameDecision { trigger: boolean; reason: 'whitelist' | 'blacklist' | 'default'; ruleId?: string }
export interface ObservedEvent extends Required<FrameMatch> { cursor: number; ts: string; text: string }
const MATCH_KEYS = ['world', 'eventType', 'sceneKind', 'sceneKey', 'senderKey'] as const;

export function decideFrame(event: FrameMatch, lists: Pick<CognitionConfig, 'blacklist' | 'whitelist'>): FrameDecision {
  const match = (rule: FrameRule): boolean => rule.enabled && MATCH_KEYS.every((key) => !rule.match[key] || rule.match[key] === event[key]);
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
      if (!MATCH_KEYS.includes(key as typeof MATCH_KEYS[number]) || typeof item !== 'string' || item.length > 200) throw new Error('匹配条件无效');
      if (item.trim()) match[key as keyof FrameMatch] = item.trim();
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
