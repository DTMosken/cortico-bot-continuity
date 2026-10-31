import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreApi } from 'cortico/core/types.ts';
import { composeDefaults } from '../index.ts';
import { ContinuityPersona } from '../persona/index.ts';

afterEach(() => { vi.useRealTimers(); });

it('does not tick at night when the night interval is 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'continuity-rhythm-'));
  const cfg = composeDefaults();
  cfg.timezone = 'UTC';
  Object.assign(cfg.tick, { nightIntervalMinutes: 0, nightStartHour: 0, nightEndHour: 8 });
  const persona = new ContinuityPersona({ cfg, memoryDir: dir });
  let ticks = 0;
  (persona as unknown as { core: Partial<CoreApi> }).core = { injectDeferred: () => { ticks++; } };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, 3)));
  try {
    persona.startRhythm();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(0);
  } finally {
    persona.stopRhythm();
    vi.useRealTimers();
    await persona.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('gives each config its own loop, memo and tick defaults', () => {
  const first = composeDefaults();
  first.tick.nightIntervalMinutes = 0;
  first.loop.softCap = 1;
  first.memo.residentCap = 1;
  const second = composeDefaults();
  expect(second.tick.nightIntervalMinutes).not.toBe(0);
  expect(second.loop.softCap).not.toBe(1);
  expect(second.memo.residentCap).not.toBe(1);
});
