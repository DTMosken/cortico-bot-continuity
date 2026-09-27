import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope } from 'cortico/core/types.ts';

export interface AppraisalMessage {
  cursor?: number;
  messageId?: string;
  ts: string;
  source: string;
  type: string;
  speaker: string;
  text: string;
  role: 'external' | 'bot';
}

export interface AppraisalInput {
  scene: string;
  current: AppraisalMessage[];
  history: AppraisalMessage[];
  mechanical?: Record<string, string>;
}

interface HistoryState { version: 1; scenes: Record<string, AppraisalMessage[]> }
const MAX_HISTORY = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SCENES = 200;

/** QQ supplies a conversation key; dungeon currently uses senderKey for scene identity. */
export function sceneFor(event: EventEnvelope): { key: string; kind: 'person' | 'scene' | 'unknown' } {
  const source = event.source || 'unknown';
  const meta = event.meta as { conv?: { kind?: unknown; id?: unknown } } | undefined;
  const conv = meta?.conv;
  if (conv && (conv.kind === 'group' || conv.kind === 'private') && (typeof conv.id === 'string' || typeof conv.id === 'number')) {
    return { key: `${source}:${conv.kind}:${conv.id}`, kind: conv.kind === 'group' ? 'scene' : 'person' };
  }
  if (source.toLowerCase() === 'qq' && event.senderKey) {
    return { key: `${source}:private:${event.senderKey}`, kind: 'person' };
  }
  if (source === 'dungeon' && event.senderKey) {
    return { key: `${source}:scene:${event.senderKey}`, kind: 'scene' };
  }
  return { key: `${source}:batch`, kind: 'unknown' };
}

export function toAppraisalMessage(event: EventEnvelope): AppraisalMessage {
  const meta = event.meta as { sender_name?: unknown; message_id?: unknown } | undefined;
  return {
    cursor: event.cursor,
    messageId: meta?.message_id === undefined ? undefined : String(meta.message_id),
    ts: event.ts,
    source: event.source || 'unknown',
    type: event.type || 'unknown',
    speaker: typeof meta?.sender_name === 'string' ? meta.sender_name : event.senderKey || 'unknown',
    text: typeof event.text === 'string' ? event.text : '',
    role: 'external',
  };
}

export class AppraisalHistory {
  private readonly file: string;
  private readonly state: HistoryState;

  constructor(memoryDir: string) {
    this.file = join(memoryDir, 'state', 'appraisal-history.json');
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as HistoryState;
      this.state = parsed.version === 1 && parsed.scenes && typeof parsed.scenes === 'object'
        ? parsed : { version: 1, scenes: {} };
    } catch {
      this.state = { version: 1, scenes: {} };
    }
  }

  recent(scene: string, now: string): AppraisalMessage[] {
    const cutoff = Date.parse(now) - MAX_AGE_MS;
    return (this.state.scenes[scene] ?? []).filter((item) => Number.isFinite(cutoff) && Date.parse(item.ts) >= cutoff).slice(-MAX_HISTORY);
  }

  add(scene: string, items: AppraisalMessage[]): void {
    if (items.length === 0) return;
    const existing = this.state.scenes[scene] ?? [];
    const seen = new Set(existing.filter((item) => item.cursor !== undefined).map((item) => item.cursor));
    const fresh = items.filter((item) => item.cursor === undefined || !seen.has(item.cursor));
    if (fresh.length === 0) return;
    const now = fresh.at(-1)!.ts;
    const cutoff = Date.parse(now) - MAX_AGE_MS;
    if (Number.isFinite(cutoff)) {
      for (const [key, entries] of Object.entries(this.state.scenes)) {
        const retained = entries.filter((item) => Date.parse(item.ts) >= cutoff).slice(-MAX_HISTORY);
        if (retained.length) this.state.scenes[key] = retained;
        else delete this.state.scenes[key];
      }
    }
    this.state.scenes[scene] = [...existing, ...fresh]
      .filter((item) => !Number.isFinite(cutoff) || Date.parse(item.ts) >= cutoff)
      .slice(-MAX_HISTORY);
    const keys = Object.keys(this.state.scenes);
    if (keys.length > MAX_SCENES) {
      keys.sort((left, right) => Date.parse(this.state.scenes[left]!.at(-1)!.ts) - Date.parse(this.state.scenes[right]!.at(-1)!.ts));
      for (const key of keys.slice(0, keys.length - MAX_SCENES)) delete this.state.scenes[key];
    }
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state)}\n`, 'utf8');
    renameSync(temp, this.file);
  }
}
