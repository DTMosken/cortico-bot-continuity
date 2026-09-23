import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { listCondaPythonOptions } from '../persona/conda-environments.ts';
import { startMultilingualLaya } from '../persona/laya-python.ts';

class FakeWorker extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  readonly stdin = {
    write: (line: string) => { this.writes.push(line); return true; },
    end: () => { queueMicrotask(() => this.emit('exit', 0)); },
  };
}

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
    expect(JSON.parse(worker.writes[1] ?? '{}')).toEqual({ type: 'close' });
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
});
