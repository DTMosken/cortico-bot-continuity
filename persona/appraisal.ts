import { decisionModel, jevSecretName, jevSource, OPENROUTER_JEV_ENDPOINT, TYPESAFE_JEV_ENDPOINT, type PersonaConfig } from './config.ts';
import { startMultilingualLaya } from './laya-python.ts';
import { isolatedLayaPool, layaRuntimeKey, sharedLayaPool, type SharedLayaClient } from './shared-laya.ts';
import type { AppraisalInput } from './appraisal-context.ts';

type AppraisalConfig = PersonaConfig['appraisal'];
type AppraisalSource = AppraisalConfig['provider'];
type AppraisalScoreKey = 'initiative' | 'topicPersistence' | 'playfulness';

export interface CognitiveAppraisal {
  source: AppraisalSource;
  variant?: AppraisalConfig['laya']['variant'];
  confidence: number;
  initiative: number;
  topicPersistence: number;
  playfulness: number;
  available?: boolean;
}
export type { AppraisalInput } from './appraisal-context.ts';

interface LayaModel {
  systemOne(state: unknown, questions: unknown): Promise<unknown>;
  close(): Promise<void>;
}

interface LayaRuntimeOptions {
  variant: 'multilingual';
  pythonExecutable: string;
}

interface JevRequest {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  state: { message: string };
  questions: Record<string, unknown>;
}

export interface AppraiserDependencies {
  loadLaya?: (options?: LayaRuntimeOptions) => Promise<LayaModel>;
  requestJev?: (request: JevRequest) => Promise<unknown>;
  getEnv?: (name: string) => string | undefined;
}

const SCORE_KEYS: readonly AppraisalScoreKey[] = ['initiative', 'topicPersistence', 'playfulness'];

