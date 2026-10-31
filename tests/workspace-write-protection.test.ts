import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreApi } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { composeDefaults } from '../index.ts';
import { GitWorkspaceMemory, writeBlockReason } from '../base/persona/memory.ts';
import { workspaceInvoke } from '../base/persona/webUiSurface.ts';
import { AUTHOR_SELF } from '../base/persona/workspaceGit.ts';
import { ContinuityPersona } from '../persona/index.ts';

const roots: string[] = [], stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (label: string) => { const dir = mkdtempSync(join(tmpdir(), `${label}-`)); roots.push(dir); return dir; };

function persona() {
  const p = new ContinuityPersona({ cfg: composeDefaults(), memoryDir: tempDir('write-protect') });
  stops.push(() => p.dispose());
  p.memory.git.ensureRepo();
  (p as unknown as { core: Partial<CoreApi> }).core = {
    blob: () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'application/octet-stream' }),
  };
  // 子代理 worker 复用主 session 的记忆工具,调用时角色是 subagent。
  const toolsFor = (role: string) => p.declareSessions().find(session => session.id === (role === 'subagent' ? 'main' : role))!.tools();
  const call = async (role: string, name: string, args: Record<string, unknown>) =>
    String(await toolsFor(role).find(tool => tool.name === name)!.handler(args, { role, log: nullLogger() }));
  const snapshot = () => Object.fromEntries(['.git/config', '.gitattributes', '.gitignore'].map(f => [f, readFileSync(join(p.memory.memoryDir, f), 'utf8')]));
  return { p, call, snapshot };
}

const HIDDEN_TARGETS = ['.git/config', '.gitattributes', '.git/hooks/post-commit', '.GIT\\hooks\\post-commit', 'note/.hidden/x.md'];

describe('dot-prefixed workspace paths are not writable by any role', () => {
  for (const role of ['main', 'dream', 'subagent']) {
    it(`rejects write, append, edit, delete and save_blob for ${role}`, async () => {
      const { p, call, snapshot } = persona();
      const before = snapshot();
      expect(await call(role, 'append_file', { path: '.git/config', content: '[core]\n\tfsmonitor = x\n' })).toContain('[append failed]');
      expect(await call(role, 'write_file', { path: '.gitattributes', content: '* filter=x\n' })).toContain('[write failed]');
      for (const path of HIDDEN_TARGETS) {
        expect(await call(role, 'write_file', { path, content: '#!/bin/sh\n' })).toContain('[write failed]');
        expect(await call(role, 'append_file', { path, content: 'x' })).toContain('[append failed]');
        expect(await call(role, 'save_blob', { handle: 'log:0123456789', path })).toContain('[save failed]');
      }
      expect(await call(role, 'edit_file', { path: '.git/config', old_string: '[core]', new_string: '[core]\n\tfsmonitor = x' })).toContain('[edit failed]');
      expect(await call(role, 'delete_file', { path: '.gitignore' })).toContain('[delete failed]');
      expect(snapshot()).toEqual(before);
      expect(existsSync(join(p.memory.memoryDir, '.git/hooks/post-commit'))).toBe(false);
      expect(existsSync(join(p.memory.memoryDir, 'note/.hidden'))).toBe(false);
    });
  }

  for (const role of ['main', 'dream']) {
    it(`rejects move_file with a dot-prefixed source or target for ${role}`, async () => {
      const { p, call, snapshot } = persona();
      p.memory.writeFileAtomic('note/a.md', '#!/bin/sh\n');
      const before = snapshot();
      expect(await call(role, 'move_file', { from: 'note/a.md', to: '.git/hooks/post-commit' })).toContain('[move failed]');
      expect(await call(role, 'move_file', { from: 'note', to: '.git/hooks/' })).toContain('[move failed]');
      expect(await call(role, 'move_file', { from: '.gitignore', to: 'note/ignore.md' })).toContain('[move failed]');
      expect(await call(role, 'move_file', { from: '.Git/config', to: 'note/config.md' })).toContain('[move failed]');
      expect(await call(role, 'move_file', { from: 'note/a.md', to: '.git/config', offset: 1 })).toContain('[move failed]');
      expect(await call(role, 'move_file', { from: '.gitattributes', to: 'note/a.md', offset: 1 })).toContain('[move failed]');
      expect(snapshot()).toEqual(before);
      expect(p.memory.readFile('note/a.md')).toBe('#!/bin/sh\n');
      expect(existsSync(join(p.memory.memoryDir, 'note/ignore.md'))).toBe(false);
      expect(existsSync(join(p.memory.memoryDir, '.git/hooks/post-commit'))).toBe(false);
    });
  }

  it('rejects dot-prefixed paths in the memory write methods themselves', () => {
    const memory = new GitWorkspaceMemory({ memoryDir: tempDir('write-protect-memory') });
    memory.writeFileAtomic('note/a.md', 'A');
    for (const path of HIDDEN_TARGETS) {
      expect(() => memory.writeFileAtomic(path, 'x')).toThrow();
      expect(() => memory.appendFile(path, 'x')).toThrow();
      expect(() => memory.renameFile('note/a.md', path)).toThrow();
      expect(() => memory.blobs.put(path, new Uint8Array([1]), 'application/octet-stream')).toThrow();
    }
    writeFileSync(join(memory.memoryDir, '.gitignore'), 'keep\n');
    expect(() => memory.deleteFile('.gitignore')).toThrow();
    expect(() => memory.renameFile('.gitignore', 'note/ignore.md')).toThrow();
    expect(readFileSync(join(memory.memoryDir, '.gitignore'), 'utf8')).toBe('keep\n');
    expect(memory.readFile('note/a.md')).toBe('A');
  });
});

