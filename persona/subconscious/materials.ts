/** Durable original records remain readable until dream explicitly confirms completion. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { estimateMessagesTokens, estimateTokens } from 'cortico/core/util.ts';

export interface Material { id: string; createdAtMs: number; completedAtMs: number | null; records: ContextRecord[]; archivedImages?: UnreadImage[] }
export interface UnreadImage { handle?: string; recordIndex: number; partIndex?: number; }
export interface UnreadMaterialImages { id: string; images: UnreadImage[]; }
type MaterialIndex = Omit<Material, 'records'> & { textCompletedAtMs?: number; deferredImages?: Array<UnreadImage & { extraDreamUsed: boolean }> };

function sameImage(a: UnreadImage, b: UnreadImage): boolean {
  return a.handle === b.handle && a.recordIndex === b.recordIndex && a.partIndex === b.partIndex;
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
    return this.active().map((item) => ({ ...structuredClone(item), records: this.records(item.id) }));
  }
  pendingCount(): number { return this.active().length; }
  archivedUnreadCount(): number { return this.index.filter(item => item.archivedImages?.length).length; }
  /** One call per independent handoff/continuation, before its batches and retries. */
  beginDream(knownUnread: UnreadMaterialImages[] = []): void {
    let changed = this.retainUnread(knownUnread);
    for (const item of this.active()) {
      if (!item.deferredImages?.length) continue;
      const retained: NonNullable<MaterialIndex['deferredImages']> = [];
      for (const image of item.deferredImages) {
        if (image.extraDreamUsed) {
          const { extraDreamUsed: _used, ...reference } = image;
          (item.archivedImages ??= []).push(reference);
        } else retained.push({ ...image, extraDreamUsed: true });
      }
      if (retained.length) item.deferredImages = retained;
      else delete item.deferredImages;
      changed = true;
    }
    if (changed) this.save();
  }
  recordUnread(unread: UnreadMaterialImages[]): void { if (this.retainUnread(unread)) this.save(); }
  private retainUnread(unread: UnreadMaterialImages[]): boolean {
    let changed = false;
    for (const entry of unread) {
      const item = this.active().find(item => item.id === entry.id);
      if (!item) continue;
      for (const image of entry.images) {
        if (item.archivedImages?.some(archived => sameImage(image, archived)) || item.deferredImages?.some(retained => sameImage(image, retained))) continue;
        (item.deferredImages ??= []).push({ ...image, extraDreamUsed: false });
        changed = true;
      }
    }
    return changed;
  }
  private active(): MaterialIndex[] { return this.index.filter(item => item.completedAtMs === null && item.textCompletedAtMs === undefined); }
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

/** Oversized image payloads are removed only from this input copy; originals stay in raw materials. */
function fitMaterialImages(material: Material, maxBytes: number, blobBytes: (handle: string) => number | null): { records: ContextRecord[]; images: UnreadImage[] } {
  const archived = material.archivedImages ?? [];
  if (!archived.length && inputBytes(material.records, blobBytes).bytes <= maxBytes) return { records: material.records, images: [] };
  const records = structuredClone(material.records);
  const candidates = new Map<string, { bytes: number; images: UnreadImage[]; remove: Array<() => void> }>();
  const add = (key: string, bytes: number, image: UnreadImage, remove: () => void) => {
    const candidate = candidates.get(key) ?? { bytes: 0, images: [], remove: [] };
    candidate.bytes += bytes; candidate.images.push(image); candidate.remove.push(remove);
    candidates.set(key, candidate);
  };
  records.forEach((record, recordIndex) => {
    const item = record.item;
    if (item.type !== 'message' && item.type !== 'function_call_output') return;
    for (const ref of record.context.blobs ?? []) {
      if (!ref.mime.startsWith('image/')) continue;
      const reference = { handle: ref.handle, recordIndex };
      const size = archived.some(image => sameImage(image, reference)) ? 0 : blobBytes(ref.handle);
      if (size === null) continue;
      add(ref.handle, 4 * Math.ceil(size / 3), { handle: ref.handle, recordIndex }, () => {
        record.context.blobs = record.context.blobs!.filter(blob => blob !== ref);
      });
    }
    const content = item.type === 'message' ? item.content : item.output;
    if (!Array.isArray(content)) return;
    content.forEach((part, partIndex) => {
      if (part.type !== 'input_image') return;
      add(part.image_url ?? `${recordIndex}:${partIndex}`, Buffer.byteLength(JSON.stringify(part)), { recordIndex, partIndex }, () => {
        for (let index = content.length - 1; index >= 0; index--) if (content[index] === part) content.splice(index, 1);
      });
    });
  });
  for (const [key, candidate] of candidates) if (candidate.images.some(image => archived.some(reference => sameImage(image, reference)))) {
    for (const remove of candidate.remove) remove();
    candidates.delete(key);
  }
  const images: UnreadImage[] = [];
  const withNotices = (): ContextRecord[] => {
    const notices = [
      ...archived.map(image => `[image archived unread] Original image retained in material ${material.id}, record ${image.recordIndex}${image.partIndex === undefined ? '' : `, part ${image.partIndex}`}${image.handle ? `; handle ${image.handle}` : ''}. Its one extra independent dream has elapsed. This image stays unread and is excluded from automatic input; confirmation covers only the remaining material.`),
      ...images.map(image => `[image not read] Image omitted from this dream input to fit the byte budget. Original retained in material ${material.id}, record ${image.recordIndex}${image.partIndex === undefined ? '' : `, part ${image.partIndex}`}${image.handle ? `; handle ${image.handle}` : ''}. This material must remain unprocessed.`),
    ];
    return notices.length ? [...records, message('user', notices.join('\n'))] : records;
  };
  let view = withNotices();
  if (inputBytes(view, blobBytes).bytes <= maxBytes) return { records: view, images };
  for (const candidate of [...candidates.values()].sort((a, b) => b.bytes - a.bytes)) {
    for (const remove of candidate.remove) remove();
    images.push(...candidate.images);
    view = withNotices();
    if (inputBytes(view, blobBytes).bytes <= maxBytes) break;
  }
  return { records: view, images };
}

/** Byte budget includes reserved tool schemas; excludes provider-specific request fields. */
export function prepareDreamInput(materials: Material[], options: {
  maxInputTokens: number; maxInputBytes: number; blobBytes: (handle: string) => number | null;
  reservedBytes?: number;
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
  const fixed = [...options.system, guide];
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
    const prepared = fitMaterialImages(material, materialBudget - inputBytes([label], blobBytes).bytes, blobBytes);
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
  const messages = [...options.system, ...selected.flatMap((material) => [message('user', `Material ${material.id}`), ...material.records]), guide];
  const archivedImages = materials.filter(material => materialIds.includes(material.id) && material.archivedImages?.length).map(material => ({ id: material.id, images: material.archivedImages! }));
  return { messages, materialIds, included, omitted, unreadImages, archivedImages, inputTokens: estimateMessagesTokens(messages), inputBytes: usedBytes, backgroundTokens: estimateTokens(background), stateTokens: estimateTokens(options.state) };
}
