import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppraisalHistory, type AppraisalMessage } from '../persona/appraisal-context.ts';

afterEach(() => vi.useRealTimers());

it('removes expired disk history on load and read using wall time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  const dir = mkdtempSync(join(tmpdir(), 'continuity-history-'));
  mkdirSync(join(dir, 'state'));
  const file = join(dir, 'state/appraisal-history.json');
  const item = (ts: string): AppraisalMessage => ({ ts, source: 'chat', type: 'chat.message', speaker: 'a', text: 'hello', role: 'external' });
  try {
    writeFileSync(file, JSON.stringify({ version: 1, scenes: {
      old: [item('2026-10-29T12:00:00Z')], current: [item('2026-10-31T11:00:00Z')],
    } }));
    const history = new AppraisalHistory(dir);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).scenes)).toEqual(['current']);
    // Replayed old messages must not move the retention window backwards.
    history.add('old', [item('2026-10-29T13:00:00Z')]);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).scenes)).toEqual(['current']);
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'));
    expect(history.recent('current')).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8')).scenes).toEqual({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('retains at most twenty messages per scene and two hundred scenes across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'continuity-history-limits-'));
  mkdirSync(join(dir, 'state'));
  const item = (cursor: number): AppraisalMessage => ({ cursor, ts: new Date().toISOString(), source: 'chat', type: 'chat.message', speaker: 'a', text: String(cursor), role: 'external' });
  try {
    writeFileSync(join(dir, 'state/appraisal-history.json'), JSON.stringify({ version: 1,
      scenes: Object.fromEntries(Array.from({ length: 201 }, (_, scene) => [String(scene), Array.from({ length: 25 }, (_, cursor) => item(cursor))])),
    }));
    const history = new AppraisalHistory(dir);
    history.add('new', Array.from({ length: 25 }, (_, cursor) => item(cursor)));
    const state = JSON.parse(readFileSync(join(dir, 'state/appraisal-history.json'), 'utf8'));
    expect(Object.keys(state.scenes)).toHaveLength(200);
    const restored = new AppraisalHistory(dir);
    expect(restored.recent('new').map(item => item.cursor)).toEqual(Array.from({ length: 20 }, (_, i) => i + 5));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
