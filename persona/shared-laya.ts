import { normalize } from 'node:path';

export interface SharedLayaModel {
  systemOne(state: unknown, questions: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface SharedLayaClient {
  systemOne(state: unknown, questions: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

interface Entry {
  model: Promise<SharedLayaModel> | null;
  closing: Promise<void> | null;
  active: number;
  queue: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  owners: Map<symbol, () => number>;
}

class LayaPool {
  private readonly entries = new Map<string, Entry>();

  create(
    key: string,
    load: () => Promise<SharedLayaModel>,
    idleTtlMinutes: () => number,
  ): SharedLayaClient {
    const entry = this.entries.get(key) ?? {
      model: null, closing: null, active: 0, queue: Promise.resolve(),
      timer: null, owners: new Map<symbol, () => number>(),
    };
    this.entries.set(key, entry);
    const owner = Symbol(key);
    entry.owners.set(owner, idleTtlMinutes);
    let disposed = false;
    return {
      systemOne: async (state, questions) => {
        if (disposed) throw new Error('Laya client is closed');
        entry.active++;
        this.clearTimer(entry);
        const previous = entry.queue;
        let releaseQueue!: () => void;
        entry.queue = new Promise<void>((resolve) => { releaseQueue = resolve; });
        try {
          await previous;
          const model = await this.load(entry, load);
          return await model.systemOne(state, questions);
        } finally {
          releaseQueue();
          entry.active--;
          if (entry.active === 0) await this.schedule(key, entry);
        }
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        entry.owners.delete(owner);
        if (entry.active === 0) await this.schedule(key, entry);
      },
    };
  }

  private async load(entry: Entry, loader: () => Promise<SharedLayaModel>): Promise<SharedLayaModel> {
    if (entry.closing) await entry.closing;
    if (!entry.model) {
      const loading = loader();
      entry.model = loading;
      void loading.catch(() => { if (entry.model === loading) entry.model = null; });
    }
    return entry.model;
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }

  private async schedule(key: string, entry: Entry): Promise<void> {
    this.clearTimer(entry);
    const ttl = Math.max(0, ...[...entry.owners.values()].map((read) => read()));
    if (entry.owners.size === 0 || ttl === 0) {
      await this.release(key, entry);
      return;
    }
    entry.timer = setTimeout(() => { void this.release(key, entry); }, ttl * 60_000);
    entry.timer.unref();
  }

  private async release(key: string, entry: Entry): Promise<void> {
    this.clearTimer(entry);
    if (entry.active > 0) return;
    const model = entry.model;
    entry.model = null;
    if (model) {
      const closing = model.then((loaded) => loaded.close()).catch(() => undefined);
      entry.closing = closing;
      await closing;
      if (entry.closing === closing) entry.closing = null;
    } else if (entry.closing) {
      await entry.closing;
    }
    if (entry.owners.size === 0 && entry.active === 0 && !entry.model) this.entries.delete(key);
  }
}

const POOL = Symbol.for('cortico.local-laya.pool.v1');

export function sharedLayaPool(): LayaPool {
  const holder = globalThis as unknown as Record<symbol, LayaPool | undefined>;
  return holder[POOL] ??= new LayaPool();
}

export function isolatedLayaPool(): LayaPool {
  return new LayaPool();
}

export function layaRuntimeKey(variant: 'english' | 'multilingual', pythonExecutable = ''): string {
  if (variant === 'english') return 'english:@receptron/laya@0.1.2';
  const path = normalize(pythonExecutable);
  return `multilingual:convaiinnovations/laya:${process.platform === 'win32' ? path.toLowerCase() : path}`;
}