/** 当前卷是否为点开头目录生成 8.3 短名(GIT~1 → .git);禁用时相关用例跳过。 */
const shortNamesAvailable = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'short-name-probe-'));
  try {
    mkdirSync(join(dir, '.git'));
    return existsSync(join(dir, 'GIT~1')) && realpathSync.native(join(dir, 'GIT~1')) === realpathSync.native(join(dir, '.git'));
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe('writes are checked against the real path', () => {
  it('allows ordinary names containing ~digit through tools and the console panel', async () => {
    const { p, call } = persona();
    expect(await call('main', 'write_file', { path: 'draft~1.md', content: 'draft' })).toContain('[written]');
    expect(await call('main', 'write_file', { path: 'note/a~2.md', content: 'a' })).toContain('[written]');
    expect(p.memory.readFile('draft~1.md')).toBe('draft');
    expect(p.memory.readFile('note/a~2.md')).toBe('a');
    const invoke = workspaceInvoke(p.memory);
    expect(await invoke('workspace', 'write', ['note/b~3.md', 'panel'])).toMatchObject({ ok: true });
    expect(await invoke('workspace', 'rename', ['note/b~3.md', 'note/c~4.md'])).toMatchObject({ ok: true });
    expect(p.memory.readFile('note/c~4.md')).toBe('panel');
    expect(p.memory.exists('note/b~3.md')).toBe(false);
  });

  it.skipIf(!shortNamesAvailable)('rejects 8.3 short names that resolve to dot-prefixed entries (skipped when the volume has no 8.3 names)', async () => {
    const { p, call, snapshot } = persona();
    const root = p.memory.memoryDir;
    expect(existsSync(join(root, 'GIT~1'))).toBe(true);
    expect(realpathSync.native(join(root, 'GIT~1'))).toBe(realpathSync.native(join(root, '.git')));
    const before = snapshot();
    // 字符串检查放行 GIT~1,拒绝理由里的实际位置来自真实路径检查。
    expect(writeBlockReason(root, 'GIT~1/config')).toContain('.git/config');
    expect(writeBlockReason(root, 'GIT~1\\hooks\\post-commit')).toContain('.git/hooks/post-commit');
    expect(await call('main', 'write_file', { path: 'GIT~1/config', content: 'x' })).toContain('[write failed]');
    expect(await call('main', 'append_file', { path: 'GIT~1/config', content: 'x' })).toContain('[append failed]');
    expect(await call('dream', 'write_file', { path: 'GIT~1\\hooks\\post-commit', content: '#!/bin/sh\n' })).toContain('[write failed]');
    expect(await call('main', 'save_blob', { handle: 'log:0123456789', path: 'GIT~1/hooks/post-commit' })).toContain('[save failed]');
    p.memory.writeFileAtomic('note/a.md', '#!/bin/sh\n');
    expect(await call('main', 'move_file', { from: 'note/a.md', to: 'GIT~1\\hooks\\post-commit' })).toContain('[move failed]');
    expect(() => p.memory.writeFileAtomic('GIT~1/config', 'x')).toThrow();
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(root, '.git/hooks/post-commit'))).toBe(false);
  });

  it.skipIf(!shortNamesAvailable)('treats GITATT~1 by what it names on disk (skipped when the volume has no 8.3 names)', () => {
    const memory = new GitWorkspaceMemory({ memoryDir: tempDir('write-protect-attr') });
    const root = memory.memoryDir;
    memory.writeFileAtomic('GITATT~1', 'plain');
    expect(readFileSync(join(root, 'GITATT~1'), 'utf8')).toBe('plain');
    expect(existsSync(join(root, '.gitattributes'))).toBe(false);
    memory.deleteFile('GITATT~1');
    writeFileSync(join(root, '.gitattributes'), '* -text\n');
    expect(realpathSync.native(join(root, 'GITATT~1'))).toBe(realpathSync.native(join(root, '.gitattributes')));
    expect(() => memory.writeFileAtomic('GITATT~1', '* filter=x\n')).toThrow();
    expect(() => memory.appendFile('GITATT~1', '* filter=x\n')).toThrow();
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toBe('* -text\n');
  });

  it('rejects writes through a link that points at .git or outside the workspace', async () => {
    const { p, call, snapshot } = persona();
    const root = p.memory.memoryDir;
    const outside = tempDir('write-protect-outside');
    mkdirSync(join(root, 'note'), { recursive: true });
    symlinkSync(join(root, '.git'), join(root, 'note/jn'), 'junction');
    symlinkSync(outside, join(root, 'note/out'), 'junction');
    try {
      const before = snapshot();
      expect(writeBlockReason(root, 'note/jn/config')).toContain('.git/config');
      expect(writeBlockReason(root, 'note/out/x.md')).not.toBeNull();
      expect(await call('main', 'append_file', { path: 'note/jn/config', content: 'x' })).toContain('[append failed]');
      expect(await call('main', 'write_file', { path: 'note/jn/hooks/post-commit', content: '#!/bin/sh\n' })).toContain('[write failed]');
      expect(await call('main', 'write_file', { path: 'note/out/x.md', content: 'x' })).toContain('[write failed]');
      expect(await call('main', 'save_blob', { handle: 'log:0123456789', path: 'note/jn/new.bin' })).toContain('[save failed]');
      expect(() => p.memory.renameFile('note/jn/config', 'note/config.md')).toThrow();
      expect(snapshot()).toEqual(before);
      expect(existsSync(join(root, '.git/hooks/post-commit'))).toBe(false);
      expect(existsSync(join(root, '.git/new.bin'))).toBe(false);
      expect(existsSync(join(outside, 'x.md'))).toBe(false);
    } finally {
      unlinkSync(join(root, 'note/jn'));
      unlinkSync(join(root, 'note/out'));
    }
  });
});

