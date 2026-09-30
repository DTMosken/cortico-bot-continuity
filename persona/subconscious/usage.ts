/** Upstream attempt meters are distinct from initial input estimates and billing. */
import { openSync, closeSync, readSync, fstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
export interface DreamUsage { rounds: number | null; attempts: number | null; input: number | null; cachedInput: number | null; output: number | null }
export function usageOffset(dataDir?: string): number {
  try { return dataDir ? statSync(join(dataDir, 'usage.jsonl')).size : 0; } catch { return 0; }
}
export function readDreamUsage(dataDir: string | undefined, started: number, ended: number, offset = 0): DreamUsage {
  const unknown: DreamUsage = { rounds: null, attempts: null, input: null, cachedInput: null, output: null };
  if (!dataDir) return unknown;
  try {
    const handle = openSync(join(dataDir, 'usage.jsonl'), 'r');
    let content: string;
    try {
      const size = fstatSync(handle).size;
      const start = size >= offset ? offset : 0;
      const buffer = Buffer.alloc(size - start);
      readSync(handle, buffer, 0, buffer.length, start);
      content = buffer.toString('utf8');
    } finally { closeSync(handle); }
    const rows = content.split('\n').flatMap((line) => {
      try { const row = JSON.parse(line); const time = Date.parse(row.attempt?.startedAt ?? row.ts);
        return row.role === 'dream' && time >= started && time <= ended ? [row] : []; } catch { return []; }
    });
    if (!rows.length) return unknown;
    const sum = (key: string): number | null => rows.every((row) => typeof row.attempt?.meters?.[key] === 'number')
      ? rows.reduce((total, row) => total + row.attempt.meters[key], 0) : null;
    return { rounds: rows.every((row) => typeof row.attempt?.generationId === 'string') ? new Set(rows.map((row) => row.attempt.generationId)).size : null,
      attempts: rows.length, input: sum('input'), cachedInput: sum('cachedInput'), output: sum('output') };
  } catch { return unknown; }
}
