/** The child owns drafting and fixture tools; model connections stay in the host. */
import type { WorkerHost } from '../subagents/runtime.ts';
import type { ResponseClient } from 'cortico/core/generation.ts';
import { runMigrationWorker } from './worker.ts';
import type { FromChild, ToChild } from './contracts.ts';

let seq = 0, started = false;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const controller = new AbortController();
const send = (value: FromChild) => { if (process.connected) process.send!(value); };
/** Disconnect only after the final result has been flushed to the host. */
const finish = (value: FromChild) => { if (process.connected) process.send!(value, () => { if (process.connected) process.disconnect(); }); };
function request(method: 'generate' | 'review', args: unknown): Promise<unknown> {
  if (!process.connected) return Promise.reject(new Error('Migration host disconnected'));
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ kind: 'request', id, method, args }); });
}
process.on('disconnect', () => {
  controller.abort();
  for (const item of pending.values()) item.reject(new Error('Migration host disconnected'));
  pending.clear();
});
process.on('message', (value: ToChild) => {
  if (value.kind === 'reply') {
    const item = pending.get(value.id); pending.delete(value.id);
    if (value.error) item?.reject(new Error(value.error)); else item?.resolve(value.value);
    return;
  }
  if (started || value.kind !== 'init') return;
  started = true;
  // runWorker uses only this telemetry surface and blob interning. Migration tools return text.
  const core: WorkerHost = { sessions: { open: () => ({ id: 'state-migration', recordAttempts: () => {}, close: () => {} }) },
    internBlobs: () => { throw new Error('Migration tools cannot produce binary attachments'); } };
  const llm = { respond: (input: unknown, options: { context: unknown }) => request('generate', { input, context: options.context }) } as ResponseClient;
  void runMigrationWorker(value.input, { core, llm, signal: controller.signal,
    progress: progress => send({ kind: 'progress', value: progress }),
    review: (action, constraints, history) => request('review', { action, constraints, history }),
  }).then(candidate => finish({ kind: 'candidate', value: candidate }), error => finish({ kind: 'failed', error: String(error) }));
});
