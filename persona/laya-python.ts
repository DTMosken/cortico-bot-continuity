import { spawn, type SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface WorkerProcess {
  readonly stdin: { write(line: string): boolean; end(): void };
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  once(event: 'error' | 'exit', listener: (value?: unknown) => void): unknown;
}

export interface MultilingualLayaModel {
  systemOne(state: unknown, questions: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface MultilingualLayaOptions {
  pythonExecutable: string;
}

export type SpawnMultilingualWorker = (command: string, args: string[], options: SpawnOptions) => WorkerProcess;

const workerFile = fileURLToPath(new URL('../python/laya_multilingual_worker.py', import.meta.url));

class LocalMultilingualLaya implements MultilingualLayaModel {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(reason: Error): void }>();
  private readonly exited: Promise<void>;
  private buffer = '';
  private nextId = 0;
  private closed = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((reason: Error) => void) | null = null;

  constructor(private readonly worker: WorkerProcess) {
    this.exited = new Promise((resolve) => {
      worker.once('exit', () => {
        this.fail(new Error('multilingual Laya worker exited'));
        resolve();
      });
    });
    worker.once('error', () => this.fail(new Error('multilingual Laya worker could not start')));
    worker.stdout.on('data', (chunk) => this.receive(chunk));
  }

  waitUntilReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  async systemOne(state: unknown, questions: unknown): Promise<unknown> {
    if (this.closed) throw new Error('multilingual Laya worker is closed');
    const id = String(++this.nextId);
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.stdin.write(`${JSON.stringify({ id, state, questions })}\n`);
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return this.exited;
    this.closed = true;
    this.worker.stdin.write(`${JSON.stringify({ type: 'close' })}\n`);
    this.worker.stdin.end();
    return this.exited;
  }

  private receive(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let boundary = this.buffer.indexOf('\n');
    while (boundary >= 0) {
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      this.receiveLine(line);
      boundary = this.buffer.indexOf('\n');
    }
  }

  private receiveLine(line: string): void {
    let message: { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.fail(new Error('multilingual Laya worker returned an invalid response'));
      return;
    }
    if (message.type === 'ready') {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (typeof message.id !== 'string') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'multilingual Laya worker rejected the request'));
  }

  private fail(error: Error): void {
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export async function startMultilingualLaya(
  options: MultilingualLayaOptions,
  start: SpawnMultilingualWorker = (command, args, spawnOptions) => spawn(command, args, spawnOptions) as unknown as WorkerProcess,
): Promise<MultilingualLayaModel> {
  const model = new LocalMultilingualLaya(start(options.pythonExecutable, [workerFile], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }));
  await model.waitUntilReady();
  return model;
}
