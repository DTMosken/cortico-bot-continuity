import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const condaCommand = process.env.CORTICO_CONDA_COMMAND ?? 'conda';
const condaEnvironment = process.argv[2] ?? process.env.CORTICO_LAYA_CONDA_ENV;
const workerFile = fileURLToPath(new URL('../python/laya_multilingual_worker.py', import.meta.url));

if (!condaEnvironment || condaEnvironment.startsWith('-')) {
  throw new Error('请将 Conda 环境名作为位置参数，例如：corepack pnpm laya:multilingual:setup tf-gpu');
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(condaCommand, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error(`could not start Conda command: ${condaCommand}`)));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Conda command exited with code ${code}`)));
  });
}

await run(['run', '--no-capture-output', '-n', condaEnvironment, 'python', '-m', 'pip', 'install', 'laya']);
await run(['run', '--no-capture-output', '-n', condaEnvironment, 'python', workerFile, '--verify']);
