import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listCondaPythonOptions } from '../persona/conda-environments.ts';
import { READY_TIMEOUT_MS, REQUEST_TIMEOUT_MS, startMultilingualLaya, type SpawnMultilingualWorker } from '../persona/laya-python.ts';
import { isolatedLayaPool } from '../persona/shared-laya.ts';

class FakeWorker extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  ended = false;
  killed = false;
  readonly stdin = {
    write: (line: string) => { this.writes.push(line); return true; },
    end: () => { this.ended = true; queueMicrotask(() => this.emit('close', 0)); },
  };
  kill(): void { this.killed = true; queueMicrotask(() => this.emit('close', null)); }
}

/** Runs a Node script in place of the Python worker, over real pipes. */
const nodeWorker = (script: string): SpawnMultilingualWorker =>
  (_command, _args, options) => spawn(process.execPath, ['-e', script], options) as unknown as ReturnType<SpawnMultilingualWorker>;
const ready = `const fs = require('fs'); fs.writeSync(1, '{"type":"ready"}\\n');`;
const onRequest = (body: string) => `require('readline').createInterface({ input: process.stdin }).on('line', (line) => { const { id } = JSON.parse(line); ${body} });`;
const answer = `fs.writeSync(1, JSON.stringify({ id, ok: true, result: 'ok' }) + '\\n');`;
const python = { pythonExecutable: 'python' };

afterEach(() => vi.useRealTimers());

