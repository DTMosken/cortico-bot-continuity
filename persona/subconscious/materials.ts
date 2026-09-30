/** Durable original records remain readable until dream explicitly confirms completion. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { message, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { estimateMessagesTokens, estimateTokens } from 'cortico/core/util.ts';

export interface Material { id: string; createdAtMs: number; completedAtMs: number | null; records: ContextRecord[] }
type MaterialIndex = Omit<Material, 'records'>;

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

/** Local estimate excludes provider tool schema and native serialization overhead. */
export function prepareDreamInput(materials: Material[], options: {
  maxInputTokens: number; maxBackgroundTokens: number; system: ContextRecord[]; guide: string; state: string; background: string;
}): { messages: ContextRecord[]; included: string[]; omitted: string[]; inputTokens: number; backgroundTokens: number; stateTokens: number } {
  const clip = (text: string, tokens: number): string => estimateTokens(text) <= tokens ? text
    : text.slice(0, Math.max(0, Math.floor(text.length * tokens / estimateTokens(text))));
  const background = clip(options.background, options.maxBackgroundTokens);
  const guide = message('user', [options.guide, `[system/continuity-state]\n${options.state}`,
    background ? `Previous handoff background (not new evidence):\n${background}` : '',
    `Original material directory: ${materials.length} unprocessed pieces. Use dream_materials to list all IDs and dream_read_material for bounded ranges.`,
    `Latest IDs: ${materials.slice(-40).map((material) => material.id).join(', ')}. Omitted pieces are unprocessed until you read and consolidate them.`,
  ].filter(Boolean).join('\n\n'));
  const fixed = [...options.system, guide];
  if (estimateMessagesTokens(fixed) > options.maxInputTokens) throw new Error('Dream prefix and guide exceed the initial input budget; materials retained. Increase the budget or reduce the prefix.');
  const selected: Material[] = [];
  let used = estimateMessagesTokens(fixed);
  for (const material of [...materials].reverse()) {
    const size = estimateMessagesTokens(material.records) + estimateMessagesTokens([message('user', `Material ${material.id}`)]);
    if (used + size > options.maxInputTokens) break;
    selected.unshift(material);
    used += size;
  }
  const included = selected.map((material) => material.id);
  const omitted = materials.filter((material) => !included.includes(material.id)).map((material) => material.id);
  const messages = [...options.system, ...selected.flatMap((material) => [message('user', `Material ${material.id}`), ...material.records]), guide];
  return { messages, included, omitted, inputTokens: estimateMessagesTokens(messages), backgroundTokens: estimateTokens(background), stateTokens: estimateTokens(options.state) };
}
