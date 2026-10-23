import { describe, expect, it, vi } from 'vitest';
import { Appraiser, estimatedTokens } from '../persona/appraisal.ts';
import { DEFAULT_DECISION_MODELS, jevSecretName, PERSONA_DEFAULTS } from '../persona/config.ts';
import { nullLogger } from 'cortico/core/util.ts';

const randomConfig = {
  provider: 'random' as const,
  debugLog: false,
  laya: { idleTtlMinutes: 5, variant: 'english' as const, pythonExecutable: '' },
  jev: { allowRemoteText: false, endpoint: 'https://example.invalid/systemone', timeoutMs: 500 },
};

const input = (text: string) => ({ scene: 'test', current: [{ ts: '2026-09-28T00:00:00Z', source: 'test', type: 'test', speaker: 'user', role: 'external' as const, text }], history: [] });

describe('action appraisal', () => {
  const rules = ['first', 'second', 'third'].map(id => ({ id, scope: { sessions: ['main', 'dream'], tags: ['write' as const, 'speak' as const, 'act' as const] }, instruction: 'Keep meaningful facts.', exceptions: '' }));
  it('sends native choice maps and records per-rule results without logging action text', async () => {
    const records: unknown[] = [];
    const log = { ...nullLogger(), info: (_message: string, data: unknown) => records.push(data) };
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      for (const question of Object.values(request.questions) as any[]) {
        if (Array.isArray(question.criteria)) return new Response('Choice criteria must be an object', { status: 422 });
        expect(Object.keys(question.criteria)).toEqual(['allow', 'remind', 'insufficient']);
      }
      return Response.json({ model: 'decision/test-20261024', answers: Object.fromEntries(Object.keys(request.questions).map(key => [key,
        { type: 'choice', choice: 'remind', confidence: .7, probabilities: { allow: .1, remind: .8, insufficient: .1 } }])) });
    });
    const cfg = { ...randomConfig, provider: 'jev' as const, jev: { ...randomConfig.jev, source: 'custom' as const, allowRemoteText: true } };
    const appraiser = new Appraiser(cfg, { getEnv: () => 'scripted-key' });
    try {
      expect(await appraiser.reviewAction({ tool: 'write_file', text: 'private action text' }, rules, [], cfg, log)).toMatchObject({ kind: 'reviewed' });
      expect(records).toContainEqual(expect.objectContaining({ kind: 'reviewed', model: 'decision/test-20261024', answers: {
        first: { choice: 'remind', confidence: .7, probabilities: { allow: .1, remind: .8, insufficient: .1 } },
        second: expect.any(Object), third: expect.any(Object),
      } }));
      expect(JSON.stringify(records)).not.toMatch(/private action text|scripted-key/);
    } finally { vi.unstubAllGlobals(); await appraiser.dispose(); }
  });

  it.each(['http', 'timeout', 'invalid', 'invalid-json'] as const)('records specific remote review failures (%s) without credentials', async failure => {
    const records: any[] = [];
    const log = { ...nullLogger(), warn: (_message: string, data: unknown) => records.push(data) };
    const cfg = { ...randomConfig, provider: 'jev' as const, jev: { ...randomConfig.jev, source: 'custom' as const, allowRemoteText: true } };
    vi.stubGlobal('fetch', async () => {
      if (failure === 'http') return Response.json({ error: { message: 'invalid criteria; credential=scripted-key', code: 422 }, user_id: 'private-account' }, { status: 422 });
      if (failure === 'timeout') throw new DOMException('The operation was aborted', 'AbortError');
      if (failure === 'invalid-json') return new Response('not json; credential=scripted-key');
      return Response.json({ answers: { rule0: { choice: 'unexpected' } } });
    });
    const appraiser = new Appraiser(cfg, { getEnv: () => 'scripted-key' });
    try {
      expect(await appraiser.reviewAction({}, rules, [], cfg, log)).toMatchObject({ kind: 'unavailable' });
      expect(records[0].error.kind).toBe(failure === 'invalid-json' ? 'invalid' : failure);
      if (failure === 'http') expect(records[0].error).toMatchObject({ status: 422, body: expect.stringContaining('invalid criteria') });
      expect(JSON.stringify(records)).not.toMatch(/scripted-key|private-account/);
    } finally { vi.unstubAllGlobals(); await appraiser.dispose(); }
  });
  it.each(['typesafe', 'openrouter', 'custom'] as const)('reviews a migrated STATE with fourteen full constraints and a normal note in one remote request (%s)', async source => {
    const cfg = { ...randomConfig, provider: 'jev' as const, jev: { ...randomConfig.jev, source, allowRemoteText: true } };
    const constraints = Array.from({ length: 14 }, (_, index) => ({ id: `rule-${index}`, scope: { sessions: ['main', 'dream'], tags: ['write' as const, 'speak' as const, 'act' as const] },
      instruction: '记录事实时保留适用条件、证据范围和不确定性。'.repeat(4), exceptions: '保留必要的截止日期。' }));
    const action = { tool: 'write_file', args: { path: 'note/summary.md', content: '可核实的工作记录。'.repeat(500) } };
    let calls = 0;
    const appraiser = new Appraiser(cfg, { getEnv: () => 'scripted-key', requestJev: async request => {
      calls++;
      expect(JSON.parse(request.state.message).action).toEqual(action);
      expect(Object.keys(request.questions)).toHaveLength(constraints.length);
      return { answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { choice: 'allow' }])) };
    } });
    try {
      expect(await appraiser.reviewAction(action, constraints)).toMatchObject({ kind: 'reviewed' });
      expect(calls).toBe(1);
      expect(await appraiser.reviewAction({ required: '中 '.repeat(100000) }, constraints)).toMatchObject({ kind: 'insufficient' });
      expect(calls).toBe(1);
    } finally { await appraiser.dispose(); }
  });
  it('does no connection probes and returns one typed choice per constraint in a single request', async () => {
    const cfg = { ...randomConfig, provider: 'jev' as const, jev: { ...randomConfig.jev, source: 'custom' as const, allowRemoteText: true } };
    let calls = 0;
    const appraiser = new Appraiser(cfg, { getEnv: () => 'key', requestJev: async request => {
      calls++;
      expect(JSON.parse(request.state.message).action).toEqual({ tool: 'edit_file', change: { before: 'old', after: 'new' } });
      expect(Object.values(request.questions)).toHaveLength(rules.length);
      expect(Object.values(request.questions).every(q => (q as { type: string }).type === 'choice')).toBe(true);
      return { answers: { rule0: { choice: 'allow' }, rule1: { choice: 'remind' }, rule2: { choice: 'insufficient' } } };
    } });
    expect(appraiser.reviewUnavailable()).toBeNull(); expect(calls).toBe(0);
    expect(await appraiser.reviewAction({ tool: 'edit_file', change: { before: 'old', after: 'new' } }, rules, ['x'.repeat(20000)]))
      .toEqual({ kind: 'reviewed', choices: { first: 'allow', second: 'remind', third: 'insufficient' } });
    expect(calls).toBe(1);
    expect(await appraiser.reviewAction({ required: 'x '.repeat(120000) }, rules)).toMatchObject({ kind: 'insufficient' });
    expect(calls).toBe(1);
    cfg.jev.allowRemoteText = false;
    expect(await appraiser.reviewAction({}, rules)).toMatchObject({ kind: 'unavailable' });
    expect(calls).toBe(1);
    await appraiser.dispose();
  });

  it('rejects missing or invalid decisions and honors the local adapter input limit', async () => {
    let result: unknown = { answers: { rule0: { choice: 'allow' } } };
    const appraiser = new Appraiser({ ...randomConfig, provider: 'laya' }, { loadLaya: async () => ({
      systemOne: async () => result, close: async () => {},
    }) });
    expect(await appraiser.reviewAction({}, rules)).toMatchObject({ kind: 'unavailable' });
    result = { inputIncomplete: true };
    expect(await appraiser.reviewAction({}, rules)).toMatchObject({ kind: 'insufficient' });
    await appraiser.dispose();
  });

  it('falls back when local review times out without waiting for a hung model', async () => {
    const appraiser = new Appraiser({ ...randomConfig, provider: 'laya', jev: { ...randomConfig.jev, timeoutMs: 10 } }, {
      loadLaya: async () => ({ systemOne: () => new Promise(() => {}), close: async () => {} }),
    });
    expect(await appraiser.reviewAction({}, rules)).toMatchObject({ kind: 'unavailable', reason: '审核请求失败、超时或响应无效' });
    await appraiser.dispose();
  });
});