describe('multilingual Python Laya', () => {
  it('lists installed Conda environments as verified Python executables', () => {
    const paths = new Set([
      'D:\\ProgramData\\anaconda3\\python.exe',
      'D:\\ProgramData\\anaconda3\\envs\\tf-gpu\\python.exe',
    ]);

    expect(listCondaPythonOptions(
      'D:\\ProgramData\\anaconda3\nD:\\ProgramData\\anaconda3\\envs\\tf-gpu\nD:\\missing',
      (path) => paths.has(path),
      'win32',
    )).toEqual([
      { value: 'D:\\ProgramData\\anaconda3\\python.exe', label: 'anaconda3 · D:\\ProgramData\\anaconda3' },
      { value: 'D:\\ProgramData\\anaconda3\\envs\\tf-gpu\\python.exe', label: 'tf-gpu · D:\\ProgramData\\anaconda3\\envs\\tf-gpu' },
    ]);
  });

  it('uses the configured Python executable and exchanges only JSONL with the local worker', async () => {
    const worker = new FakeWorker();
    let command: string | undefined;
    let args: string[] | undefined;
    let env: NodeJS.ProcessEnv | undefined;
    const modelPromise = startMultilingualLaya(
      { pythonExecutable: 'D:\\ProgramData\\anaconda3\\envs\\tf-gpu\\python.exe' },
      (receivedCommand, receivedArgs, options) => {
        command = receivedCommand;
        args = receivedArgs;
        env = options.env;
        queueMicrotask(() => worker.stdout.emit('data', Buffer.from('{"type":"ready"}\n')));
        return worker;
      },
    );

    const model = await modelPromise;
    const resultPromise = model.systemOne(
      { message: '只应发送给本地 worker 的文本。' },
      { initiative: { type: 'noul', instructions: 'Is an active reply invited?' } },
    );
    const request = JSON.parse(worker.writes[0] ?? '{}') as { id?: string; state?: unknown };
    worker.stdout.emit('data', Buffer.from(`${JSON.stringify({
      id: request.id,
      ok: true,
      result: { answers: { initiative: { noul: 0.5 } } },
    })}\n`));

    await expect(resultPromise).resolves.toEqual({ answers: { initiative: { noul: 0.5 } } });
    expect(command).toBe('D:\\ProgramData\\anaconda3\\envs\\tf-gpu\\python.exe');
    expect(args).toHaveLength(1);
    expect(args?.[0]).toContain('laya_multilingual_worker.py');
    expect(env?.PYTHONIOENCODING).toBe('utf-8');
    expect(request.state).toEqual({ message: '只应发送给本地 worker 的文本。' });

    await model.close();
    expect(worker.ended).toBe(true);
    expect(worker.writes).toHaveLength(1);
  });

  it('reports a rejected worker request with its local error text', async () => {
    const worker = new FakeWorker();
    const modelPromise = startMultilingualLaya(
      { pythonExecutable: 'D:\\ProgramData\\anaconda3\\envs\\tf-gpu\\python.exe' },
      () => {
        queueMicrotask(() => worker.stdout.emit('data', Buffer.from('{"type":"ready"}\n')));
        return worker;
      },
    );

    const model = await modelPromise;
    const result = model.systemOne({ message: 'test' }, {});
    const request = JSON.parse(worker.writes[0] ?? '{}') as { id: string };
    worker.stdout.emit('data', Buffer.from(JSON.stringify({
      id: request.id,
      ok: false,
      error: 'TypeError: incompatible question',
    }) + '\n'));

    await expect(result).rejects.toThrow('TypeError: incompatible question');
    await model.close();
  });

  it('rejects later requests after the worker crashes and the shared pool starts a new worker', async () => {
    const crash = nodeWorker(`${ready} ${onRequest(`fs.writeSync(2, 'RuntimeError: worker crashed\\n'); process.exit(3);`)}`);
    const model = await startMultilingualLaya(python, crash);
    await expect(model.systemOne('state', {})).rejects.toThrow(/worker exited\nRuntimeError: worker crashed/);
    expect(model.available).toBe(false);
    await expect(model.systemOne('state', {})).rejects.toThrow('RuntimeError: worker crashed');

    const workers = [crash, nodeWorker(`${ready} ${onRequest(answer)}`)];
    const client = isolatedLayaPool().create('multilingual:test', () => startMultilingualLaya(python, workers.shift()!), () => 5);
    await expect(client.systemOne('state', {})).rejects.toThrow('worker crashed');
    await expect(client.systemOne('state', {})).resolves.toBe('ok');
    await client.dispose();
  });

  it('keeps answering while the worker writes megabytes to stderr', async () => {
    const noisy = `fs.writeSync(2, 'x'.repeat(1 << 20));`;
    const model = await startMultilingualLaya(python, nodeWorker(`${ready.replace('fs.writeSync(1', `${noisy} fs.writeSync(1`)} ${onRequest(`${noisy} ${answer}`)}`));
    await expect(model.systemOne('state', {})).resolves.toBe('ok');
    await model.close();
  }, 10_000);

  it('reports the stderr tail when the worker fails to start', async () => {
    const missing = `process.stderr.write('Traceback (most recent call last):\\n' + 'x'.repeat(10_000) + "\\nModuleNotFoundError: No module named 'laya'\\n"); process.exitCode = 1;`;
    const error = await startMultilingualLaya(python, nodeWorker(missing)).then(() => new Error('started'), (reason: Error) => reason);
    expect(error.message).toMatch(/^multilingual Laya worker exited\n[\s\S]*ModuleNotFoundError: No module named 'laya'$/);
    expect(error.message.length).toBeLessThan(5_000);
  });

  it('kills the worker and rejects when startup or a request times out', async () => {
    vi.useFakeTimers();
    const silent = new FakeWorker();
    const starting = startMultilingualLaya(python, () => silent).catch((reason: Error) => reason);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect((await starting as Error).message).toContain('not ready within 15 minutes');
    expect(silent.killed).toBe(true);

    const stuck = new FakeWorker();
    queueMicrotask(() => stuck.stdout.emit('data', Buffer.from('{"type":"ready"}\n')));
    const model = await startMultilingualLaya(python, () => stuck);
    const first = model.systemOne('first', {}).catch((reason: Error) => reason);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect((await first as Error).message).toContain('timed out after 60 seconds');
    expect(stuck.killed).toBe(true);
    expect(model.available).toBe(false);
    await expect(model.systemOne('second', {})).rejects.toThrow('timed out');
  });
});
