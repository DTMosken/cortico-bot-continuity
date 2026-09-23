import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotDefinition } from 'cortico/bot.ts';
import type { CoreConfig } from 'cortico/core/types.ts';
import type { CoreApi, EventEnvelope } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { dryMountBot } from 'cortico/extensions/dry-mount.ts';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import { HANDOFF_NOTE_TYPE } from '../base/persona/handoffNote.ts';
import definition from '../index.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { Appraiser } from '../persona/appraisal.ts';

describe('continuity bot', () => {
  it('defaults appraisal to local random values and keeps remote processing disabled', () => {
    const cfg = definition.defaults() as unknown as {
      appraisal?: {
        provider: string;
        debugLog: boolean;
        laya: { idleTtlMinutes: number };
        jev: { allowRemoteText: boolean };
      };
    };

    expect(cfg.appraisal).toMatchObject({ provider: 'random', jev: { allowRemoteText: false } });
    expect(cfg.appraisal?.debugLog).toBe(false);
    expect(cfg.appraisal?.laya.idleTtlMinutes).toBe(5);
    cfg.appraisal!.provider = 'laya';
    expect(definition.defaults().appraisal?.provider).toBe('random');
  });

  it('dry-mounts as an independent bot extension', () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'continuity-bot-'));
    try {
      const report = dryMountBot(definition as unknown as BotDefinition<CoreConfig>, {
        scratchDir,
        packageDir: join(import.meta.dirname, '..'),
      });
      expect(report.failures).toEqual([]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('fans output only to available World taps', () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-output-tap-'));
    try {
      const received: unknown[] = [];
      const persona = new ContinuityPersona({
        memoryDir,
        cfg: definition.defaults(),
        worlds: [
          { id: 'offline', tools: () => [], outputTap: () => undefined },
          { id: 'online', tools: () => [], outputTap: () => ({ onEvent: (event: unknown) => received.push(event) }) },
        ] as never[],
      });
      const tap = persona.declareSessions().find((session) => session.id === 'main')!.outputTap;
      const event = { type: 'response.output_text.delta', delta: 'hi' };

      tap!.onEvent(event as never);

      expect(received).toEqual([event]);
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('adds one current cognitive frame without advancing replayed external events', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-'));
    try {
      const injected: string[] = [];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds: [] });
      persona.attach({
        injectInternal: (text: string) => injected.push(text),
        log: nullLogger(),
        timers: { onDue: () => {}, list: () => [] },
        deliveryGate: { isBlocked: () => false },
      } as unknown as CoreApi);
      const event = {
        cursor: 19,
        type: 'terminal.message',
        ts: '2026-09-20T10:00:00.000Z',
        source: 'terminal',
        origin: 'external',
        text: 'hello',
      } as EventEnvelope;

      await persona.onDelivery({ events: [event] });
      const firstFrame = injected.find((text) => text.includes('[system/cognitive-frame]'));
      await persona.onDelivery({ events: [event] });
      const frames = injected.filter((text) => text.includes('[system/cognitive-frame]'));

      expect(firstFrame).toBeTruthy();
      expect(frames).toEqual([firstFrame, firstFrame]);
      expect(JSON.parse(readFileSync(join(memoryDir, 'state', 'runtime.json'), 'utf8')).lastExternalCursor).toBe(19);
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('returns a delivery promise for an external message', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-delivery-'));
    try {
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds: [] });
      persona.attach({
        injectInternal: () => undefined,
        log: nullLogger(),
        timers: { onDue: () => {}, list: () => [] },
        deliveryGate: { isBlocked: () => false },
      } as unknown as CoreApi);

      const delivery = persona.onDelivery({ events: [{
        cursor: 20,
        origin: 'external',
        ts: '2026-09-20T10:00:00.000Z',
        text: 'hello',
      } as EventEnvelope] });

      expect(delivery).toBeInstanceOf(Promise);
      await delivery;
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('applies the current appraisal to the delivered cognitive frame', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-appraisal-'));
    try {
      const injected: string[] = [];
      const appraisalLogs: unknown[] = [];
      const cfg = definition.defaults();
      cfg.appraisal!.provider = 'laya';
      cfg.appraisal!.debugLog = true;
      const appraiser = new Appraiser(cfg.appraisal!, {
        loadLaya: async () => ({
          systemOne: async () => ({ answers: {
            initiative: { noul: 0.99 },
            topicPersistence: { noul: 0.01 },
            playfulness: { noul: 0.77 },
          } }),
          close: async () => undefined,
        }),
      });
      const persona = new ContinuityPersona({ memoryDir, cfg, worlds: [], appraiser } as ConstructorParameters<typeof ContinuityPersona>[0]);
      persona.attach({
        injectInternal: (text: string) => injected.push(text),
        log: { ...nullLogger(), info: (msg: string, data: unknown) => appraisalLogs.push({ msg, data }) },
        timers: { onDue: () => {}, list: () => [] },
        deliveryGate: { isBlocked: () => false },
      } as unknown as CoreApi);

      await persona.onDelivery({ events: [{
        cursor: 20,
        origin: 'external',
        ts: '2026-09-20T10:00:00.000Z',
        text: '继续聊。',
      } as EventEnvelope] });

      expect(injected.join('\n')).toContain('initiative: 0.99');
      expect(injected.join('\n')).toContain('topic persistence: 0.01');
      expect(injected.join('\n')).toContain('teasing: 0.77');
      expect(appraisalLogs).toEqual([{
        msg: 'appraisal result',
        data: { source: 'laya', variant: 'english', initiative: 0.99, topicPersistence: 0.01, playfulness: 0.77 },
      }]);
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('carries one sender identity across group and private external deliveries', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-person-'));
    try {
      const injected: string[] = [];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds: [] });
      persona.attach({
        injectInternal: (text: string) => injected.push(text),
        log: nullLogger(),
        timers: { onDue: () => {}, list: () => [] },
        deliveryGate: { isBlocked: () => false },
      } as unknown as CoreApi);
      const group = {
        cursor: 20,
        type: 'QQ.message',
        ts: '2026-09-20T10:00:00.000Z',
        source: 'QQ',
        senderKey: 'QQ.100',
        origin: 'external',
        text: 'group message',
        meta: { conv: { kind: 'group', id: '1' } },
      } as EventEnvelope;
      const privateMessage = {
        ...group,
        cursor: 21,
        ts: '2026-09-20T10:01:00.000Z',
        meta: { conv: { kind: 'private', id: '100' } },
      } as EventEnvelope;

      await persona.onDelivery({ events: [group] });
      await persona.onDelivery({ events: [privateMessage] });
      await persona.onDelivery({ events: [{
        ...privateMessage,
        cursor: 22,
        type: 'QQ.vision',
        ts: '2026-09-20T10:01:01.000Z',
        senderKey: undefined,
        text: 'image recognition result',
      }] });
      const frames = injected.filter((text) => text.includes('[system/cognitive-frame]'));
      const heat = (frame: string) => Number(/person interaction heat (\d+\.\d+)/.exec(frame)?.[1]);

      expect(heat(frames[1]!)).toBeGreaterThan(heat(frames[0]!));
      expect(/Mechanical state:[^\n]+/.exec(frames[2]!)?.[0]).toBe(/Mechanical state:[^\n]+/.exec(frames[1]!)?.[0]);
      const runtime = JSON.parse(readFileSync(join(memoryDir, 'state', 'runtime.json'), 'utf8'));
      expect(runtime.lastExternalCursor).toBe(22);
      expect(runtime.lastPersonKey).toBe('QQ:QQ.100');
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('does not create runtime state for an internal event and includes dream state in a later frame', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-internal-'));
    try {
      const injected: string[] = [];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds: [] });
      persona.attach({
        injectInternal: (text: string) => injected.push(text),
        log: nullLogger(),
        timers: { onDue: () => {}, list: () => [] },
        deliveryGate: { isBlocked: () => false },
      } as unknown as CoreApi);

      await persona.onDelivery({ events: [{ cursor: 2, origin: 'internal' } as EventEnvelope] });
      expect(existsSync(join(memoryDir, 'state', 'runtime.json'))).toBe(false);

      writeFileSync(join(memoryDir, 'state', 'STATE.md'), '# Current continuity\n\nKeep the next conversation gentle.\n', 'utf8');
      await persona.onDelivery({ events: [{ cursor: 3, origin: 'external', ts: '2026-09-20T10:00:00.000Z' } as EventEnvelope] });
      expect(injected.find((text) => text.includes('Keep the next conversation gentle.'))).toBeTruthy();
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('does not derive a cognitive frame from a handoff note delivery', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-handoff-event-'));
    try {
      const injected: string[] = [];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds: [] });
      persona.attach({
        injectInternal: (text: string) => injected.push(text),
        log: nullLogger(),
        timers: { onDue: () => {}, list: () => [] },
        deliveryGate: { isBlocked: () => false },
      } as unknown as CoreApi);

      await persona.onDelivery({ events: [{
        cursor: 4,
        type: HANDOFF_NOTE_TYPE,
        ts: '2026-09-22T00:00:00.000Z',
        source: 'persona',
        origin: 'external',
        text: '# 交接笔记',
      } as EventEnvelope] });

      expect(injected.some((text) => text.includes('[system/cognitive-frame]'))).toBe(false);
      expect(existsSync(join(memoryDir, 'state', 'runtime.json'))).toBe(false);
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('omits prior cognitive frames and handoff reads from the next handoff note', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-handoff-note-'));
    try {
      const internal: string[] = [];
      const external: string[] = [];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds: [] });
      persona.attach({
        injectInternal: (text: string) => internal.push(text),
        injectExternal: (text: string) => external.push(text),
        toolsTagged: () => new Set<string>(),
        spawnFork: async () => '',
        log: nullLogger(),
        timers: { onDue: () => {}, list: () => [] },
        deliveryGate: { isBlocked: () => false },
      } as unknown as CoreApi);
      const snapshot = [
        message('user', '[system/cognitive-frame]\nBehavior tendencies: warmth: 0.72.'),
        functionCall('read_handoff', 'read_file', '{"path":"handoffs/earlier.md"}'),
        functionResult('read_handoff', '# 交接笔记 · 最近的一段\n\nEarlier handoff body.'),
        message('user', 'A new message arrived after that handoff.'),
      ];

      await persona.onHandoff(snapshot, { hardTokens: null });
      const rendered = external.join('\n');

      expect(rendered).toContain('A new message arrived after that handoff.');
      expect(rendered).not.toContain('[system/cognitive-frame]');
      expect(rendered).not.toContain('Earlier handoff body.');
      const opening = internal.find((text) => text.includes('交接完了'));
      expect(opening).toContain('不要再读存档');
      expect(opening).not.toContain('handoffs/');
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });
});
