import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterState } from '../persona/character-state.ts';

describe('CharacterState', () => {
  it('persists a batch once and derives the same behavior frame after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-'));
    try {
      const first = new CharacterState(dir, () => 0.25);
      const update = first.recordExternalBatch([
        { cursor: 7, ts: '2026-09-20T10:00:00.000Z' },
        { cursor: 8, ts: '2026-09-20T10:01:00.000Z' },
      ]);
      expect(update.changed).toBe(true);
      expect(update.frame).toContain('initiative:');
      expect(first.recordExternalBatch([{ cursor: 8, ts: '2026-09-20T10:01:00.000Z' }]).changed).toBe(false);

      const afterRestart = new CharacterState(dir, () => 0.99);
      expect(afterRestart.lastExternalCursor()).toBe(8);
      expect(afterRestart.frameForCurrentState()).toBe(update.frame);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers from a corrupt runtime file and leaves no partial atomic write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-corrupt-'));
    try {
      mkdirSync(join(dir, 'state'));
      writeFileSync(join(dir, 'state', 'runtime.json'), '{not json', 'utf8');

      const state = new CharacterState(dir, () => 0.5);
      expect(state.lastExternalCursor()).toBe(0);
      state.recordExternalBatch([{ cursor: 4, ts: '2026-09-20T10:00:00.000Z' }]);

      expect(existsSync(join(dir, 'state', 'runtime.json'))).toBe(true);
      expect(readdirSync(join(dir, 'state')).some((name) => name.endsWith('.tmp'))).toBe(false);
      expect(state.lastExternalCursor()).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
