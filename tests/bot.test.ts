import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotDefinition } from 'cortico/bot.ts';
import type { CoreConfig } from 'cortico/core/types.ts';
import type { EventEnvelope, OutputTap, World } from 'cortico/core/types.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { dryMountBot } from 'cortico/extensions/dry-mount.ts';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import { HANDOFF_NOTE_TYPE } from '../base/persona/handoffNote.ts';
import definition from '../index.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { Appraiser } from '../persona/appraisal.ts';
import { CharacterState, PARTICIPATION_COOLDOWN } from '../persona/character-state.ts';
import { makeFakeHarnessApi } from '../../Cortico/tests/core/helpers.ts';

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

  it('keeps Jev key access inside the cognition panel and saves declared settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'continuity-config-'));
    try {
      writeFileSync(join(dir, 'config.json'), '{}\n');
      const cfg = definition.defaults();
      const persona = new ContinuityPersona({ memoryDir: dir, deploymentDir: dir, cfg });
      const consoleDecl = persona.webUi();
      expect(consoleDecl.panels?.map((panel) => panel.id)).toEqual(['config', 'cognition']);
      expect(consoleDecl.config).toBeUndefined();
      expect(await consoleDecl.invoke?.('cognition', 'state', [])).toMatchObject({
        values: { 'appraisal.provider': 'random' },
      });
      await consoleDecl.invoke?.('cognition', 'saveDraft', [{ 'appraisal.provider': 'jev' }]);
      expect(cfg.appraisal?.provider).toBe('jev');
      expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).appraisal.provider).toBe('jev');
      await expect(consoleDecl.invoke?.('cognition', 'saveDraft', [{ 'appraisal.provider': 'unknown' }]))
        .rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  it('uses World output receivers and lifecycle hooks when they become available', () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-stream-receivers-'));
    try {
      const worlds: World[] = [];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds });
      const main = persona.declareSessions().find(session => session.id === 'main')!;
      const event: StreamEvent = { type: 'response.output_text.delta', sequence_number: 0,
        output_index: 0, item_id: 'item', content_index: 0, delta: 'hello' };
      const internal = main.outputTap!;
      expect(internal).toBeDefined();
      expect(internal.externalizes!(event)).toBe(false);

      const received: string[] = [];
      const tap: OutputTap = {
        onEvent: event => received.push(event.type),
        externalizes: () => true,
        onRoundEnd: () => received.push('ended'),
        onAbort: reason => received.push(reason),
      };
      worlds.push({ id: 'receiver', tools: () => [], envPromptVars: () => null,
        start: async () => {}, stop: async () => {}, outputTap: () => tap });
      expect(main.outputTap).toBe(tap);
      main.outputTap!.onEvent(event);
      main.outputTap!.onRoundEnd!();
      main.outputTap!.onAbort!('cancelled');
      expect(received).toEqual(['response.output_text.delta', 'ended', 'cancelled']);
      expect(main.outputTap!.externalizes!(event)).toBe(true);

      worlds.pop();
      expect(main.outputTap).toBe(internal);
      expect(main.outputTap!.externalizes!(event)).toBe(false);
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('adds one current cognitive frame without advancing replayed external events', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-'));
    try {
      const injected: string[] = [];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds: [] });
      persona.attach(makeFakeHarnessApi({
        injectInternal: (text: string) => injected.push(text),
      }));
      const event = {
        cursor: 19,
        type: 'console.message',
        ts: '2026-09-20T10:00:00.000Z',
        source: 'console',
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

  it('settles delivery only after the appraisal frame is injected', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-delivery-'));
    try {
      const injected: string[] = [];
      let release!: () => void;
      const appraised = new Promise<void>((resolve) => { release = resolve; });
      const cfg = definition.defaults();
      cfg.appraisal!.provider = 'laya';
      const appraiser = new Appraiser(cfg.appraisal!, {
        loadLaya: async () => ({
          systemOne: async () => {
            await appraised;
            return { answers: {
              participation: { noul: 0.5 }, warmth: { noul: 0.5 }, selfDisclosure: { noul: 0.5 }, restraint: { noul: 0.5 },
              initiative: { noul: 0.5 }, topicPersistence: { noul: 0.5 }, playfulness: { noul: 0.5 },
            } };
          },
          close: async () => undefined,
        }),
      });
      const persona = new ContinuityPersona({ memoryDir, cfg, worlds: [], appraiser });
      persona.attach(makeFakeHarnessApi({
        injectInternal: (text: string) => injected.push(text),
      }));
      const frames = () => injected.filter((text) => text.includes('[system/cognitive-frame]'));

      let settled = false;
      const delivery = persona.onDelivery({ events: [{
        cursor: 20,
        origin: 'external',
        ts: '2026-09-20T10:00:00.000Z',
        text: 'hello',
      } as EventEnvelope] }).then(() => { settled = true; });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(frames()).toEqual([]);
      release();
      await delivery;
      expect(frames()).toHaveLength(1);
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
            participation: { noul: 0.5 }, warmth: { noul: 0.5 }, selfDisclosure: { noul: 0.5 }, restraint: { noul: 0.5 }, initiative: { noul: 0.99 },
            topicPersistence: { noul: 0.01 },
            playfulness: { noul: 0.77 },
          } }),
          close: async () => undefined,
        }),
      });
      const persona = new ContinuityPersona({ memoryDir, cfg, worlds: [], appraiser } as ConstructorParameters<typeof ContinuityPersona>[0]);
      persona.attach(makeFakeHarnessApi({
        injectInternal: (text: string) => injected.push(text),
        log: { ...nullLogger(), info: (msg: string, data: unknown) => appraisalLogs.push({ msg, data }) },
      }));

      await persona.onDelivery({ events: [{
        cursor: 20,
        origin: 'external',
        ts: '2026-09-20T10:00:00.000Z',
        text: '继续聊。',
      } as EventEnvelope] });

      expect(injected.join('\n')).toContain('initiative: high; Offer a useful next step or question.');
      expect(injected.join('\n')).toContain('topic persistence: low; Allow a topic change.');
      expect(injected.join('\n')).toContain('playfulness: high; Use a light tone without forcing jokes.');
      expect(injected.join('\n')).not.toContain('- teasing:');
      expect(appraisalLogs).toEqual([{
        msg: 'appraisal result',
        data: { source: 'laya', available: true, variant: 'english', participation: 0.5, warmth: 0.5, selfDisclosure: 0.5, restraint: 0.5, intimacy: undefined, initiative: 0.99, topicPersistence: 0.01, playfulness: 0.77 },
      }]);
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('appraises one QQ group as a scene and keeps current messages separate from history', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-group-'));
    try {
      const requests: string[] = [];
      const cfg = definition.defaults();
      cfg.appraisal!.provider = 'laya';
      const appraiser = new Appraiser(cfg.appraisal!, {
        loadLaya: async () => ({
          systemOne: async (state) => {
            requests.push((state as { message: string }).message);
            return { answers: { participation: { noul: 0.5 }, warmth: { noul: 0.5 }, selfDisclosure: { noul: 0.5 }, restraint: { noul: 0.5 }, initiative: { noul: 0.5 }, topicPersistence: { noul: 0.5 }, playfulness: { noul: 0.5 } } };
          },
          close: async () => undefined,
        }),
      });
      const persona = new ContinuityPersona({ memoryDir, cfg, worlds: [], appraiser });
      persona.attach(makeFakeHarnessApi());
      const event = (cursor: number, senderKey: string, text: string) => ({
        cursor, senderKey, text, origin: 'external', type: 'qq.message', source: 'qq',
        ts: new Date().toISOString(), meta: { conv: { kind: 'group', id: 42 } },
      } as EventEnvelope);
      await persona.onDelivery({ events: [event(1, 'A', 'first'), event(2, 'B', 'second')] });
      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0]!)).toMatchObject({
        scene: 'qq:group:42', history: [], current: [{ speaker: 'A', text: 'first' }, { speaker: 'B', text: 'second' }],
      });
      await persona.onDelivery({ events: [event(3, 'A', 'third')] });
      expect(JSON.parse(requests[1]!)).toMatchObject({
        current: [{ text: 'third' }], history: [{ text: 'first' }, { text: 'second' }],
      });
      await persona.onDelivery({ events: [event(3, 'A', 'third')] });
      const history = JSON.parse(readFileSync(join(memoryDir, 'state', 'appraisal-history.json'), 'utf8'));
      expect(history.scenes['qq:group:42']).toHaveLength(3);
      const runtime = JSON.parse(readFileSync(join(memoryDir, 'state', 'runtime.json'), 'utf8'));
      expect(runtime.scenes['qq:group:42']).toBeDefined();
      expect(runtime.people).toEqual({});
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('keeps dungeon scene state separate and still frames an unknown World', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-worlds-'));
    try {
      const injected: string[] = [];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds: [] });
      persona.attach(makeFakeHarnessApi({ injectInternal: (text: string) => injected.push(text) }));
      const event = (cursor: number, source: string, senderKey: string) => ({
        cursor, source, senderKey, origin: 'external', type: `${source}.message`, text: 'hello',
        ts: `2026-09-28T00:00:0${cursor}Z`,
      } as EventEnvelope);
      await persona.onDelivery({ events: [event(1, 'dungeon', 'dungeon.plaza')] });
      await persona.onDelivery({ events: [event(2, 'dungeon', 'dungeon.market')] });
      await persona.onDelivery({ events: [event(3, 'other', 'channel') ] });
      const runtime = JSON.parse(readFileSync(join(memoryDir, 'state', 'runtime.json'), 'utf8'));
      expect(Object.keys(runtime.scenes)).toEqual(['dungeon:scene:dungeon.plaza', 'dungeon:scene:dungeon.market']);
      expect(injected.filter((text) => text.includes('[system/cognitive-frame]'))).toHaveLength(3);
      expect(injected.at(-1)).toContain('unknown relationship energy: low background.');
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('counts every QQ speak call toward cooldown and records only a confirmed reply in history', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-confirm-'));
    try {
      let fail = true;
      // Real QQ returns plain strings for sent, failed and discarded drafts, so every call counts.
      const worlds = [{ id: 'qq', tools: () => [
        { name: 'qq_draft', tags: ['speak'], handler: async () => '[draft staged → group]' },
        { name: 'qq_confirm', tags: ['speak'], handler: async (args: { decision?: string }) => args.decision === 'cancel'
          ? '[draft discarded (group)]' : fail ? '[send failed] retry' : '[sent #3 → group]' },
      ] }] as never[];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds });
      const tools = persona.declareSessions().find((session) => session.id === 'main')!.tools();
      const draft = tools.find((tool) => tool.name === 'qq_draft')!;
      const confirm = tools.find((tool) => tool.name === 'qq_confirm')!;
      const multiplier = () => new CharacterState(memoryDir).participationMultiplier();
      await draft.handler({ to: 'group:42', text: 'hello group' }, { role: 'main' } as never);
      const path = join(memoryDir, 'state', 'appraisal-history.json');
      expect(existsSync(path)).toBe(false);
      expect(multiplier()).toBeCloseTo(PARTICIPATION_COOLDOWN.factor);
      await confirm.handler({ decision: 'send' }, { role: 'main' } as never);
      expect(existsSync(path)).toBe(false);
      expect(multiplier()).toBeCloseTo(PARTICIPATION_COOLDOWN.factor ** 2);
      fail = false;
      await confirm.handler({ decision: 'send' }, { role: 'main' } as never);
      const history = JSON.parse(readFileSync(path, 'utf8'));
      expect(history.scenes['qq:group:42']).toMatchObject([{ role: 'bot', text: 'hello group' }]);
      expect(multiplier()).toBeCloseTo(PARTICIPATION_COOLDOWN.factor ** 3);
      await draft.handler({ to: 'group:42', text: 'never mind' }, { role: 'main' } as never);
      await confirm.handler({ decision: 'cancel' }, { role: 'main' } as never);
      expect(multiplier()).toBeCloseTo(PARTICIPATION_COOLDOWN.factor ** 5);
      expect(JSON.parse(readFileSync(path, 'utf8')).scenes['qq:group:42']).toHaveLength(1);
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('carries one sender identity across group and private external deliveries', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-person-'));
    try {
      const injected: string[] = [];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds: [] });
      persona.attach(makeFakeHarnessApi({
        injectInternal: (text: string) => injected.push(text),
      }));
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
      const beforeDerived = JSON.parse(readFileSync(join(memoryDir, 'state', 'runtime.json'), 'utf8'));
      await persona.onDelivery({ events: [{
        ...privateMessage,
        cursor: 22,
        type: 'QQ.vision',
        ts: '2026-09-20T10:01:01.000Z',
        senderKey: undefined,
        text: 'image recognition result',
      }] });
      const frames = injected.filter((text) => text.includes('[system/cognitive-frame]'));
      expect(frames[0]).toContain('scene interaction heat: low background.');
      expect(frames[1]).toContain('person interaction heat: low background.');
      expect(frames[2]).toContain('person interaction heat: low background.');
      const runtime = JSON.parse(readFileSync(join(memoryDir, 'state', 'runtime.json'), 'utf8'));
      expect(runtime.people).toEqual(beforeDerived.people);
      expect(runtime.scenes).toEqual(beforeDerived.scenes);
      expect(runtime.scenes['QQ:group:1'].interactionMomentum).toBeGreaterThan(0);
      expect(runtime.people['QQ:private:100'].interactionMomentum).toBeGreaterThan(0);
      expect(runtime.lastExternalCursor).toBe(22);
      expect(runtime.lastPersonKey).toBe('QQ:private:100');
      expect(runtime.lastSceneKey).toBe('QQ:group:1');
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });

  it('does not create runtime state for an internal event and includes dream state in a later frame', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-persona-internal-'));
    try {
      const injected: string[] = [];
      const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds: [] });
      persona.attach(makeFakeHarnessApi({
        injectInternal: (text: string) => injected.push(text),
      }));

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
      persona.attach(makeFakeHarnessApi({
        injectInternal: (text: string) => injected.push(text),
      }));

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
      persona.attach(makeFakeHarnessApi({
        injectInternal: (text: string) => internal.push(text),
        injectExternal: (text: string) => external.push(text),
        toolsTagged: () => new Set<string>(),
        spawnFork: async () => '',
      }));
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
      expect(rendered.match(/Earlier handoff body\./g)).toHaveLength(1);
      expect(rendered).toContain('[previous-handoff-background]');
      const opening = internal.find((text) => text.includes('交接完了'));
      expect(opening).toContain('不要再读存档');
      expect(opening).not.toContain('handoffs/');
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  });
});


