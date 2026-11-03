import { renameSync, writeFileSync } from 'node:fs';
import { readTextFile } from 'cortico/core/util.ts';
import { join } from 'node:path';
import type { FrameValues } from './cognition.ts';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { retryBusy } from 'cortico/core/fs-busy.ts';

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

export const isQqPrivateScene = (key: string): boolean => /^qq:private:/iu.test(key);

interface HistoryState { version: 1; scenes: Record<string, AppraisalMessage[]> }
const MAX_HISTORY = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SCENES = 200;

/** QQ supplies a conversation key; dungeon currently uses senderKey for scene identity. */
export function sceneFor(event: EventEnvelope): { key: string; kind: 'person' | 'scene' | 'unknown' } {
  const source = event.source || 'unknown';
  const meta = event.meta as { conv?: { kind?: unknown; id?: unknown } } | undefined;
  const conv = meta?.conv;
  if (conv && (conv.kind === 'group' || conv.kind === 'private' || conv.kind === 'channel') && (typeof conv.id === 'string' || typeof conv.id === 'number')) {
    return { key: `${source}:${conv.kind}:${conv.id}`, kind: conv.kind === 'private' ? 'person' : 'scene' };
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
    let pruned = false;
    try {
      this.state = JSON.parse(readTextFile(this.file)) as HistoryState;
      pruned = this.prune();
    } catch {
      this.state = { version: 1, scenes: {} };
    }
    if (pruned) this.save();
  }

  recent(scene: string): AppraisalMessage[] {
    if (this.prune()) this.save();
    return [...this.state.scenes[scene] ?? []];
  }

  add(scene: string, items: AppraisalMessage[]): void {
    const existing = this.state.scenes[scene] ?? [];
    const seen = new Set(existing.filter((item) => item.cursor !== undefined).map((item) => item.cursor));
    const fresh = items.filter((item) => item.cursor === undefined || !seen.has(item.cursor));
    if (fresh.length) this.state.scenes[scene] = [...existing, ...fresh];
    const pruned = this.prune();
    if (fresh.length || pruned) this.save();
  }

  private prune(): boolean {
    const cutoff = Date.now() - MAX_AGE_MS;
    let changed = false;
    for (const [key, entries] of Object.entries(this.state.scenes)) {
      const retained = entries.filter(item => Date.parse(item.ts) >= cutoff).slice(-MAX_HISTORY);
      if (retained.length === entries.length && retained.length) continue;
      changed = true;
      if (retained.length) this.state.scenes[key] = retained;
      else delete this.state.scenes[key];
    }
    const keys = Object.keys(this.state.scenes);
    if (keys.length > MAX_SCENES) {
      keys.sort((left, right) => Date.parse(this.state.scenes[left]!.at(-1)!.ts) - Date.parse(this.state.scenes[right]!.at(-1)!.ts));
      for (const key of keys.slice(0, keys.length - MAX_SCENES)) delete this.state.scenes[key];
      changed = true;
    }
    return changed;
  }

  private save(): void {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state)}\n`, 'utf8');
    retryBusy(() => renameSync(temp, this.file));
  }

}

export function eventMatch(event: EventEnvelope): Required<FrameValues> {
  const scene = sceneFor(event);
  const conv = (event.meta as { conv?: { kind?: string } } | undefined)?.conv;
  return { world: event.source || 'unknown', eventType: event.type || 'unknown', sceneKey: scene.key,
    sceneKind: conv?.kind || (scene.kind === 'person' ? 'private' : scene.kind), senderKey: event.senderKey ?? '' };
}
