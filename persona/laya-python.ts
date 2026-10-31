import { spawn, type SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { LayaModel } from './shared-laya.ts';

interface WorkerProcess {
  readonly stdin: { write(line: string): boolean; end(): void; on(event: 'error', listener: () => void): unknown };
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  once(event: 'error' | 'close', listener: (value?: unknown) => void): unknown;
  kill(): unknown;
}

export interface MultilingualLayaOptions {
  pythonExecutable: string;
}

export type SpawnMultilingualWorker = (command: string, args: string[], options: SpawnOptions) => WorkerProcess;

const workerFile = fileURLToPath(new URL('../python/laya_multilingual_worker.py', import.meta.url));
// First start may download the checkpoint; a single local inference normally takes seconds.
export const READY_TIMEOUT_MS = 15 * 60_000;
export const REQUEST_TIMEOUT_MS = 60_000;
const STDERR_TAIL_CHARS = 4096;

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class LocalMultilingualLaya implements LayaModel {
  private readonly pending = new Map<string, Pending>();
  private readonly exited: Promise<void>;
  private buffer = '';
  private stderr = '';
  private nextId = 0;
  private closed = false;
  private failure: Error | null = null;

  constructor(private readonly worker: WorkerProcess) {
    this.exited = new Promise((resolve) => {
      worker.once('close', () => {
        this.fail('multilingual Laya worker exited');
        resolve();
      });
      worker.once('error', () => {
        this.fail('multilingual Laya worker could not start');
        resolve();
      });
    });
    // A write after the worker died but before close raises EPIPE; close reports the failure, this only keeps the host alive.
    worker.stdin.on('error', () => {});
    worker.stdout.on('data', (chunk) => this.receive(chunk));
    worker.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
  }

  get available(): boolean {
    return !this.closed && !this.failure;
  }

  async waitUntilReady(): Promise<void> {
    await this.track('ready', READY_TIMEOUT_MS, `multilingual Laya worker was not ready within ${READY_TIMEOUT_MS / 60_000} minutes`);
  }

  async systemOne(state: unknown, questions: unknown): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('multilingual Laya worker is closed');
    const id = String(++this.nextId);
    const result = this.track(id, REQUEST_TIMEOUT_MS, `multilingual Laya request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`);
    this.worker.stdin.write(`${JSON.stringify({ id, state, questions })}\n`);
    return result;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.worker.stdin.end();
    }
    return this.exited;
  }

  private track(id: string, timeoutMs: number, timeoutMessage: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.abort(timeoutMessage), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
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
      this.abort('multilingual Laya worker returned an invalid response');
      return;
    }
    const id = message.type === 'ready' ? 'ready' : message.id;
    if (typeof id !== 'string') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.type === 'ready' || message.ok === true) pending.resolve(message.result);
    else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'multilingual Laya worker rejected the request'));
  }

  private abort(message: string): void {
    this.worker.kill();
    this.fail(message);
  }

  private fail(message: string): void {
    const tail = this.stderr.trim();
    const error = new Error(tail ? `${message}\n${tail}` : message);
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function startMultilingualLaya(
  options: MultilingualLayaOptions,
  start: SpawnMultilingualWorker = (command, args, spawnOptions) => spawn(command, args, spawnOptions) as unknown as WorkerProcess,
): Promise<LayaModel> {
  const model = new LocalMultilingualLaya(start(options.pythonExecutable, [workerFile], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
  }));
  await model.waitUntilReady();
  return model;
}