it('adds the proactive cognitive reminder to system ticks', async () => {
  class TickPersona extends ContinuityPersona { tick(): string { return this.tickText(3600); } }
  const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-tick-cognition-'));
  const persona = new TickPersona({ memoryDir, cfg: definition.defaults() });
  try {
    expect(persona.tick()).toContain('[system/cognitive-frame]\n要不要主动说点什么？\n[/system/cognitive-frame]');
  } finally { await persona.dispose(); rmSync(memoryDir, { recursive: true, force: true }); }
});


it.each([
  { to: 'group:42', image: 'mem:image' },
  { to: ' GROUP:00042 ', voice: 'mem:voice' },
  { to: ' group:42 ', text: 'hello' },
  { to: 'GROUP:42', text: 'hello' },
  { to: 'group:00042', text: 'hello' },
])('cools the canonical QQ group after confirmed text or media: %j', async args => {
  const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-qq-media-'));
  const worlds = [{ id: 'qq', tools: () => [
    { name: 'qq_draft', tags: ['speak'], handler: async () => '[draft staged → group]' },
    { name: 'qq_confirm', tags: ['speak'], handler: async () => '[sent #3 → group]' },
  ] }] as never[];
  const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds });
  try {
    const tools = persona.declareSessions().find(session => session.id === 'main')!.tools();
    const context = { role: 'main', log: nullLogger() };
    await tools.find(tool => tool.name === 'qq_draft')!.handler(args, context);
    expect(new CharacterState(memoryDir).participationMultiplier()).toBeCloseTo(PARTICIPATION_COOLDOWN.factor);
    await tools.find(tool => tool.name === 'qq_confirm')!.handler({ decision: 'send' }, context);
    expect(new CharacterState(memoryDir).participationMultiplier()).toBeCloseTo(PARTICIPATION_COOLDOWN.factor ** 2);
    const runtime = JSON.parse(readFileSync(join(memoryDir, 'state/runtime.json'), 'utf8'));
    expect(runtime.participationCooldown.multiplier).toBeCloseTo(PARTICIPATION_COOLDOWN.factor ** 2);
    const history = JSON.parse(readFileSync(join(memoryDir, 'state/appraisal-history.json'), 'utf8'));
    expect(history.scenes['qq:group:42'][0]).toMatchObject({ role: 'bot', text: 'text' in args ? args.text : '' });
  } finally { await persona.dispose(); rmSync(memoryDir, { recursive: true, force: true }); }
});

