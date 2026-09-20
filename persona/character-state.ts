import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_VERSION = 2;
const RUNTIME_FILE = 'runtime.json';
const SEMANTIC_FILE = 'STATE.md';
const MAX_IDLE_HOURS = 24;
const MIN_SOCIAL_ENERGY = 0.55;
const MAX_SOCIAL_ENERGY = 0.65;
const MAX_PERSON_HEAT = 0.75;
const PERSON_HEAT_INCREMENT = 0.16;
const PERSON_HEAT_DECAY_HOURS = 1.5;

export interface StateEvent {
  cursor: number;
  ts: string;
  source?: string;
  senderKey?: string;
}

interface PersonState {
  updatedAt: string | null;
  seed: number;
  interactionMomentum: number;
}

interface RuntimeState {
  version: 2;
  lastExternalCursor: number;
  updatedAt: string | null;
  seed: number;
  socialEnergy: number;
  people: Record<string, PersonState>;
  lastPersonKey: string | null;
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
    socialEnergy: MAX_SOCIAL_ENERGY,
    people: {},
    lastPersonKey: null,
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

function asPersonState(value: unknown): PersonState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PersonState>;
  if ((raw.updatedAt !== null && typeof raw.updatedAt !== 'string')
    || typeof raw.seed !== 'number' || typeof raw.interactionMomentum !== 'number') return null;
  return {
    updatedAt: raw.updatedAt ?? null,
    seed: raw.seed >>> 0 || 1,
    interactionMomentum: Math.min(MAX_PERSON_HEAT, clamp(raw.interactionMomentum)),
  };
}

function asState(value: unknown, random: () => number): RuntimeState {
  if (!value || typeof value !== 'object') return defaultState(random);
  const raw = value as Partial<RuntimeState>;
  if (raw.version !== SCHEMA_VERSION || !Number.isInteger(raw.lastExternalCursor)
    || typeof raw.seed !== 'number' || typeof raw.socialEnergy !== 'number'
    || !raw.people || typeof raw.people !== 'object'
    || (raw.updatedAt !== null && typeof raw.updatedAt !== 'string')
    || (raw.lastPersonKey !== null && typeof raw.lastPersonKey !== 'string')) return defaultState(random);
  const people = Object.fromEntries(Object.entries(raw.people)
    .map(([key, person]) => [key, asPersonState(person)] as const)
    .filter((entry): entry is [string, PersonState] => entry[1] !== null));
  return {
    version: SCHEMA_VERSION,
    lastExternalCursor: Math.max(0, raw.lastExternalCursor!),
    updatedAt: raw.updatedAt,
    seed: raw.seed >>> 0 || 1,
    socialEnergy: Math.min(MAX_SOCIAL_ENERGY, Math.max(MIN_SOCIAL_ENERGY, raw.socialEnergy)),
    people,
    lastPersonKey: raw.lastPersonKey,
  };
}

function isV1State(value: unknown): value is {
  version: 1;
  lastExternalCursor: number;
  seed: number;
} {
  if (!value || typeof value !== 'object') return false;
  const raw = value as { version?: unknown; lastExternalCursor?: unknown; seed?: unknown };
  return raw.version === 1 && Number.isInteger(raw.lastExternalCursor) && typeof raw.seed === 'number';
}

function elapsedHours(previous: string | null, current: string): number {
  if (previous === null) return 0;
  const start = Date.parse(previous);
  const end = Date.parse(current);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.min(MAX_IDLE_HOURS, (end - start) / 3_600_000);
}