const QUESTIONS = {
  initiative: {
    type: 'noul',
    instructions: 'Should I respond to the current message(s) with more initiative, such as a useful follow-up or question?',
  },
  topicPersistence: {
    type: 'noul',
    instructions: 'Should I respond to the current message(s) by continuing the present topic?',
  },
  playfulness: {
    type: 'noul',
    instructions: 'Should I respond to the current message(s) with a light, playful tone?',
  },
};

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (const char of text) {
    value ^= char.codePointAt(0) ?? 0;
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

function randomAppraisal(input: AppraisalInput): CognitiveAppraisal {
  const score = (key: AppraisalScoreKey): number => 0.15 + (hash(`${key}\u0000${JSON.stringify(input.current)}`) / 0x1_0000_0000) * 0.7;
  return {
    source: 'random',
    confidence: 0.3,
    initiative: score('initiative'),
    topicPersistence: score('topicPersistence'),
    playfulness: score('playfulness'),
  };
}

function unavailable(source: 'laya' | 'jev'): CognitiveAppraisal {
  return { source, confidence: 0, initiative: 0.5, topicPersistence: 0.5, playfulness: 0.5, available: false };
}

/** Deliberately an estimate; the providers do not expose a shared tokenizer. */
export function estimatedTokens(value: string): number {
  let estimate = 0;
  for (const char of value) estimate += /[\u3400-\u9fff]/u.test(char) ? 0.6 : /[\x00-\x7f]/u.test(char) ? 0.3 : 1;
  return estimate;
}

function requestText(input: AppraisalInput, redact: boolean): string {
  const speakers = new Map<string, string>();
  const compact = (message: AppraisalInput['current'][number]) => ({
    source: message.source.slice(0, 80), type: message.type.slice(0, 80), ts: message.ts,
    speaker: redact ? (() => {
      if (message.role === 'bot') return 'bot';
      if (!speakers.has(message.speaker)) speakers.set(message.speaker, `participant${speakers.size + 1}`);
      return speakers.get(message.speaker)!;
    })() : message.speaker.slice(0, 80),
    role: message.role, text: redact ? redactForJev(message.text) : message.text,
  });
  const payload = {
    scene: (redact ? input.scene.replace(/:[^:]+$/u, ':redacted') : input.scene).slice(0, 80),
    mechanical: input.mechanical ?? {},
    current: input.current.map(compact),
    history: input.history.map(compact),
  };
  let result = JSON.stringify(payload);
  const total = () => estimatedTokens(JSON.stringify({ state: { message: result }, questions: QUESTIONS }));
  while (total() > 1000 && payload.history.length > 0) {
    payload.history.shift();
    result = JSON.stringify(payload);
  }
  while (total() > 1000) {
    const candidate = payload.current.find((message) => message.text.length > 0);
    if (candidate) candidate.text = candidate.text.slice(0, Math.max(0, candidate.text.length - 32));
    else if (payload.current.length > 1) payload.current.shift();
    else break;
    result = JSON.stringify(payload);
  }
  return result;
}

function scoresFrom(
  result: unknown,
  source: 'laya' | 'jev',
  variant?: AppraisalConfig['laya']['variant'],
): CognitiveAppraisal | null {
  if (!result || typeof result !== 'object') return null;
  const answers = (result as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  const values = Object.fromEntries(SCORE_KEYS.map((key) => {
    const answer = (answers as Record<string, unknown>)[key];
    const score = answer && typeof answer === 'object' ? (answer as { noul?: unknown }).noul : undefined;
    return [key, typeof score === 'number' && Number.isFinite(score) ? clamp(score) : null];
  })) as Record<AppraisalScoreKey, number | null>;
  if (SCORE_KEYS.some((key) => values[key] === null)) return null;
  return {
    source,
    ...(variant ? { variant } : {}),
    confidence: source === 'laya' ? 0.7 : 0.6,
    initiative: values.initiative!,
    topicPersistence: values.topicPersistence!,
    playfulness: values.playfulness!,
  };
}

function redactForJev(text: string): string {
  return text
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, '[email]')
    .replace(/\d{4,}/gu, '[number]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_200);
}

async function loadLaya(options?: LayaRuntimeOptions): Promise<LayaModel> {
  if (options?.variant === 'multilingual') return startMultilingualLaya(options);
  const { Laya } = await import('@receptron/laya');
  return Laya.load() as unknown as Promise<LayaModel>;
}

async function requestJev(request: JevRequest): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: request.model, state: request.state, questions: request.questions }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Jev returned ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export class Appraiser {
  private readonly loadLaya: (options?: LayaRuntimeOptions) => Promise<LayaModel>;
  private readonly requestJev: (request: JevRequest) => Promise<unknown>;
  private readonly getEnv: (name: string) => string | undefined;
  private readonly layaPool: ReturnType<typeof sharedLayaPool>;
  private layaClient: SharedLayaClient | null = null;
  private layaKey = '';
  private layaIdleTtlMinutes = 0;

  constructor(private readonly cfg: AppraisalConfig, deps: AppraiserDependencies = {}) {
    this.loadLaya = deps.loadLaya ?? loadLaya;
    this.requestJev = deps.requestJev ?? requestJev;
    this.getEnv = deps.getEnv ?? ((name) => process.env[name]);
    this.layaPool = deps.loadLaya ? isolatedLayaPool() : sharedLayaPool();
  }

  async assess(input: AppraisalInput, cfg = structuredClone(this.cfg)): Promise<CognitiveAppraisal> {
    const fallback = randomAppraisal(input);
    if (cfg.provider === 'random') return fallback;
    if (cfg.provider === 'laya') return this.assessLaya(input, cfg);
    return this.assessJev(input, cfg);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (this.cfg.provider === 'random') return { ok: false, error: 'random 无需连接' };
    if (this.cfg.provider === 'jev') {
      if (!this.cfg.jev.allowRemoteText) return { ok: false, error: '尚未允许远程模型处理文本' };
      const source = jevSource(this.cfg.jev);
      if (!this.getEnv(jevSecretName(source)) && !(source === 'typesafe' && this.getEnv('CORTICO_JEV_API_KEY'))) {
        return { ok: false, error: '决策服务密钥未配置' };
      }
      if (source === 'custom' && !this.cfg.jev.endpoint.trim()) return { ok: false, error: '自定义决策服务地址未配置' };
    }
    const result = await this.assess({ scene: 'test', current: [{ ts: new Date().toISOString(), source: 'test', type: 'test', speaker: 'test', role: 'external', text: 'A short test message.' }], history: [] });
    return result.available !== false && result.source === this.cfg.provider
      ? { ok: true }
      : { ok: false, error: `${this.cfg.provider === 'laya' ? 'Laya' : '远程模型'} 未返回有效评估` };
  }

  async dispose(): Promise<void> {
    const client = this.layaClient;
    this.layaClient = null;
    this.layaKey = '';
    await client?.dispose();
  }

  private async assessLaya(input: AppraisalInput, cfg: AppraisalConfig): Promise<CognitiveAppraisal> {
    try {
      const client = this.getLayaClient(cfg);
      const appraisal = scoresFrom(
        await client.systemOne({ message: requestText(input, false) }, QUESTIONS),
        'laya',
        cfg.laya.variant,
      );
      return appraisal ?? unavailable('laya');
    } catch {
      return unavailable('laya');
    }
  }

  private loadConfiguredLaya(variant: AppraisalConfig['laya']['variant'], pythonExecutable: string): Promise<LayaModel> {
    if (variant !== 'multilingual') return this.loadLaya();
    return this.loadLaya({
      variant: 'multilingual',
      pythonExecutable,
    });
  }

  private getLayaClient(cfg: AppraisalConfig): SharedLayaClient {
    const { variant, pythonExecutable } = cfg.laya;
    this.layaIdleTtlMinutes = cfg.laya.idleTtlMinutes;
    const key = layaRuntimeKey(variant, pythonExecutable);
    if (this.layaClient && this.layaKey === key) return this.layaClient;
    void this.layaClient?.dispose();
    this.layaKey = key;
    this.layaClient = this.layaPool.create(
      key,
      () => this.loadConfiguredLaya(variant, pythonExecutable),
      () => this.layaIdleTtlMinutes,
    );
    return this.layaClient;
  }

  private async assessJev(input: AppraisalInput, cfg: AppraisalConfig): Promise<CognitiveAppraisal> {
    if (!cfg.jev.allowRemoteText) return unavailable('jev');
    const source = jevSource(cfg.jev);
    const apiKey = this.getEnv(jevSecretName(source)) || (source === 'typesafe' ? this.getEnv('CORTICO_JEV_API_KEY') : undefined);
    if (!apiKey) return unavailable('jev');
    try {
      const result = await this.requestJev({
        endpoint: source === 'openrouter' ? OPENROUTER_JEV_ENDPOINT
          : source === 'typesafe' ? TYPESAFE_JEV_ENDPOINT : cfg.jev.endpoint,
        model: decisionModel(cfg.jev),
        apiKey,
        timeoutMs: cfg.jev.timeoutMs,
        state: { message: requestText(input, true) },
        questions: QUESTIONS,
      });
      return scoresFrom(result, 'jev') ?? unavailable('jev');
    } catch {
      return unavailable('jev');
    }
  }
}
