import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const condaCommand = process.env.CORTICO_CONDA_COMMAND ?? process.env.CONDA_EXE ?? 'conda';
// Without CONDA_EXE, Windows finds conda only as conda.bat through the shell.
const viaShell = process.platform === 'win32' && condaCommand === 'conda';
const condaEnvironment = process.argv[2] ?? process.env.CORTICO_LAYA_CONDA_ENV;
const workerFile = fileURLToPath(new URL('../python/laya_multilingual_worker.py', import.meta.url));

if (!condaEnvironment || condaEnvironment.startsWith('-')) {
  throw new Error('请将 Conda 环境名作为位置参数，例如：corepack pnpm laya:multilingual:setup tf-gpu');
}

// cmd treats & | < > ^ ( ) literally only inside double quotes. It still expands % there and cannot escape " within /c.
function shellLine(args) {
  const unsafe = args.find((arg) => /["%]/u.test(arg));
  if (unsafe !== undefined) throw new Error(`经 shell 调用 conda 时参数不能含 " 或 %：${unsafe}；请设置 CONDA_EXE 后重试`);
  return [condaCommand, ...args.map((arg) => `"${arg}"`)].join(' ');
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = viaShell
      ? spawn(shellLine(args), { stdio: 'inherit', windowsHide: true, shell: true })
      : spawn(condaCommand, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', () => reject(new Error(`could not start Conda command: ${condaCommand}`)));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Conda command exited with code ${code}`)));
  });
}

await run(['run', '--no-capture-output', '-n', condaEnvironment, 'python', '-m', 'pip', 'install', 'laya']);
await run(['run', '--no-capture-output', '-n', condaEnvironment, 'python', workerFile, '--verify']);
