import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type TaskStatus = 'running' | 'complete' | 'partial' | 'failed' | 'unconfirmed' | 'interrupted';
export interface TaskRecord {
  id: string;
  task: string;
  materials: string[];
  tools: string[];
  status: TaskStatus;
  startedAt: string;
  finishedAt?: string;
  summary: string;
  resultChars: number;
  softRounds: number;
  maxRounds: number;
}

export function charLength(text: string): number { return Array.from(text).length; }
export function charSlice(text: string, offset: number, length: number): string { return Array.from(text).slice(offset, offset + length).join(''); }

export class TaskStore {
  private readonly records = new Map<string, TaskRecord>();
  private readonly results = new Map<string, string>();

  constructor(private readonly dir?: string) {
    if (!dir || !existsSync(dir)) return;
    for (const name of readdirSync(dir).filter(name => /^[0-9a-f-]{36}\.json$/.test(name))) {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as TaskRecord;
      if (record.id + '.json' !== name) throw new Error('Subagent record ID does not match its file: ' + name);
      this.records.set(record.id, record);
      if (record.status === 'running') {
        record.status = 'interrupted'; record.finishedAt = new Date().toISOString();
        record.summary = 'Worker interrupted by process restart; no automatic retry.';
        record.resultChars = charLength(this.result(record.id));
        this.save(record);
      }
    }
  }
  all(): TaskRecord[] { return [...this.records.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)); }
  get(id: string): TaskRecord | undefined { return this.records.get(id); }
  save(record: TaskRecord): void {
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      const path = join(this.dir, record.id + '.json');
      writeFileSync(path + '.tmp', JSON.stringify(record, null, 2) + '\n', 'utf8');
      renameSync(path + '.tmp', path);
    }
    this.records.set(record.id, record);
  }
  result(id: string): string {
    if (!this.records.has(id)) throw new Error('未知任务 ID');
    if (!this.dir) return this.results.get(id) ?? '';
    const file = join(this.dir, id + '.txt');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }
  writeResult(record: TaskRecord, text: string): void {
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      const path = join(this.dir, record.id + '.txt');
      writeFileSync(path + '.tmp', text, 'utf8');
      renameSync(path + '.tmp', path);
    } else this.results.set(record.id, text);
    record.resultChars = charLength(text);
    this.save(record);
  }
}
