import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterState, PARTICIPATION_COOLDOWN, type StateEvent } from '../persona/character-state.ts';

function external(cursor: number, senderKey: string, ts: string): StateEvent {
  return { cursor, senderKey, source: 'QQ', ts };
}

function personState(dir: string, key: string): { interactionMomentum: number; relationshipEnergy: number } {
  return JSON.parse(readFileSync(join(dir, 'state', 'runtime.json'), 'utf8')).people[key];
}

function tendencyGuidance(frame: string, name: string): string {
  const match = new RegExp(`- ${name}: ([^\\n]+)`).exec(frame);
  if (!match) throw new Error(`Missing ${name} tendency in frame: ${frame}`);
  return match[1];
}

describe('CharacterState', () => {
  it('shares one person heat across contexts and isolates another person', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-'));
    try {
      const state = new CharacterState(dir, () => 0.25);
      state.recordExternalBatch([external(7, 'QQ.100', '2026-09-20T10:00:00.000Z')]);
      const group = personState(dir, 'QQ:QQ.100');
      const privateMessage = state.recordExternalBatch([external(8, 'QQ.100', '2026-09-20T10:01:00.000Z')]);
      const current = personState(dir, 'QQ:QQ.100');
      state.recordExternalBatch([external(9, 'QQ.200', '2026-09-20T10:02:00.000Z')]);
      const anotherPerson = personState(dir, 'QQ:QQ.200');

      expect(privateMessage.changed).toBe(true);
      expect(current.interactionMomentum).toBeGreaterThan(group.interactionMomentum);
      expect(anotherPerson.interactionMomentum).toBe(group.interactionMomentum);
      expect(state.lastExternalCursor()).toBe(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the current person state when a senderless derived event arrives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-derived-'));
    try {
      const state = new CharacterState(dir, () => 0.25);
      let frame = '';
      for (let cursor = 1; cursor <= 9; cursor++) {
        frame = state.recordExternalBatch([external(cursor, 'QQ.100', `2026-09-20T10:00:0${cursor}.000Z`)]).frame;
      }
      const derived = state.recordExternalBatch([{
        cursor: 10,
        source: 'QQ',
        ts: '2026-09-20T10:00:10.000Z',
      }]);
      const runtime = JSON.parse(readFileSync(join(dir, 'state', 'runtime.json'), 'utf8'));

      expect(derived.frame).toBe(frame);
      expect(state.lastExternalCursor()).toBe(10);
      expect(runtime.lastPersonKey).toBe('QQ:QQ.100');
      expect(runtime.people['event:10']).toBeUndefined();
      expect(new CharacterState(dir, () => 0.99).frameForCurrentState()).toBe(frame);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps relationship energy with its sender and lets heat approach one without a hard ceiling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-energy-'));
    try {
      const state = new CharacterState(dir, () => 0.25);
      for (let cursor = 1; cursor <= 9; cursor++) state.recordExternalBatch([external(cursor, 'QQ.100', `2026-09-20T10:00:0${cursor}.000Z`)]);
      state.recordExternalBatch([external(10, 'QQ.200', '2026-09-20T10:00:10.000Z')]);

      const runtime = JSON.parse(readFileSync(join(dir, 'state', 'runtime.json'), 'utf8'));
      expect(runtime.version).toBe(4);
      expect(runtime.people['QQ:QQ.100'].interactionMomentum).toBeGreaterThan(0.75);
      expect(runtime.people['QQ:QQ.100'].interactionMomentum).toBeLessThan(1);
      expect(runtime.people['QQ:QQ.100'].relationshipEnergy).toBeGreaterThan(runtime.people['QQ:QQ.200'].relationshipEnergy);
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
      expect(JSON.parse(readFileSync(join(dir, 'state', 'runtime.json'), 'utf8')).version).toBe(4);
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
      expect(update.frame).toContain('Continuity note:');
      expect(update.frame).toContain('participation:');
      expect(update.frame).not.toContain('Mechanical state:');
      expect(update.frame).not.toContain('Behavior tendencies:');
      expect(update.frame).not.toMatch(/\d+\.\d+/);
      expect(update.frame).toContain('自行决定是否参与；参与时参考以下表达倾向。');
      expect(update.frame).not.toContain('soft, not obligations');
      expect(first.recordExternalBatch([external(8, 'QQ.100', '2026-09-20T10:01:00.000Z')]).changed).toBe(false);

      const afterRestart = new CharacterState(dir, () => 0.99);
      expect(afterRestart.lastExternalCursor()).toBe(8);
      expect(afterRestart.frameForCurrentState()).toBe(update.frame);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses model expression scores while keeping mechanical relationship energy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-appraisal-'));
    try {
      const state = new CharacterState(dir, () => 0.25);
      state.recordExternalBatch([external(7, 'QQ.100', '2026-09-20T10:00:00.000Z')]);
      const mechanical = state.frameForCurrentState();
      const appraised = state.frameForCurrentState({
        source: 'laya', confidence: 0.7, participation: 0.2, initiative: 0.2, topicPersistence: 0.3, playfulness: 0.4,
        warmth: 0.99, selfDisclosure: 0.99, restraint: 0.99,
      });

      expect(tendencyGuidance(appraised, 'person relationship energy')).toBe(tendencyGuidance(mechanical, 'person relationship energy'));
      for (const name of ['warmth', 'self-disclosure', 'restraint']) {
        expect(tendencyGuidance(appraised, name)).toMatch(/^high;/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates v2 state without treating global energy as relationship history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-v2-migration-'));
    try {
      mkdirSync(join(dir, 'state'));
      writeFileSync(join(dir, 'state', 'runtime.json'), JSON.stringify({
        version: 2,
        lastExternalCursor: 8,
        updatedAt: '2026-09-20T09:00:00.000Z',
        seed: 4,
        socialEnergy: 0.63,
        people: {
          'QQ:QQ.100': { updatedAt: '2026-09-20T09:00:00.000Z', seed: 9, interactionMomentum: 0.5 },
        },
        lastPersonKey: 'QQ:QQ.100',
      }), 'utf8');

      const state = new CharacterState(dir, () => 0.25);
      const runtime = JSON.parse(readFileSync(join(dir, 'state', 'runtime.json'), 'utf8'));

      expect(state.lastExternalCursor()).toBe(8);
      expect(readFileSync(join(dir, 'state', 'runtime.v2.json'), 'utf8')).toContain('"version":2');
      expect(runtime).toMatchObject({
        version: 4,
        people: { 'QQ:QQ.100': { seed: 9, interactionMomentum: 0.5, relationshipEnergy: 0 } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('archives v3 and separates known QQ people from dungeon scenes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-state-v3-'));
    try {
      mkdirSync(join(dir, 'state'));
      const prior = { updatedAt: '2026-09-28T00:00:00Z', seed: 9, interactionMomentum: 0.5, relationshipEnergy: 0.6 };
      writeFileSync(join(dir, 'state', 'runtime.json'), JSON.stringify({
        version: 3, lastExternalCursor: 90, updatedAt: prior.updatedAt, seed: 4,
        people: { 'qq:123': prior, 'dungeon:dungeon.plaza': prior, 'event:42': prior },
        lastPersonKey: 'dungeon:dungeon.plaza',
      }), 'utf8');
      const state = new CharacterState(dir);
      const runtime = JSON.parse(readFileSync(join(dir, 'state', 'runtime.json'), 'utf8'));
      expect(state.lastExternalCursor()).toBe(90);
      expect(runtime.people['qq:private:123']).toEqual(prior);
      expect(runtime.scenes['dungeon:scene:dungeon.plaza']).toEqual(prior);
      expect(runtime.people['event:42']).toBeUndefined();
      expect(runtime.lastKind).toBeNull();
      expect(readFileSync(join(dir, 'state', 'runtime.v3.json'), 'utf8')).toContain('event:42');
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


describe('participation cooldown', () => {
  it('recovers its deficit over two-hour half-lives, resets on speech and fully recovers at six hours after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-cooldown-'));
    try {
      const state = new CharacterState(dir, () => 0.25);
      const scene = 'chat:group:one';
      state.recordParticipation(scene, '2026-10-31T00:00:00Z');
      const initial = PARTICIPATION_COOLDOWN.factor;
      expect(state.participationMultiplier(scene, '2026-10-31T00:00:00Z')).toBe(initial);
      expect(state.participationMultiplier(scene, '2026-10-31T02:00:00Z')).toBeCloseTo(1 - (1 - initial) / 2);
      state.recordParticipation(scene, '2026-10-31T02:00:00Z');
      const reduced = (1 - (1 - initial) / 2) * initial;
      const restored = new CharacterState(dir);
      expect(restored.participationMultiplier(scene, '2026-10-31T02:00:00Z')).toBeCloseTo(reduced);
      expect(restored.participationMultiplier(scene, '2026-10-31T04:00:00Z')).toBeCloseTo(1 - (1 - reduced) / 2);
      expect(restored.participationMultiplier(scene, '2026-10-31T07:59:59Z')).toBeLessThan(1);
      expect(restored.participationMultiplier(scene, '2026-10-31T08:00:00Z')).toBe(1);
      expect(restored.participationMultiplier('chat:group:two')).toBe(1);
      state.recordParticipation('chat:channel:one', '2026-10-31T00:00:00Z');
      expect(state.participationMultiplier('chat:channel:one', '2026-10-31T00:00:00Z')).toBe(initial);
      state.recordParticipation('chat:private:one');
      state.recordParticipation('dungeon:scene:one');
      expect(state.participationMultiplier('chat:private:one')).toBe(1);
      expect(state.participationMultiplier('dungeon:scene:one')).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('changes only participation and leaves incoming-message heat and relationship energy independent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-cooldown-frame-'));
    try {
      const state = new CharacterState(dir, () => 0.25);
      const scene = { key: 'chat:group:one', kind: 'scene' as const };
      const at = '2026-10-31T00:00:00Z';
      const appraisal = { source: 'laya' as const, confidence: 0.7, participation: 0.7, initiative: 0.9,
        topicPersistence: 0.9, playfulness: 0.9, warmth: 0.9, selfDisclosure: 0.9, restraint: 0.9 };
      state.recordExternalBatch([{ cursor: 1, ts: at, senderKey: 'a', sceneKey: scene.key, sceneKind: scene.kind }]);
      const before = state.frameForCurrentState(appraisal, scene, false, at);
      const background = state.mechanicalCategories(scene);
      state.recordParticipation(scene.key, at);
      const after = state.frameForCurrentState(appraisal, scene, false, at);
      expect(tendencyGuidance(before, 'participation')).toMatch(/^high;/);
      expect(tendencyGuidance(after, 'participation')).toMatch(/^medium;/);
      for (const dimension of ['initiative', 'topic persistence', 'warmth', 'playfulness', 'self-disclosure', 'restraint']) {
        expect(tendencyGuidance(after, dimension)).toBe(tendencyGuidance(before, dimension));
      }
      expect(state.mechanicalCategories(scene)).toEqual(background);
      state.recordExternalBatch([{ cursor: 2, ts: at, senderKey: 'b', sceneKey: scene.key, sceneKind: scene.kind }]);
      expect(state.participationMultiplier(scene.key, at)).toBe(PARTICIPATION_COOLDOWN.factor);
      expect(state.mechanicalCategories(scene)).not.toHaveProperty('warmth');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('decays relationship energy across the full month of silence and reads additive cooldown fields from old runtime files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-full-decay-'));
    try {
      const state = new CharacterState(dir, () => 0.25);
      state.recordExternalBatch(Array.from({ length: 100 }, (_, index) => external(index + 1, 'a', '2026-10-01T00:00:00Z')));
      expect(personState(dir, 'QQ:a').relationshipEnergy).toBeGreaterThan(0.67);
      expect(new CharacterState(dir).participationMultiplier('chat:group:one')).toBe(1);
      state.recordExternalBatch([external(101, 'a', '2026-10-31T00:00:00Z')]);
      const current = personState(dir, 'QQ:a');
      expect(current.relationshipEnergy).toBeLessThan(0.33);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
