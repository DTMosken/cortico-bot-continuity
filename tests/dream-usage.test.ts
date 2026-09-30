import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDreamUsage, usageOffset } from '../persona/subconscious/usage.ts';

it('counts retry attempts separately from logical rounds and leaves missing meters unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-usage-'));
  try {
    const row = (generationId: string, input: number | null, role = 'dream') => JSON.stringify({ role, attempt: {
      generationId, startedAt: '2026-09-30T00:00:00Z', meters: { input, cachedInput: input === null ? null : 80, output: input === null ? null : 10 },
    } });
    writeFileSync(join(dir, 'usage.jsonl'), [row('first', 100), row('first', null), row('second', 100), row('main', 100, 'main')].join('\n'));
    expect(readDreamUsage(dir, Date.parse('2026-09-29T23:59:59Z'), Date.parse('2026-09-30T00:00:01Z'))).toEqual({
      rounds: 2, attempts: 3, input: null, cachedInput: null, output: null,
    });
    expect(readDreamUsage(dir, 0, Date.now(), usageOffset(dir))).toMatchObject({ rounds: null, attempts: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