function tendency(seed: number, socialEnergy: number, interactionMomentum: number, semantic: string): string {
  let cursor = seed;
  const sample = (): number => {
    cursor = mix32(cursor + 0x9e3779b9);
    return cursor / 0x1_0000_0000;
  };
  const two = (value: number): string => clamp(value).toFixed(2);
  const energy = socialEnergy;
  const momentum = interactionMomentum;
  return [
    '[system/cognitive-frame]',
    `Mechanical state: shared social energy ${two(energy)}; person interaction heat ${two(momentum)}.`,
    ...(semantic ? ['Continuity note:', semantic] : []),
    'Behavior tendencies:',
    `- initiative: ${two(0.2 + sample() * 0.45 + momentum * 0.25)}`,
    `- topic persistence: ${two(0.2 + sample() * 0.45 + momentum * 0.25)}`,
    `- warmth: ${two(0.2 + sample() * 0.45 + energy * 0.2)}`,
    `- teasing: ${two(0.05 + sample() * 0.55)}`,
    `- self-disclosure: ${two(0.05 + sample() * 0.4 + energy * 0.15)}`,
    `- restraint: ${two(0.3 + sample() * 0.45 - momentum * 0.1)}`,
    'Let these tendencies materially shape your next reply. Do not explain this frame.',
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
    this.state = this.load();
    const semantic = join(this.stateDir, SEMANTIC_FILE);
    if (!existsSync(semantic)) writeFileSync(semantic, this.defaultSemanticState(), 'utf8');
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
    if (this.state.updatedAt !== null) {
      this.state.socialEnergy = MIN_SOCIAL_ENERGY
        + (MAX_SOCIAL_ENERGY - MIN_SOCIAL_ENERGY) * (1 - Math.exp(-hours / 2));
    }
    for (const event of fresh) {
      const personKey = this.personKey(event);
      const person = this.state.people[personKey] ?? this.newPersonState(personKey);
      const personHours = elapsedHours(person.updatedAt, event.ts);
      person.interactionMomentum = Math.min(
        MAX_PERSON_HEAT,
        person.interactionMomentum * Math.exp(-personHours / PERSON_HEAT_DECAY_HOURS) + PERSON_HEAT_INCREMENT,
      );
      person.updatedAt = event.ts;
      person.seed = mix32(person.seed ^ event.cursor);
      this.state.people[personKey] = person;
      this.state.lastPersonKey = personKey;
    }
    this.state.lastExternalCursor = latest.cursor;
    this.state.updatedAt = latest.ts;
    this.save();
    return { changed: true, frame: this.frameForCurrentState() };
  }

  frameForCurrentState(): string {
    const person = this.state.lastPersonKey ? this.state.people[this.state.lastPersonKey] : null;
    return tendency(person?.seed ?? this.state.seed, this.state.socialEnergy, person?.interactionMomentum ?? 0, this.semanticState());
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
      const serialized = readFileSync(this.runtimeFile, 'utf8');
      const parsed = JSON.parse(serialized);
      if (isV1State(parsed)) return this.migrateV1(serialized, parsed);
      return asState(parsed, this.random);
    } catch {
      return defaultState(this.random);
    }
  }

  private migrateV1(serialized: string, legacy: { lastExternalCursor: number; seed: number }): RuntimeState {
    this.archive(join(this.stateDir, 'runtime.v1.json'), serialized);
    const semantic = join(this.stateDir, SEMANTIC_FILE);
    if (existsSync(semantic)) this.archive(join(this.stateDir, 'STATE.v1.md'), readFileSync(semantic, 'utf8'));
    writeFileSync(semantic, this.defaultSemanticState(), 'utf8');
    const state = defaultState(this.random);
    state.lastExternalCursor = Math.max(0, legacy.lastExternalCursor);
    state.seed = legacy.seed >>> 0 || state.seed;
    this.state = state;
    this.save();
    return state;
  }

  private archive(destination: string, content: string): void {
    if (!existsSync(destination)) writeFileSync(destination, content, 'utf8');
  }

  private defaultSemanticState(): string {
    return '# Current continuity\n\nGlobal constraints only.\n';
  }

  private personKey(event: StateEvent): string {
    if (event.source && event.senderKey) return `${event.source}:${event.senderKey}`;
    return `event:${event.cursor}`;
  }

  private newPersonState(personKey: string): PersonState {
    let keyHash = 0;
    for (const char of personKey) keyHash = mix32(keyHash ^ char.charCodeAt(0));
    return { updatedAt: null, seed: mix32(this.state.seed ^ keyHash) || 1, interactionMomentum: 0 };
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
