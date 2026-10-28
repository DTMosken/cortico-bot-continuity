/** Durable original records remain readable until dream explicitly confirms completion. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { estimateMessagesTokens, estimateTokens } from 'cortico/core/util.ts';

export interface Material { id: string; createdAtMs: number; completedAtMs: number | null; records: ContextRecord[] }
type MaterialIndex = Omit<Material, 'records'>;

/** Counts attempts in original records; neither a proceed nor a cancellation is a correctness label. */
export function reviewSignals(records: readonly ContextRecord[]): { staged: number; proceed: number; cancel: number } {
  const signals = { staged: 0, proceed: 0, cancel: 0 };
  for (const record of records) {
    if (record.item.type === 'function_call_output' && textOf(record).startsWith('[state review staged]')) signals.staged++;
    if (record.item.type !== 'function_call' || record.item.name !== 'state_review_resolve') continue;
    try {
      const args = JSON.parse(record.item.arguments);
      if (args?.decision === 'proceed' || args?.decision === 'cancel') signals[args.decision as 'proceed' | 'cancel']++;
    } catch { /* Malformed historical calls remain available in the original material. */ }
  }
  return signals;
}

export function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, file);
}

export class DreamMaterials {
  private index: MaterialIndex[] = [];
  private readonly memory = new Map<string, ContextRecord[]>();
  constructor(private readonly dir?: string) {
    if (dir) {
      mkdirSync(join(dir, 'raw'), { recursive: true });
      try { this.index = JSON.parse(readFileSync(join(dir, 'materials.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  add(records: readonly ContextRecord[]): string[] {
    const episode = randomUUID();
    const groups: ContextRecord[][] = [];
    let current: ContextRecord[] = [];
    const open = new Set<string>();
    for (const record of records) {
      if (hasRole(record, 'system') || record.context.head || record.context.ephemeral) continue;
      if (hasRole(record, 'user') && current.length && open.size === 0) { groups.push(current); current = []; }
      current.push(structuredClone(record));
      if (record.item.type === 'function_call') open.add(record.item.call_id);
      if (record.item.type === 'function_call_output') open.delete(record.item.call_id);
    }
    if (current.length) groups.push(current);
    const ids = groups.map((group, i) => {
      const id = `${episode}-${i}`;
      if (this.dir) writeJson(join(this.dir, 'raw', `${id}.json`), group);
      else this.memory.set(id, group);
      this.index.push({ id, createdAtMs: Date.now(), completedAtMs: null });
      return id;
    });
    this.save();
    return ids;
  }
  pending(): Material[] {
    return this.index.filter((item) => item.completedAtMs === null).map((item) => ({ ...item, records: this.records(item.id) }));
  }
  list(): MaterialIndex[] { return structuredClone(this.index); }
  reviewSignals(id: string): ReturnType<typeof reviewSignals> { return reviewSignals(this.records(id)); }
  read(id: string, start: number, maxChars: number): string {
    const records = this.records(id);
    const text = records.map((record) => record.item.type === 'function_call'
      ? `[call ${record.item.call_id}] ${record.item.name} ${record.item.arguments}`
      : `[${record.item.type === 'function_call_output' ? `result ${record.item.call_id}` : record.item.type}] ${textOf(record)}`).join('\n\n');
    return JSON.stringify({ id, start, next: Math.min(text.length, start + maxChars), totalChars: text.length, text: text.slice(start, start + maxChars) });
  }
  complete(ids: readonly string[], now = Date.now()): void {
    for (const id of ids) if (!this.index.some((item) => item.id === id)) throw new Error(`Unknown material: ${id}`);
    for (const item of this.index) if (ids.includes(item.id)) item.completedAtMs = now;
    this.save();
  }
  cleanup(retentionDays: number, now = Date.now()): void {
    const expired = this.index.filter((item) => item.completedAtMs !== null && now - item.completedAtMs >= retentionDays * 86400000);
    for (const item of expired) {
      if (this.dir) unlinkSync(join(this.dir, 'raw', `${item.id}.json`));
      this.memory.delete(item.id);
    }
    this.index = this.index.filter((item) => !expired.includes(item));
    this.save();
  }
  private records(id: string): ContextRecord[] {
    if (!this.index.some((item) => item.id === id)) throw new Error(`Unknown material: ${id}`);
    return this.dir ? JSON.parse(readFileSync(join(this.dir, 'raw', `${id}.json`), 'utf8')) : structuredClone(this.memory.get(id)!);
  }
  private save(): void { if (this.dir) writeJson(join(this.dir, 'materials.json'), this.index); }
}

/** JSON records plus base64 image payloads; native serialization overhead varies by provider. */
function inputBytes(records: ContextRecord[], blobBytes: (handle: string) => number | null): { bytes: number; images: number } {
  let bytes = Buffer.byteLength(JSON.stringify(records));
  let images = 0;
  for (const record of records) {
    if (record.item.type !== 'message' && record.item.type !== 'function_call_output') continue;
    for (const ref of record.context.blobs ?? []) {
      if (!ref.mime.startsWith('image/')) continue;
      const size = blobBytes(ref.handle);
      if (size === null) continue;
      images++;
      bytes += 4 * Math.ceil(size / 3) + Buffer.byteLength(JSON.stringify({ type: 'input_image', image_url: `data:${ref.mime};base64,` }));
    }
    const content = record.item.type === 'message' ? record.item.content : record.item.output;
    if (Array.isArray(content)) images += content.filter(part => part.type === 'input_image').length;
  }
  return { bytes, images };
}

/** Byte budget includes reserved tool schemas; excludes provider-specific request fields. */
export function prepareDreamInput(materials: Material[], options: {
  maxInputTokens: number; maxInputBytes: number; blobBytes: (handle: string) => number | null;
  reservedBytes?: number;
  maxBackgroundTokens: number; system: ContextRecord[]; guide: string; state: string; background: string; reviewFeedback?: boolean;
}): { messages: ContextRecord[]; materialIds: string[]; included: string[]; omitted: string[]; inputTokens: number; inputBytes: number; backgroundTokens: number; stateTokens: number } {
  const clip = (text: string, tokens: number): string => estimateTokens(text) <= tokens ? text
    : text.slice(0, Math.max(0, Math.floor(text.length * tokens / estimateTokens(text))));
  const background = clip(options.background, options.maxBackgroundTokens);
  const signals = options.reviewFeedback ? materials.map(material => reviewSignals(material.records)).reduce((sum, item) => ({ staged: sum.staged + item.staged, proceed: sum.proceed + item.proceed, cancel: sum.cancel + item.cancel }), { staged: 0, proceed: 0, cancel: 0 }) : { staged: 0, proceed: 0, cancel: 0 };
  const guide = message('user', [options.guide, `[system/continuity-state]\n${options.state}`,
    background ? `Previous handoff background (not new evidence):\n${background}` : '',
    `Original material queue: ${materials.length} unprocessed pieces. This dream covers the oldest batch that fits the input budget. dream_materials lists only this batch; later materials remain for another batch.`,
    ...(options.reviewFeedback && (signals.staged || signals.proceed || signals.cancel) ? [`STATE review signals in the retained queue: ${JSON.stringify(signals)}. These are receipt/resolve-attempt counts, not confirmed misjudgments. dream_materials indexes signals for readable materials in this batch.`] : []),
    ...(materials.length ? [`First queued material: ${materials[0]!.id}. If its body does not fit above, use dream_read_material in bounded ranges to read it. Local retained materials remain readable when their World is hidden or disconnected.`] : []),
  ].filter(Boolean).join('\n\n'));
  const fixed = [...options.system, guide];
  if (estimateMessagesTokens(fixed) > options.maxInputTokens) throw new Error('Dream prefix and guide exceed the initial input budget; materials retained. Increase the budget or reduce the prefix.');
  let usedBytes = inputBytes(fixed, options.blobBytes).bytes + (options.reservedBytes ?? 0);
  if (usedBytes > options.maxInputBytes) throw new Error('Dream prefix, guide and tool schemas exceed the initial byte budget; materials retained. Increase dream.maxInputBytes or reduce the prefix or tool schemas.');
  const selected: Material[] = [];
  let used = estimateMessagesTokens(fixed);
  for (const material of materials) {
    const records = [message('user', `Material ${material.id}`), ...material.records];
    const size = estimateMessagesTokens(records);
    const payload = inputBytes(records, options.blobBytes);
    if (used + size > options.maxInputTokens || usedBytes + payload.bytes > options.maxInputBytes) {
      if (!selected.length && payload.images) throw new Error(`Dream image material ${material.id} exceeds the initial token or byte budget (${payload.bytes} material bytes, ${options.maxInputBytes} byte limit); materials retained. Increase dream.maxInputTokens or dream.maxInputBytes, or reduce the image material.`);
      break;
    }
    selected.push(material);
    used += size;
    usedBytes += payload.bytes;
  }
  const included = selected.map((material) => material.id);
  const materialIds = included.length ? included : materials.slice(0, 1).map((material) => material.id);
  const omitted = materials.filter((material) => !included.includes(material.id)).map((material) => material.id);
  const messages = [...options.system, ...selected.flatMap((material) => [message('user', `Material ${material.id}`), ...material.records]), guide];
  return { messages, materialIds, included, omitted, inputTokens: estimateMessagesTokens(messages), inputBytes: usedBytes, backgroundTokens: estimateTokens(background), stateTokens: estimateTokens(options.state) };
}