describe('save_blob checks the path it writes', () => {
  it('rejects paths that normalize into protected zones and keeps normal saves working', async () => {
    const { p, call } = persona();
    p.memory.writeFileAtomic('state/STATE.md', 'Original state.');
    p.memory.writeFileAtomic('people/a.md', 'Original person.');
    expect(await call('main', 'save_blob', { handle: 'log:0123456789', path: 'x/../state/STATE.md' })).toContain('[save failed]');
    expect(await call('main', 'save_blob', { handle: 'log:0123456789', path: 'x/../people/a.md' })).toContain('[save failed]');
    expect(await call('main', 'save_blob', { handle: 'log:0123456789', path: 'x\\..\\people\\a.md' })).toContain('[save failed]');
    expect(await call('dream', 'save_blob', { handle: 'log:0123456789', path: 'x/../.git/config' })).toContain('[save failed]');
    expect(p.memory.readFile('state/STATE.md')).toBe('Original state.');
    expect(p.memory.readFile('people/a.md')).toBe('Original person.');
    expect(await call('main', 'save_blob', { handle: 'log:0123456789', path: 'blobs/stickers/cat.bin' })).toBe('[saved] mem:blobs/stickers/cat.bin application/octet-stream 3 字节');
    const bare = p.memory.blobs.resolvePath('dog.bin');
    expect(await call('main', 'save_blob', { handle: 'log:0123456789', path: 'dog.bin' })).toBe(`[saved] mem:${bare} application/octet-stream 3 字节`);
    expect([...readFileSync(join(p.memory.memoryDir, bare))]).toEqual([1, 2, 3]);
  });
});

