import { describe, expect, it, vi } from 'vitest';
import { Appraiser, estimatedTokens } from '../persona/appraisal.ts';
import { PERSONA_DEFAULTS } from '../persona/config.ts';

const randomConfig = {
  provider: 'random' as const,
  debugLog: false,
  laya: { idleTtlMinutes: 5, variant: 'english' as const, pythonExecutable: '' },
  jev: { allowRemoteText: false, endpoint: 'https://example.invalid/systemone', timeoutMs: 500 },
};

const input = (text: string) => ({ scene: 'test', current: [{ ts: '2026-09-28T00:00:00Z', source: 'test', type: 'test', speaker: 'user', role: 'external' as const, text }], history: [] });

describe('Appraiser', () => {
  it('does not assume a Python executable for multilingual Laya', () => {
    expect(PERSONA_DEFAULTS.appraisal.laya.pythonExecutable).toBe('');
  });

  it('derives reproducible random appraisal from the current message', async () => {
    const appraiser = new Appraiser(randomConfig);

    const first = await appraiser.assess(input('我们继续聊这个实现吧。'));
    const second = await appraiser.assess(input('我们继续聊这个实现吧。'));

    expect(first).toEqual(second);
    expect(first.source).toBe('random');
    expect(first.initiative).toBeGreaterThanOrEqual(0);
    expect(first.initiative).toBeLessThanOrEqual(1);
  });

  it('falls back to random when Laya cannot load', async () => {
    const appraiser = new Appraiser(
      { ...randomConfig, provider: 'laya' },
      { loadLaya: async () => { throw new Error('not installed'); } },
    );

    const result = await appraiser.assess(input('这个话题值得继续。'));

    expect(result.source).toBe('laya');
    expect(result.available).toBe(false);
    expect(await appraiser.testConnection()).toEqual({ ok: false, error: 'Laya 未返回有效评估' });
  });

  it('loads the published default Laya checkpoint', async () => {
    let argumentCount: number | undefined;
    const appraiser = new Appraiser(
      { ...randomConfig, provider: 'laya', laya: { ...randomConfig.laya, idleTtlMinutes: 0 } },
      {
        loadLaya: async (...args) => {
          argumentCount = args.length;
          return {
            systemOne: async () => ({ answers: {
              initiative: { noul: 0.2 },
              topicPersistence: { noul: 0.8 },
              playfulness: { noul: 0.4 },
            } }),
            close: async () => undefined,
          };
        },
      },
    );

    await appraiser.assess(input('继续聊这个话题。'));

    expect(argumentCount).toBe(0);
  });

  it('passes the multilingual Python executable to Laya when configured', async () => {
    let options: unknown;
    const appraiser = new Appraiser(
      {
        ...randomConfig,
        provider: 'laya',
        laya: {
          idleTtlMinutes: 0,
          variant: 'multilingual',
          pythonExecutable: 'D:\\ProgramData\\anaconda3\\envs\\tf-gpu\\python.exe',
        },
      },
      {
        loadLaya: async (...args) => {
          options = args[0];
          return {
            systemOne: async () => ({ answers: {
              initiative: { noul: 0.2 },
              topicPersistence: { noul: 0.8 },
              playfulness: { noul: 0.4 },
            } }),
            close: async () => undefined,
          };
        },
      },
    );

    const result = await appraiser.assess(input('继续聊这个话题。'));

    expect(options).toEqual({
      variant: 'multilingual',
      pythonExecutable: 'D:\\ProgramData\\anaconda3\\envs\\tf-gpu\\python.exe',
    });
    expect(result.variant).toBe('multilingual');
  });

  it('uses Laya scores and releases a zero-TTL model after the assessment', async () => {
    let closed = false;
    const appraiser = new Appraiser(
      { ...randomConfig, provider: 'laya', laya: { ...randomConfig.laya, idleTtlMinutes: 0 } },
      {
        loadLaya: async () => ({
          systemOne: async () => ({ answers: {
            initiative: { noul: 0.2 },
            topicPersistence: { noul: 0.8 },
            playfulness: { noul: 0.4 },
          } }),
          close: async () => { closed = true; },
        }),
      },
    );

    const result = await appraiser.assess(input('继续讲这个话题。'));

    expect(result).toMatchObject({
      source: 'laya', initiative: 0.2, topicPersistence: 0.8, playfulness: 0.4,
    });
    expect(closed).toBe(true);
  });

  it('reuses Laya until its idle TTL expires', async () => {
    vi.useFakeTimers();
    try {
      let loads = 0;
      let closes = 0;
      const appraiser = new Appraiser(
        { ...randomConfig, provider: 'laya' },
        {
          loadLaya: async () => {
            loads++;
            return {
              systemOne: async () => ({ answers: {
                initiative: { noul: 0.2 },
                topicPersistence: { noul: 0.8 },
                playfulness: { noul: 0.4 },
              } }),
              close: async () => { closes++; },
            };
          },
        },
      );

      await appraiser.assess(input('继续讲。'));
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await appraiser.assess(input('继续讲。'));
      expect(loads).toBe(1);
      expect(closes).toBe(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(closes).toBe(0);

      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(closes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases Laya on disposal and cancels its idle release', async () => {
    vi.useFakeTimers();
    try {
      let closes = 0;
      const appraiser = new Appraiser(
        { ...randomConfig, provider: 'laya' },
        {
          loadLaya: async () => ({
            systemOne: async () => ({ answers: {
              initiative: { noul: 0.2 },
              topicPersistence: { noul: 0.8 },
              playfulness: { noul: 0.4 },
            } }),
            close: async () => { closes++; },
          }),
        },
      );

      await appraiser.assess(input('继续讲。'));
      expect(closes).toBe(0);
      await appraiser.dispose();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(closes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies changed idle TTL on the next assessment while preserving the active snapshot', async () => {
    const cfg = { ...randomConfig, provider: 'laya' as const, laya: { ...randomConfig.laya } };
    let release!: () => void, started!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let closes = 0, loads = 0, first = true;
    const appraiser = new Appraiser(cfg, { loadLaya: async () => {
      loads++;
      return { systemOne: async () => {
        if (first) { first = false; started(); await gate; }
        return { answers: { initiative: { noul: 0.5 }, topicPersistence: { noul: 0.5 }, playfulness: { noul: 0.5 } } };
      }, close: async () => { closes++; } };
    } });
    try {
      const assessment = appraiser.assess(input('first'));
      await active;
      cfg.laya.idleTtlMinutes = 0;
      release(); await assessment;
      expect(closes).toBe(0);
      await appraiser.assess(input('second'));
      expect(loads).toBe(1); expect(closes).toBe(1);
      await appraiser.assess(input('third'));
      expect(loads).toBe(2);
    } finally { await appraiser.dispose(); }
  });

  it('does not contact Jev until remote text processing is enabled', async () => {
    let contacted = false;
    const appraiser = new Appraiser(
      { ...randomConfig, provider: 'jev' },
      { requestJev: async () => { contacted = true; throw new Error('should not run'); } },
    );

    const result = await appraiser.assess(input('不要发送这段内容。'));

    expect(result.source).toBe('jev');
    expect(result.available).toBe(false);
    expect(contacted).toBe(false);
  });

  it('sends Jev a redacted current-message payload after explicit authorization', async () => {
    let payload: unknown;
    const appraiser = new Appraiser(
      { ...randomConfig, provider: 'jev', jev: { ...randomConfig.jev, allowRemoteText: true } },
      {
        getEnv: () => 'test-key',
        requestJev: async (request) => {
          payload = request;
          return { answers: {
            initiative: { noul: 0.6 },
            topicPersistence: { noul: 0.7 },
            playfulness: { noul: 0.3 },
          } };
        },
      },
    );

    const result = await appraiser.assess(input('联系 user@example.com，订单 123456，见 https://example.com/a。'));

    expect(result.source).toBe('jev');
    expect(JSON.parse((payload as { state: { message: string } }).state.message)).toMatchObject({
      current: [{ role: 'external', speaker: 'participant1', text: '联系 [email]，订单 [number]，见 [url]' }],
      history: [],
    });
    expect(payload).not.toHaveProperty('senderKey');
    expect(await appraiser.testConnection()).toEqual({ ok: true });
    expect(JSON.parse((payload as { state: { message: string } }).state.message).current[0].text).toBe('A short test message.');
  });

  it('budgets the whole Laya request and removes old history before current text', async () => {
    let state: unknown;
    let questions: unknown;
    const appraiser = new Appraiser({ ...randomConfig, provider: 'laya' }, {
      loadLaya: async () => ({
        systemOne: async (givenState, givenQuestions) => {
          state = givenState;
          questions = givenQuestions;
          return { answers: { initiative: { noul: 0.5 }, topicPersistence: { noul: 0.5 }, playfulness: { noul: 0.5 } } };
        },
        close: async () => undefined,
      }),
    });
    await appraiser.assess({
      ...input('现在' + '中'.repeat(1000)),
      history: [{ ...input('历史' + '中'.repeat(1000)).current[0]! }],
    });
    const serialized = JSON.stringify({ state, questions });
    expect(estimatedTokens(serialized)).toBeLessThanOrEqual(1000);
    expect(JSON.parse((state as { message: string }).message).history).toEqual([]);
    expect(JSON.parse((state as { message: string }).message).current[0].text).toContain('现在');
  });
});
