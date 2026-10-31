import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverCondaPythonOptions, listCondaPythonOptions } from '../persona/conda-environments.ts';

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

  it('treats a missing Conda manifest as no environments and reports other read errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conda-manifest-'));
    try {
      expect(discoverCondaPythonOptions(join(dir, 'environments.txt'))).toEqual([]);
      expect(() => discoverCondaPythonOptions(dir)).toThrow(/EISDIR/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
