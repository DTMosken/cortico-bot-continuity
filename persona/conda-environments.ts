import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';

export interface CondaPythonOption {
  value: string;
  label: string;
}

/** Conda 登记的环境目录筛成可直接启动的 Python 解释器。 */
export function listCondaPythonOptions(
  manifest: string,
  exists: (path: string) => boolean = existsSync,
  targetPlatform: NodeJS.Platform = platform(),
): CondaPythonOption[] {
  const executable = targetPlatform === 'win32' ? 'python.exe' : join('bin', 'python');
  const seen = new Set<string>();
  const out: CondaPythonOption[] = [];
  for (const line of manifest.split(/\r?\n/u)) {
    const prefix = line.trim();
    if (!prefix || seen.has(prefix)) continue;
    seen.add(prefix);
    const pythonExecutable = join(prefix, executable);
    if (!exists(pythonExecutable)) continue;
    out.push({ value: pythonExecutable, label: `${basename(prefix)} · ${prefix}` });
  }
  return out;
}

/** 读取 Conda 的本机环境清单；清单缺失或不可读时返回空表。 */
export function discoverCondaPythonOptions(): CondaPythonOption[] {
  try {
    return listCondaPythonOptions(readFileSync(join(homedir(), '.conda', 'environments.txt'), 'utf8'));
  } catch {
    return [];
  }
}