describe('workspace git ignores repository-controlled commands', () => {
  it('commits without running filter, fsmonitor or hook commands written straight into the repository', () => {
    const memory = new GitWorkspaceMemory({ memoryDir: tempDir('write-protect-git'), warn: () => {} });
    memory.git.ensureRepo();
    expect(memory.git.isRepo()).toBe(true);
    const outside = tempDir('write-protect-payload');
    const payload = join(outside, 'payload.cjs').replace(/\\/g, '/');
    // 只创建标记文件;作为过滤器时原样转发内容。
    writeFileSync(payload, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(outside.replace(/\\/g, '/'))} + '/marker-' + process.argv[2], 'ran');`,
      "if (process.argv[2] === 'filter') process.stdin.pipe(process.stdout);",
    ].join('\n'));
    const node = process.execPath.replace(/\\/g, '/');
    const command = (kind: string) => `\\"${node}\\" \\"${payload}\\" ${kind}`;
    const root = memory.memoryDir;
    writeFileSync(join(root, '.git/config'), readFileSync(join(root, '.git/config'), 'utf8')
      + `[filter "x"]\n\tclean = ${command('filter')}\n\tsmudge = ${command('filter')}\n\trequired = true\n`
      + `[core]\n\tfsmonitor = ${command('fsmonitor')}\n`);
    writeFileSync(join(root, '.gitattributes'), '* filter=x\n');
    mkdirSync(join(root, '.git/hooks'), { recursive: true });
    for (const hook of ['pre-commit', 'post-commit']) {
      writeFileSync(join(root, '.git/hooks', hook), `#!/bin/sh\n"${node}" "${payload}" hook\n`);
      chmodSync(join(root, '.git/hooks', hook), 0o755);
    }
    memory.writeFileAtomic('note/a.md', 'content\n');
    expect(memory.git.commitAll('note', AUTHOR_SELF)).not.toBeNull();
    memory.writeFileAtomic('note/b.md', 'more\n');
    expect(memory.git.status().dirty).toBe(true);
    expect(['filter', 'fsmonitor', 'hook'].filter(kind => existsSync(join(outside, `marker-${kind}`)))).toEqual([]);
  });

  it('commits asynchronously without running repository-controlled commands', async () => {
    const memory = new GitWorkspaceMemory({ memoryDir: tempDir('write-protect-git-async'), warn: () => {} });
    memory.git.ensureRepo();
    const outside = tempDir('write-protect-payload-async');
    const marker = join(outside, 'marker').replace(/\\/g, '/');
    const node = process.execPath.replace(/\\/g, '/');
    const command = `\\"${node}\\" -e \\"require('node:fs').writeFileSync('${marker}', 'ran'); process.stdin.pipe(process.stdout)\\"`;
    const root = memory.memoryDir;
    writeFileSync(join(root, '.git/config'), readFileSync(join(root, '.git/config'), 'utf8')
      + `[filter "a=b.c"]\n\tclean = ${command}\n[core]\n\tfsmonitor = ${command}\n`);
    writeFileSync(join(root, '.gitattributes'), '* filter=a=b.c\n');
    writeFileSync(join(root, '.git/hooks/post-commit'), `#!/bin/sh\n${command.replace(/\\"/g, '"')}\n`);
    chmodSync(join(root, '.git/hooks/post-commit'), 0o755);
    memory.writeFileAtomic('note/a.md', 'content\n');
    expect(await memory.git.commitAllAsync('note', AUTHOR_SELF)).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
});
