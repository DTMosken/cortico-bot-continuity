import { describe, expect, it } from 'vitest';
import { listCondaPythonOptions } from '../persona/conda-environments.ts';

describe('Conda environment paths', () => {
  it.each(['linux', 'darwin'] as const)('uses POSIX Python paths for %s, deduplicating environments and omitting missing executables', (targetPlatform) => {
    const executables = new Set(['/opt/conda/bin/python', '/opt/conda/envs/worker/bin/python']);
    expect(listCondaPythonOptions(
      '/opt/conda\n/opt/conda/envs/worker\n/opt/conda\n/opt/missing\n',
      (path) => executables.has(path),
      targetPlatform,
    )).toEqual([
      { value: '/opt/conda/bin/python', label: 'conda · /opt/conda' },
      { value: '/opt/conda/envs/worker/bin/python', label: 'worker · /opt/conda/envs/worker' },
    ]);
  });
});
