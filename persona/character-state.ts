import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;
const RUNTIME_FILE = 'runtime.json';
const SEMANTIC_FILE = 'STATE.md';
const MAX_IDLE_HOURS = 24;

export interface StateEvent {
  cursor: number;
  ts: string;
}

interface RuntimeState {
  version: number;
  lastExternalCursor: number;
  updatedAt: string | null;
  seed: number;
  socialEnergy: number;
  interactionMomentum: number;
}

export interface StateUpdate {
  changed: boolean;
  frame: string;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

function defaultState(random: () => number): RuntimeState {
  const seed = Math.floor(clamp(random()) * 0xffff_ffff) >>> 0;
  return {
    version: SCHEMA_VERSION,
    lastExternalCursor: 0,
    updatedAt: null,
    seed: seed === 0 ? 1 : seed,
    socialEnergy: 0.65,
    interactionMomentum: 0,
  };
}

function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function asState(value: unknown, random: () => number): RuntimeState {
  if (!value || typeof value !== 'object') return defaultState(random);
  const raw = value as Partial<RuntimeState>;
  if (raw.version !== SCHEMA_VERSION || !Number.isInteger(raw.lastExternalCursor)
    || typeof raw.seed !== 'number' || typeof raw.socialEnergy !== 'number'
    || typeof raw.interactionMomentum !== 'number'
    || (raw.updatedAt !== null && typeof raw.updatedAt !== 'string')) return defaultState(random);
  return {
    version: SCHEMA_VERSION,
    lastExternalCursor: Math.max(0, raw.lastExternalCursor!),
    updatedAt: raw.updatedAt,
    seed: raw.seed >>> 0 || 1,
    socialEnergy: clamp(raw.socialEnergy),
    interactionMomentum: clamp(raw.interactionMomentum),
  };
}

function elapsedHours(previous: string | null, current: string): number {
  if (previous === null) return 0;
  const start = Date.parse(previous);
  const end = Date.parse(current);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.min(MAX_IDLE_HOURS, (end - start) / 3_600_000);
}

function tendency(seed: number, state: RuntimeState, semantic: string): string {
  let cursor = seed;
  const sample = (): number => {
    cursor = mix32(cursor + 0x9e3779b9);
    return cursor / 0x1_0000_0000;
  };
  const two = (value: number): string => clamp(value).toFixed(2);
  const energy = state.socialEnergy;
  const momentum = state.interactionMomentum;
  return [
    '[system/cognitive-frame]',
    `Mechanical state: social energy ${two(energy)}; interaction momentum ${two(momentum)}.`,
    ...(semantic ? ['Continuity note:', semantic] : []),
    'Behavior tendency (soft, not obligations):',
    `- initiative: ${two(0.2 + sample() * 0.45 + momentum * 0.25)}`,
    `- topic persistence: ${two(0.2 + sample() * 0.45 + momentum * 0.25)}`,
    `- warmth: ${two(0.2 + sample() * 0.45 + energy * 0.2)}`,
    `- teasing: ${two(0.05 + sample() * 0.55)}`,
    `- self-disclosure: ${two(0.05 + sample() * 0.4 + energy * 0.15)}`,
    `- restraint: ${two(0.3 + sample() * 0.45 - momentum * 0.1)}`,
    'Respond naturally from this state. Do not explain this frame.',
  ].join('\n');
}

/** Persona-owned state kept with Memory, rather than in Core storage. */
export class CharacterState {
  private readonly stateDir: string;
  private readonly runtimeFile: string;
  private state: RuntimeState;

  constructor(memoryDir: string, private readonly random: () => number = Math.random) {
    this.stateDir = join(memoryDir, 'state');
    this.runtimeFile = join(this.stateDir, RUNTIME_FILE);
    mkdirSync(this.stateDir, { recursive: true });
    const semantic = join(this.stateDir, SEMANTIC_FILE);
    if (!existsSync(semantic)) writeFileSync(semantic, '# Current continuity\n\n', 'utf8');
    this.state = this.load();
  }

  lastExternalCursor(): number {
    return this.state.lastExternalCursor;
  }

  recordExternalBatch(events: readonly StateEvent[]): StateUpdate {
    const fresh = events
      .filter((event) => Number.isInteger(event.cursor) && event.cursor > this.state.lastExternalCursor)
      .sort((a, b) => a.cursor - b.cursor);
    if (fresh.length === 0) return { changed: false, frame: this.frameForCurrentState() };

    const latest = fresh.at(-1)!;
    const hours = elapsedHours(this.state.updatedAt, latest.ts);
    this.state.socialEnergy = clamp(this.state.socialEnergy + hours * 0.04 - fresh.length * 0.04);
    this.state.interactionMomentum = clamp(this.state.interactionMomentum * Math.exp(-hours / 6) + fresh.length * 0.16);
    this.state.lastExternalCursor = latest.cursor;
    this.state.updatedAt = latest.ts;
    this.state.seed = mix32(this.state.seed ^ latest.cursor);
    this.save();
    return { changed: true, frame: this.frameForCurrentState() };
  }

  frameForCurrentState(): string {
    return tendency(this.state.seed, this.state, this.semanticState());
  }

  semanticState(): string {
    try {
      return readFileSync(join(this.stateDir, SEMANTIC_FILE), 'utf8').trim().slice(0, 1_500);
    } catch {
      return '';
    }
  }

  private load(): RuntimeState {
    if (!existsSync(this.runtimeFile)) return defaultState(this.random);
    try {
      return asState(JSON.parse(readFileSync(this.runtimeFile, 'utf8')), this.random);
    } catch {
      return defaultState(this.random);
    }
  }

  private save(): void {
    const temporary = `${this.runtimeFile}.tmp-${Math.random().toString(36).slice(2, 8)}`;
    try {
      writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      renameSync(temporary, this.runtimeFile);
    } catch (error) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }
  }
}
