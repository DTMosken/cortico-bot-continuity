import { existsSync } from 'node:fs';
import { readTextFile } from 'cortico/core/util.ts';
import { homedir, platform } from 'node:os';
import { join, posix, win32 } from 'node:path';

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
  const paths = targetPlatform === 'win32' ? win32 : posix;
  const executable = targetPlatform === 'win32' ? 'python.exe' : paths.join('bin', 'python');
  const seen = new Set<string>();
  const out: CondaPythonOption[] = [];
  for (const line of manifest.split(/\r?\n/u)) {
    const prefix = line.trim();
    if (!prefix || seen.has(prefix)) continue;
    seen.add(prefix);
    const pythonExecutable = paths.join(prefix, executable);
    if (!exists(pythonExecutable)) continue;
    out.push({ value: pythonExecutable, label: `${paths.basename(prefix)} · ${prefix}` });
  }
  return out;
}

/** 读取 Conda 的本机环境清单；未安装 Conda（清单不存在）时返回空表，其他读取错误照常抛出。 */
export function discoverCondaPythonOptions(manifestPath = join(homedir(), '.conda', 'environments.txt')): CondaPythonOption[] {
  let manifest: string;
  try {
    manifest = readTextFile(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return listCondaPythonOptions(manifest);
}
