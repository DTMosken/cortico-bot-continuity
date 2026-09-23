import type { PersonaConfig } from './config.ts';
import { startMultilingualLaya } from './laya-python.ts';

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
}

export interface AppraisalInput {
  text: string;
}

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
    instructions: 'Does this message invite an active reply or a new question?',
  },
  topicPersistence: {
    type: 'noul',
    instructions: 'Does this message indicate that the current topic should continue?',
  },
  playfulness: {
    type: 'noul',
    instructions: 'Would a light, playful tone fit this message?',
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
  const score = (key: AppraisalScoreKey): number => 0.15 + (hash(`${key}\u0000${input.text}`) / 0x1_0000_0000) * 0.7;
  return {
    source: 'random',
    confidence: 0.3,
    initiative: score('initiative'),
    topicPersistence: score('topicPersistence'),
    playfulness: score('playfulness'),
  };
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
      body: JSON.stringify({ state: request.state, questions: request.questions }),
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
  private warmLaya: LayaModel | null = null;
  private layaIdleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly cfg: AppraisalConfig, deps: AppraiserDependencies = {}) {
    this.loadLaya = deps.loadLaya ?? loadLaya;
    this.requestJev = deps.requestJev ?? requestJev;
    this.getEnv = deps.getEnv ?? ((name) => process.env[name]);
  }

  async assess(input: AppraisalInput): Promise<CognitiveAppraisal> {
    const fallback = randomAppraisal(input);
    if (this.cfg.provider === 'random') return fallback;
    if (this.cfg.provider === 'laya') return this.assessLaya(input, fallback);
    return this.assessJev(input, fallback);
  }

  async dispose(): Promise<void> {
    this.clearLayaIdleTimer();
    const model = this.warmLaya;
    this.warmLaya = null;
    if (model) await model.close();
  }

  private async assessLaya(input: AppraisalInput, fallback: CognitiveAppraisal): Promise<CognitiveAppraisal> {
    if (this.cfg.laya.idleTtlMinutes <= 0) return this.assessColdLaya(input, fallback);

    let model: LayaModel | null = null;
    try {
      model = this.warmLaya ?? await this.loadConfiguredLaya();
      this.warmLaya = model;
      this.clearLayaIdleTimer();
      const appraisal = scoresFrom(
        await model.systemOne({ message: input.text.slice(0, 1_200) }, QUESTIONS),
        'laya',
        this.cfg.laya.variant,
      );
      return appraisal ?? fallback;
    } catch {
      return fallback;
    } finally {
      if (model && this.warmLaya === model) this.scheduleLayaIdleRelease(model);
    }
  }

  private async assessColdLaya(input: AppraisalInput, fallback: CognitiveAppraisal): Promise<CognitiveAppraisal> {
    let model: LayaModel | null = null;
    try {
      model = await this.loadConfiguredLaya();
      const appraisal = scoresFrom(
        await model.systemOne({ message: input.text.slice(0, 1_200) }, QUESTIONS),
        'laya',
        this.cfg.laya.variant,
      );
      return appraisal ?? fallback;
    } catch {
      return fallback;
    } finally {
      if (model) await model.close().catch(() => undefined);
    }
  }

  private clearLayaIdleTimer(): void {
    if (this.layaIdleTimer) clearTimeout(this.layaIdleTimer);
    this.layaIdleTimer = null;
  }

  private loadConfiguredLaya(): Promise<LayaModel> {
    if (this.cfg.laya.variant !== 'multilingual') return this.loadLaya();
    return this.loadLaya({
      variant: 'multilingual',
      pythonExecutable: this.cfg.laya.pythonExecutable,
    });
  }

  private scheduleLayaIdleRelease(model: LayaModel): void {
    this.clearLayaIdleTimer();
    this.layaIdleTimer = setTimeout(() => {
      if (this.warmLaya !== model) return;
      this.warmLaya = null;
      this.layaIdleTimer = null;
      void model.close().catch(() => undefined);
    }, this.cfg.laya.idleTtlMinutes * 60_000);
  }

  private async assessJev(input: AppraisalInput, fallback: CognitiveAppraisal): Promise<CognitiveAppraisal> {
    if (!this.cfg.jev.allowRemoteText) return fallback;
    const apiKey = this.getEnv('CORTICO_JEV_API_KEY');
    if (!apiKey) return fallback;
    try {
      const result = await this.requestJev({
        endpoint: this.cfg.jev.endpoint,
        apiKey,
        timeoutMs: this.cfg.jev.timeoutMs,
        state: { message: redactForJev(input.text) },
        questions: QUESTIONS,
      });
      return scoresFrom(result, 'jev') ?? fallback;
    } catch {
      return fallback;
    }
  }
}