describe('Appraiser', () => {
  it('selects a configured decision model and retains the default for old configurations', async () => {
    const model = 'decision/fast';
    const cfg = { ...randomConfig, provider: 'jev' as const,
      jev: { ...randomConfig.jev, source: 'openrouter' as const, allowRemoteText: true, model: ` ${model} ` } };
    const scores: Record<string, number> = { [DEFAULT_DECISION_MODELS.openrouter]: 0.2, [model]: 0.8 };
    const appraiser = new Appraiser(cfg, {
      getEnv: (name) => name === jevSecretName(cfg.jev.source) ? 'test-key' : undefined,
      requestJev: async (request) => {
        const score = scores[request.model];
        if (score === undefined) throw new Error('unknown model');
        return { answers: { initiative: { noul: score }, topicPersistence: { noul: score }, playfulness: { noul: score } } };
      },
    });
    expect(await appraiser.assess(input('继续讨论。'))).toMatchObject({ initiative: scores[model] });
    expect(await appraiser.testConnection()).toEqual({ ok: true });
    cfg.jev.model = '';
    expect(await appraiser.assess(input('继续讨论。'))).toMatchObject({ initiative: scores[DEFAULT_DECISION_MODELS.openrouter] });
    const { model: _model, ...legacy } = cfg.jev;
    expect(await appraiser.assess(input('继续讨论。'), { ...cfg, jev: legacy }))
      .toMatchObject({ initiative: scores[DEFAULT_DECISION_MODELS.openrouter] });
  });

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