it('shares cooldown across successful speak tools without target metadata or turn settlement', async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), 'continuity-global-speech-'));
  const sent: string[] = [];
  const parameters = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
  const tool = (name: string, tags: readonly ('speak' | 'read')[]) => ({ name, description: 'Output.', tags, parameters,
    handler: async (args: Record<string, unknown>) => {
      if (args.text === 'throw') throw new Error('send failed');
      if (args.text === 'fail') return { text: 'send failed', failed: true as const };
      sent.push(String(args.text));
      return 'done';
    } });
  const worlds = [{ id: 'community', tools: () => [tool('community_send', ['speak'])] },
    { id: 'chat', tools: () => [tool('chat_send', ['speak']), tool('chat_read', ['read'])] }] as never[];
  const persona = new ContinuityPersona({ memoryDir, cfg: definition.defaults(), worlds });
  try {
    const tools = persona.declareSessions().find(session => session.id === 'main')!.tools();
    const first = tools.find(tool => tool.name === 'community_send')!;
    const second = tools.find(tool => tool.name === 'chat_send')!;
    const end = tools.find(tool => tool.name === 'end_turn')!;
    const context = { role: 'main', log: nullLogger() };
    const multiplier = () => new CharacterState(memoryDir).participationMultiplier();
    expect(first.parameters).toBe(parameters);
    await end.handler({}, context); persona.onTurnEnded();
    expect(multiplier()).toBe(1);
    await first.handler({ text: 'one' }, context);
    expect(multiplier()).toBeCloseTo(PARTICIPATION_COOLDOWN.factor);
    await second.handler({ text: 'two' }, context);
    expect(multiplier()).toBeCloseTo(PARTICIPATION_COOLDOWN.factor ** 2);
    await second.handler({ text: 'fail' }, context);
    await expect(second.handler({ text: 'throw' }, context)).rejects.toThrow('send failed');
    await tools.find(tool => tool.name === 'chat_read')!.handler({ text: 'read' }, context);
    await end.handler({}, context); persona.onTurnEnded(); persona.onTurnEnded();
    expect(multiplier()).toBeCloseTo(PARTICIPATION_COOLDOWN.factor ** 2);
    expect(sent).toEqual(['one', 'two', 'read']);
  } finally { await persona.dispose(); rmSync(memoryDir, { recursive: true, force: true }); }
});
