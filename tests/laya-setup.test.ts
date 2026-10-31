import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const spawned: Array<{ command: string; args?: string[]; options: { shell?: boolean } }> = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, ...rest: unknown[]) => {
    const [args, options] = Array.isArray(rest[0]) ? rest as [string[], { shell?: boolean }] : [undefined, rest[0] as { shell?: boolean }];
    spawned.push({ command, args, options });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0));
    return child;
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const argv = process.argv;
const env = { ...process.env };
beforeEach(() => {
  spawned.length = 0; vi.resetModules();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  delete process.env.CONDA_EXE; delete process.env.CORTICO_CONDA_COMMAND;
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  process.argv = argv; process.env = { ...env };
});
const SETUP_MODULE = '../scripts/laya-multilingual-setup.mjs';
const setup = (environment: string) => {
  process.argv = [argv[0], 'laya-multilingual-setup.mjs', environment];
  return import(SETUP_MODULE);
};

it('double-quotes every argument when Windows runs conda through cmd', async () => {
  await setup('research&dev');
  expect(spawned).toHaveLength(2);
  for (const call of spawned) { expect(call.options.shell).toBe(true); expect(call.args).toBeUndefined(); }
  expect(spawned[0].command).toBe('conda "run" "--no-capture-output" "-n" "research&dev" "python" "-m" "pip" "install" "laya"');
  expect(spawned[1].command).toMatch(/^conda "run" "--no-capture-output" "-n" "research&dev" "python" ".+laya_multilingual_worker\.py" "--verify"$/u);
});

it.each(['say"hi', '50%off'])('refuses %s on the cmd path before starting conda', async (environment) => {
  await expect(setup(environment)).rejects.toThrow('参数不能含 " 或 %');
  expect(spawned).toHaveLength(0);
});

it('passes arguments unchanged when CONDA_EXE is set', async () => {
  process.env.CONDA_EXE = 'C:/conda/Scripts/conda.exe';
  await setup('50%off');
  expect(spawned[0]).toMatchObject({ command: 'C:/conda/Scripts/conda.exe', args: ['run', '--no-capture-output', '-n', '50%off', 'python', '-m', 'pip', 'install', 'laya'] });
});
