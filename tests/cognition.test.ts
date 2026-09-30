import { expect, it } from 'vitest';
import { decideFrame, StateRefresh, type FrameRule } from '../persona/cognition.ts';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoreApi, EventEnvelope } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { composeDefaults } from '../index.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { Appraiser } from '../persona/appraisal.ts';
import { PERSONA_DEFAULTS } from '../persona/config.ts';

it('white overrides black, with AND conditions and default trigger', () => {
  const black: FrameRule = { id: 'b', label: 'group', enabled: true, match: { world: 'chat', sceneKind: 'group' } };
  const white: FrameRule = { id: 'w', label: 'sender', enabled: true, match: { world: 'chat', senderKey: 'alice' } };
  const event = { world: 'chat', eventType: 'chat.message', sceneKind: 'group', sceneKey: 'chat:group:1', senderKey: 'alice' };
  expect(decideFrame(event, { blacklist: [black], whitelist: [white] })).toMatchObject({ trigger: true, reason: 'whitelist', ruleId: 'w' });
  expect(decideFrame({ ...event, senderKey: 'bob' }, { blacklist: [black], whitelist: [white] })).toMatchObject({ trigger: false });
  expect(decideFrame({ ...event, world: 'other' }, { blacklist: [black], whitelist: [white] })).toMatchObject({ trigger: true, reason: 'default' });
});

it('appraises each eligible scene with its full batch and refreshes STATE independently of blocked frames', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cognition-scenes-'));
  try {
    const cfg = composeDefaults(); cfg.appraisal!.provider = 'laya';
    cfg.cognition = { stateReminderBatches: 10, blacklist: [{ id: 'all', label: 'all', enabled: true, match: {} }],
      whitelist: [{ id: 'a', label: 'allowed', enabled: true, match: { senderKey: 'a' } }] };
    const requests: string[] = [], injected: string[] = [];
    const appraiser = new Appraiser(cfg.appraisal!, { loadLaya: async () => ({
      systemOne: async (input) => { requests.push((input as { message: string }).message); return { answers: { initiative: { noul: 0.5 }, topicPersistence: { noul: 0.5 }, playfulness: { noul: 0.5 } } }; }, close: async () => {},
    }) });
    const persona = new ContinuityPersona({ cfg, memoryDir: dir, appraiser });
    persona.attach({ injectInternal: (text: string) => injected.push(text), log: nullLogger(), timers: { onDue() {}, list: () => [] }, deliveryGate: { isBlocked: () => false } } as unknown as CoreApi);
    const event = (cursor: number, scene: string, senderKey: string): EventEnvelope => ({ cursor, source: 'chat', type: 'chat.message', origin: 'external', senderKey,
      ts: new Date(100000 + cursor * 1000).toISOString(), text: senderKey + cursor, meta: { conv: { kind: 'group', id: scene } } } as EventEnvelope);
    await persona.onDelivery({ events: [event(1, 'earlier', 'a'), event(2, 'earlier', 'b'), event(3, 'later', 'a')] });
    expect(requests.map((request) => JSON.parse(request).scene)).toEqual(['chat:group:earlier', 'chat:group:later']);
    expect(JSON.parse(requests[0]!).current).toHaveLength(2);
    expect(injected.filter((text) => text.startsWith('[system/cognitive-frame]'))).toHaveLength(2);
    expect(injected.filter((text) => text.startsWith('[system/cognitive-frame]')).join('\n')).not.toContain('Continuity note:');
    for (let cursor = 4; cursor <= 13; cursor++) await persona.onDelivery({ events: [event(cursor, 'blocked', 'b')] });
    expect(requests).toHaveLength(2);
    expect(injected.filter((text) => text.startsWith('[system/continuity-state]'))).toHaveLength(2);
    writeFileSync(join(dir, 'state', 'STATE.md'), 'changed by dream');
    await persona.onDelivery({ events: [event(14, 'blocked', 'b')] });
    expect(injected.at(-1)).toContain('changed by dream');
    expect(JSON.parse(readFileSync(join(dir, 'state', 'runtime.json'), 'utf8')).lastExternalCursor).toBe(14);
    await persona.dispose();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('rejects an invalid page draft without applying any values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cognition-draft-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    const cfg = composeDefaults(); const persona = new ContinuityPersona({ cfg, memoryDir: dir, deploymentDir: dir });
    const invoke = persona.console().invoke!;
    await expect(invoke('cognition', 'saveDraft', [{ 'appraisal.provider': 'jev', 'cognition.blacklist': [{ id: 'broken' }] }])).rejects.toThrow();
    expect(cfg.appraisal!.provider).toBe(PERSONA_DEFAULTS.appraisal.provider); expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{}');
    await invoke('cognition', 'saveDraft', [{ 'appraisal.provider': 'jev', 'cognition.blacklist': [{ id: 'b', label: 'quiet', enabled: true, match: { world: 'chat' } }] }]);
    expect(cfg.cognition!.blacklist).toHaveLength(1); expect(cfg.appraisal!.provider).toBe('jev');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('STATE changes reset the ten-delivery reminder and session reset forces refresh', () => {
  const refresh = new StateRefresh();
  expect(refresh.next('a', 10)).toBe(true);
  for (let i = 0; i < 9; i++) expect(refresh.next('a', 10)).toBe(false);
  expect(refresh.next('a', 10)).toBe(true);
  expect(refresh.next('b', 10)).toBe(true);
  refresh.reset();
  expect(refresh.next('b', 0)).toBe(true);
  expect(refresh.next('b', 0)).toBe(false);
});
