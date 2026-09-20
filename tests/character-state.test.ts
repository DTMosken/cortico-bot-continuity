import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterState, type StateEvent } from '../persona/character-state.ts';

function external(cursor: number, senderKey: string, ts: string): StateEvent {
  return { cursor, senderKey, source: 'QQ', ts };
}

function personHeat(frame: string): number {
  const match = /person interaction heat (\d+\.\d+)/.exec(frame);
  if (!match) throw new Error(`Missing person heat in frame: ${frame}`);
  return Number(match[1]);
}

describe('CharacterState', () => {
  it('shares one person heat across contexts and isolates another person', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-'));
    try {
      const state = new CharacterState(dir, () => 0.25);
      const group = state.recordExternalBatch([external(7, 'QQ.100', '2026-09-20T10:00:00.000Z')]);
      const privateMessage = state.recordExternalBatch([external(8, 'QQ.100', '2026-09-20T10:01:00.000Z')]);
      const anotherPerson = state.recordExternalBatch([external(9, 'QQ.200', '2026-09-20T10:02:00.000Z')]);

      expect(privateMessage.changed).toBe(true);
      expect(personHeat(privateMessage.frame)).toBeGreaterThan(personHeat(group.frame));
      expect(personHeat(anotherPerson.frame)).toBe(personHeat(group.frame));
      expect(state.lastExternalCursor()).toBe(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps shared energy in a narrow range under high multi-person traffic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-energy-'));
    try {
      const state = new CharacterState(dir, () => 0.25);
      for (let cursor = 1; cursor <= 40; cursor++) {
        state.recordExternalBatch([external(cursor, `QQ.${cursor}`, `2026-09-20T10:${String(cursor).padStart(2, '0')}:00.000Z`)]);
      }

      const runtime = JSON.parse(readFileSync(join(dir, 'state', 'runtime.json'), 'utf8'));
      expect(runtime.version).toBe(2);
      expect(runtime.socialEnergy).toBeGreaterThanOrEqual(0.55);
      expect(runtime.socialEnergy).toBeLessThanOrEqual(0.65);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('archives v1 state, preserves its cursor, and rebuilds global semantic state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-migration-'));
    try {
      mkdirSync(join(dir, 'state'));
      writeFileSync(join(dir, 'state', 'runtime.json'), JSON.stringify({
        version: 1,
        lastExternalCursor: 8,
        updatedAt: '2026-09-20T09:00:00.000Z',
        seed: 4,
        socialEnergy: 0,
        interactionMomentum: 1,
      }), 'utf8');
      writeFileSync(join(dir, 'state', 'STATE.md'), '# Current continuity\n\nA private relationship summary.\n', 'utf8');

      const state = new CharacterState(dir, () => 0.25);

      expect(state.lastExternalCursor()).toBe(8);
      expect(state.recordExternalBatch([external(8, 'QQ.100', '2026-09-20T10:00:00.000Z')]).changed).toBe(false);
      expect(readFileSync(join(dir, 'state', 'runtime.v1.json'), 'utf8')).toContain('"version":1');
      expect(readFileSync(join(dir, 'state', 'STATE.v1.md'), 'utf8')).toContain('private relationship summary');
      expect(state.semanticState()).not.toContain('private relationship summary');
      expect(JSON.parse(readFileSync(join(dir, 'state', 'runtime.json'), 'utf8')).version).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists a batch once and derives the same behavior frame after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-restart-'));
    try {
      const first = new CharacterState(dir, () => 0.25);
      const update = first.recordExternalBatch([
        external(7, 'QQ.100', '2026-09-20T10:00:00.000Z'),
        external(8, 'QQ.100', '2026-09-20T10:01:00.000Z'),
      ]);
      expect(update.changed).toBe(true);
      expect(update.frame).toContain('initiative:');
      expect(first.recordExternalBatch([external(8, 'QQ.100', '2026-09-20T10:01:00.000Z')]).changed).toBe(false);

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
      state.recordExternalBatch([external(4, 'QQ.100', '2026-09-20T10:00:00.000Z')]);

      expect(existsSync(join(dir, 'state', 'runtime.json'))).toBe(true);
      expect(readdirSync(join(dir, 'state')).some((name) => name.endsWith('.tmp'))).toBe(false);
      expect(state.lastExternalCursor()).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
