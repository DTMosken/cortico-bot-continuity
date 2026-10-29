/** Durable original records remain readable until dream explicitly confirms completion. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { estimateMessagesTokens, estimateTokens } from 'cortico/core/util.ts';
import type { BlobRef } from 'cortico/core/types.ts';

export interface Material { id: string; createdAtMs: number; completedAtMs: number | null; records: ContextRecord[]; archivedImages?: UnreadImage[]; textCompletedAtMs?: number }
export interface UnreadImage { handle?: string; recordIndex: number; partIndex?: number; }
export interface UnreadMaterialImages { id: string; images: UnreadImage[]; }
type MaterialSummary = Omit<Material, 'records'>;
type MaterialIndex = MaterialSummary & { deferredImages?: Array<UnreadImage & { extraDreamUsed: boolean }> };

function summary({ deferredImages: _deferred, ...item }: MaterialIndex): MaterialSummary { return structuredClone(item); }

function sameImage(a: UnreadImage, b: UnreadImage): boolean {
  return a.recordIndex === b.recordIndex && a.partIndex === b.partIndex
    && (a.partIndex !== undefined || a.handle === b.handle);
}

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
  private readonly observedImages = new Set<string>();
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
      this.index.push({ id, createdAtMs: Date.now(), completedAtMs: null, deferredImages: [] });
      return id;
    });
    this.save();
    return ids;
  }
  pending(): Material[] {
    return this.active().map((item) => ({ ...summary(item), records: this.records(item.id) }));
  }
  pendingCount(): number { return this.active().length; }
  archivedUnreadCount(): number { return this.index.filter(item => item.archivedImages?.length).length; }
  /** One call per independent handoff/continuation, before its batches and retries. */
  beginDream(knownUnread: UnreadMaterialImages[] = []): void {
    this.observedImages.clear();
    const legacyIds = new Set(this.active().filter(item => item.deferredImages === undefined).map(item => item.id));
    let changed = this.retainUnread(knownUnread.filter(entry => legacyIds.has(entry.id)));
    for (const item of this.active()) {
      if (!item.deferredImages?.length) continue;
      const retained: NonNullable<MaterialIndex['deferredImages']> = [];
      for (const image of item.deferredImages) {
        if (image.extraDreamUsed) {
          const { extraDreamUsed: _used, ...reference } = image;
          (item.archivedImages ??= []).push(reference);
        } else retained.push(image);
      }
      item.deferredImages = retained;
      changed = true;
    }
    if (changed) this.save();
  }
  /** Record a model response to this input; included images absent from unread have fit again. */
  recordUnread(unread: UnreadMaterialImages[], included: string[] = []): void {
    let changed = false;
    for (const item of this.active()) if (included.includes(item.id) && item.deferredImages?.length) {
      const images = unread.find(entry => entry.id === item.id)?.images ?? [];
      const retained = item.deferredImages.filter(image => images.some(reference => sameImage(image, reference)));
      if (retained.length !== item.deferredImages.length) { item.deferredImages = retained; changed = true; }
    }
    if (this.retainUnread(unread, true) || changed) this.save();
  }
  private retainUnread(unread: UnreadMaterialImages[], observe = false): boolean {
    let changed = false;
    for (const entry of unread) {
      const item = this.active().find(item => item.id === entry.id);
      if (!item) continue;
      for (const image of entry.images) {
        if (item.archivedImages?.some(archived => sameImage(image, archived))) continue;
        const retained = item.deferredImages?.find(retained => sameImage(image, retained));
        const key = JSON.stringify([item.id, image.handle, image.recordIndex, image.partIndex]);
        if (!retained) { (item.deferredImages ??= []).push({ ...image, extraDreamUsed: false }); changed = true; }
        else if (observe && !this.observedImages.has(key) && !retained.extraDreamUsed) { retained.extraDreamUsed = true; changed = true; }
        if (observe) this.observedImages.add(key);
      }
    }
    return changed;
  }
  private active(): MaterialIndex[] { return this.index.filter(item => item.completedAtMs === null && item.textCompletedAtMs === undefined); }
  list(): MaterialSummary[] { return this.index.map(summary); }
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
    for (const item of this.index) if (ids.includes(item.id)) {
      if (item.archivedImages?.length) item.textCompletedAtMs = now;
      else item.completedAtMs = now;
      delete item.deferredImages;
    }
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

export class DreamInputBudgetError extends Error {}

