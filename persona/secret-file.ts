import { spawn } from 'node:child_process';
import { decodeText, isUtf16Le } from 'cortico/core/util.ts';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function ensureSecretPlaceholder(deploymentDir: string, name: string): string {
  const file = join(deploymentDir, '.env');
  const bytes = existsSync(file) ? readFileSync(file) : null;
  const contents = bytes ? decodeText(bytes) : '';
  if (!new RegExp(`^${name}=`, 'm').test(contents)) {
    const line = `${contents && !contents.endsWith('\n') ? '\n' : ''}${name}=\n`;
    if (bytes && (isUtf16Le(bytes) || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf))) {
      writeFileSync(file, contents + line, { mode: 0o600 });
    } else if (bytes) appendFileSync(file, line);
    else writeFileSync(file, line, { mode: 0o600 });
  }
  return file;
}

export function openSecretFile(file: string): Promise<void> {
  const command = process.platform === 'win32' ? 'notepad.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(command, [file], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