/** Initial material input contains image references only; original image content stays in raw records. */
function materialReferences(material: Material, internImage?: (bytes: Uint8Array, mime: string) => BlobRef): { records: ContextRecord[]; images: UnreadImage[] } {
  const records = structuredClone(material.records);
  const images: UnreadImage[] = [];
  records.forEach((entry, recordIndex) => {
    const archived = (image: UnreadImage) => material.archivedImages?.some(ref => sameImage(image, ref));
    const notices: string[] = [];
    const reference = (image: UnreadImage, address?: string) => {
      if (!archived(image)) images.push(image);
      notices.push(`[image ${archived(image) ? 'archived unread' : 'not read'}] material ${material.id}, record ${recordIndex}${image.partIndex === undefined ? '' : `, part ${image.partIndex}`}${image.handle ? `; blob ${image.handle}` : ''}${address && !address.startsWith('data:') ? `; address ${address}` : ''}. Use available tools to inspect this image when needed.`);
    };
    entry.context.blobs = entry.context.blobs?.filter(ref => {
      if (!ref.mime.startsWith('image/')) return true;
      reference({ handle: ref.handle, recordIndex }); return false;
    });
    const item = entry.item;
    if (item.type === 'message' || item.type === 'function_call_output') {
      const content = item.type === 'message' ? item.content : item.output;
      if (Array.isArray(content)) {
        content.forEach((part, partIndex) => {
          if (part.type !== 'input_image') return;
          const data = part.image_url?.match(/^data:(image\/[^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
          const blob = data && internImage ? internImage(Buffer.from(data[2], 'base64'), data[1]) : null;
          reference({ recordIndex, partIndex, ...(blob ? { handle: blob.handle } : {}) }, part.image_url ?? undefined);
        });
        for (let index = content.length - 1; index >= 0; index--) if (content[index].type === 'input_image') content.splice(index, 1);
        if (!content.length && notices.length) {
          if (item.type === 'message') records[recordIndex] = message(item.role, '[image reference]', entry.context);
          else item.output = '[image reference]';
        }
      }
    }
    if (notices.length) records.push(message('user', notices.join('\n')));
  });
  return { records, images };
}

/** Byte budget includes reserved tool schemas; excludes provider-specific request fields. */
export function prepareDreamInput(materials: Material[], options: {
  maxInputTokens: number; maxInputBytes: number; blobBytes: (handle: string) => number | null;
  reservedBytes?: number;
  internImage?: (bytes: Uint8Array, mime: string) => BlobRef;
  maxBackgroundTokens: number; system: ContextRecord[]; guide: string; state: string; background: string; reviewFeedback?: boolean;
}): { messages: ContextRecord[]; materialIds: string[]; included: string[]; omitted: string[]; unreadImages: UnreadMaterialImages[]; archivedImages: UnreadMaterialImages[]; inputTokens: number; inputBytes: number; backgroundTokens: number; stateTokens: number } {
  const sizes = new Map<string, number | null>();
  const blobBytes = (handle: string): number | null => {
    if (!sizes.has(handle)) sizes.set(handle, options.blobBytes(handle));
    return sizes.get(handle)!;
  };
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
  const system = materialReferences({ id: 'prefix', createdAtMs: 0, completedAtMs: null, records: options.system }, options.internImage).records;
  const fixed = [...system, guide];
  if (estimateMessagesTokens(fixed) > options.maxInputTokens) throw new DreamInputBudgetError('Dream prefix and guide exceed the initial input budget; materials retained. Increase the budget or reduce the prefix.');
  let usedBytes = inputBytes(fixed, blobBytes).bytes + (options.reservedBytes ?? 0);
  if (usedBytes > options.maxInputBytes) throw new DreamInputBudgetError('Dream prefix, guide and tool schemas exceed the initial byte budget; materials retained. Increase dream.maxInputBytes or reduce the prefix or tool schemas.');
  const selected: Material[] = [];
  const pagedMaterials: string[] = [];
  const unreadImages: UnreadMaterialImages[] = [];
  const materialBudget = options.maxInputBytes - usedBytes;
  const fixedBytes = usedBytes;
  const fixedTokens = estimateMessagesTokens(fixed);
  let used = fixedTokens;
  const materialTokens = options.maxInputTokens - used;
  for (const material of materials) {
    const label = message('user', `Material ${material.id}`);
    const prepared = materialReferences(material, options.internImage);
    const records = [label, ...prepared.records];
    const size = estimateMessagesTokens(records);
    const payload = inputBytes(records, blobBytes);
    if (prepared.images.length && (size > materialTokens || payload.bytes > materialBudget)) {
      pagedMaterials.push(material.id);
      unreadImages.push({ id: material.id, images: prepared.images });
      continue;
    }
    if ((used + size > options.maxInputTokens || usedBytes + payload.bytes > options.maxInputBytes)
      && selected.length && selected.every(item => unreadImages.some(entry => entry.id === item.id))) {
      pagedMaterials.push(...selected.map(item => item.id));
      selected.length = 0;
      used = fixedTokens;
      usedBytes = fixedBytes;
    }
    if (used + size > options.maxInputTokens || usedBytes + payload.bytes > options.maxInputBytes) {
      if (!selected.length && payload.images) throw new DreamInputBudgetError(`Dream image material ${material.id} exceeds the initial token or byte budget (${payload.bytes} material bytes, ${options.maxInputBytes} byte limit); materials retained. Increase dream.maxInputTokens or dream.maxInputBytes, or reduce the image material.`);
      if (!selected.length) pagedMaterials.push(material.id);
      break;
    }
    selected.push({ ...material, records: prepared.records });
    if (prepared.images.length) unreadImages.push({ id: material.id, images: prepared.images });
    used += size;
    usedBytes += payload.bytes;
  }
  const included = selected.map((material) => material.id);
  const active = new Set([...included, ...pagedMaterials]);
  const materialIds = active.size ? materials.filter(material => active.has(material.id)).map(material => material.id) : materials.slice(0, 1).map((material) => material.id);
  const omitted = materials.filter((material) => !included.includes(material.id)).map((material) => material.id);
  const messages = [...system, ...selected.flatMap((material) => [message('user', `Material ${material.id}`), ...material.records]), guide];
  const archivedImages = materials.filter(material => materialIds.includes(material.id) && material.archivedImages?.length).map(material => ({ id: material.id, images: material.archivedImages! }));
  return { messages, materialIds, included, omitted, unreadImages, archivedImages, inputTokens: estimateMessagesTokens(messages), inputBytes: usedBytes, backgroundTokens: estimateTokens(background), stateTokens: estimateTokens(options.state) };
}
