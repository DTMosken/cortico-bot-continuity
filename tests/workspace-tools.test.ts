import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger } from 'cortico/core/util.ts';
import { GitWorkspaceMemory, globToRegExp } from '../base/persona/memory.ts';
import { workspaceTools } from '../base/persona/workspaceTools.ts';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (label: string) => { const dir = mkdtempSync(join(tmpdir(), `${label}-`)); roots.push(dir); return dir; };

function fixture() {
  const memory = new GitWorkspaceMemory({ memoryDir: tempDir('workspace-tools') });
  const tools = workspaceTools({ memory, writeGuard: () => null, readOverride: () => null, prefixResidentFiles: () => [] });
  const call = async (name: string, args: Record<string, unknown>) =>
    tools.find(tool => tool.name === name)!.handler(args, { role: 'main', log: nullLogger() });
  const text = async (name: string, args: Record<string, unknown>) => String(await call(name, args));
  return { memory, call, text };
}

describe('glob braces', () => {
  it('converts wildcards inside each brace alternative', () => {
    const re = globToRegExp('**/{*.md,notes/?.txt}');
    expect(re.test('a/b.md')).toBe(true);
    expect(re.test('x/notes/1.txt')).toBe(true);
    expect(re.test('x/notes/12.txt')).toBe(false);
    expect(re.test('a/b.txt')).toBe(false);
    expect(globToRegExp('{a.(md),b+}').test('a.(md)')).toBe(true);
    expect(globToRegExp('{a.(md),b+}').test('aa(md)')).toBe(false);
  });

  it('finds files with wildcard alternatives through glob_files and grep_files', async () => {
    const { memory, text } = fixture();
    memory.writeFileAtomic('note/a.md', 'needle');
    memory.writeFileAtomic('note/b.txt', 'needle');
    memory.writeFileAtomic('note/c.json', 'needle');
    const globbed = await text('glob_files', { glob_pattern: 'note/{*.md,*.txt}' });
    expect(globbed).toContain('note/a.md');
    expect(globbed).toContain('note/b.txt');
    expect(globbed).not.toContain('note/c.json');
    const grepped = await text('grep_files', { pattern: 'needle', glob: '{*.md,*.json}', output_mode: 'files_with_matches' });
    expect(grepped).toContain('note/a.md');
    expect(grepped).toContain('note/c.json');
    expect(grepped).not.toContain('note/b.txt');
  });
});

describe('listing and walking', () => {
  it('skips atomic-write temp files', async () => {
    const { memory, text } = fixture();
    memory.writeFileAtomic('note/a.md', 'needle');
    writeFileSync(join(memory.memoryDir, 'note/a.md.tmp-abc123'), 'needle');
    expect(memory.walkFiles()).toEqual(['note/a.md']);
    const listing = await text('list_files', {});
    expect(listing).toContain('note/a.md');
    expect(listing).not.toContain('.tmp-');
    expect(await text('glob_files', { glob_pattern: '*' })).not.toContain('.tmp-');
  });

  it('does not follow links, like the WebUI tree', async () => {
    const { memory, text } = fixture();
    const outside = tempDir('workspace-tools-outside');
    writeFileSync(join(outside, 'secret.md'), 'needle');
    memory.writeFileAtomic('note/a.md', 'needle');
    symlinkSync(outside, join(memory.memoryDir, 'note/out'), 'junction');
    expect(memory.walkFiles()).toEqual(['note/a.md']);
    expect(await text('list_files', {})).not.toContain('secret.md');
    expect(await text('grep_files', { pattern: 'needle' })).not.toContain('secret.md');
  });
});

describe('read_file', () => {
  it('reports only a missing file as not found and surfaces other errors', async () => {
    const { memory, text } = fixture();
    mkdirSync(join(memory.memoryDir, 'note'));
    expect(await text('read_file', { path: 'note/missing.md' })).toBe('[not found] note/missing.md');
    expect(await text('read_file', { path: 'note' })).toMatch(/^\[read failed\] note: EISDIR/);
    expect(await text('read_file', { path: '../outside.md' })).toMatch(/^\[read failed\] path escapes workspace/);
  });

  it('decides binary reads on the normalized path', async () => {
    const { memory, call } = fixture();
    memory.writeFileAtomic('x.md', 'plain text');
    memory.blobs.put('blobs/sample.bin', new Uint8Array([255, 0, 254]), 'application/octet-stream');
    expect(await call('read_file', { path: 'blobs/../x.md' })).toBe('plain text');
    expect(await call('read_file', { path: 'blobs\\sample.bin' })).toMatchObject({ text: '', blobs: [{ handle: 'mem:blobs/sample.bin' }] });
  });

  it.runIf(process.platform === 'win32')('reads a differently cased blobs folder as binary', async () => {
    const { memory, call } = fixture();
    memory.blobs.put('blobs/sample.bin', new Uint8Array([255, 0, 254]), 'application/octet-stream');
    expect(await call('read_file', { path: 'Blobs/sample.bin' })).toMatchObject({ text: '', blobs: [{ handle: 'mem:Blobs/sample.bin' }] });
  });

  it('rejects a limit below 1 for reads and line moves', async () => {
    const { memory, text } = fixture();
    memory.writeFileAtomic('note/a.md', 'one\ntwo\nthree');
    expect(await text('read_file', { path: 'note/a.md', limit: 0 })).toMatch(/^\[read failed\] limit/);
    expect(await text('read_file', { path: 'note/a.md', offset: 2, limit: -1 })).toMatch(/^\[read failed\] limit/);
    expect(await text('read_file', { path: 'note/a.md', offset: 2, limit: 1 })).toBe('[note/a.md 第 2-2 行,共 3 行]\ntwo');
    expect(await text('move_file', { from: 'note/a.md', to: 'note/b.md', offset: 1, limit: 0 })).toMatch(/^\[move failed\] limit/);
    expect(memory.readFile('note/a.md')).toBe('one\ntwo\nthree');
    expect(memory.exists('note/b.md')).toBe(false);
  });
});

it('moves a file into a folder named with a trailing backslash', async () => {
  const { memory, text } = fixture();
  memory.writeFileAtomic('a.md', 'A');
  expect(await text('move_file', { from: 'a.md', to: 'archive\\' })).toBe('[moved] a.md → archive/a.md');
  expect(readFileSync(join(memory.memoryDir, 'archive/a.md'), 'utf8')).toBe('A');
});

it('merges grep context of adjacent hits without repeating lines', async () => {
  const { memory, text } = fixture();
  memory.writeFileAtomic('n.md', ['a', 'hit 1', 'b', 'hit 2', 'c', 'd', 'e', 'hit 3', 'f'].join('\n'));
  expect(await text('grep_files', { pattern: 'hit', context: 1 })).toBe([
    '3 处命中,1 个文件:',
    'n.md-1- a', 'n.md:2: hit 1', 'n.md-3- b', 'n.md:4: hit 2', 'n.md-5- c',
    'n.md-7- e', 'n.md:8: hit 3', 'n.md-9- f',
  ].join('\n'));
  // 截断时最后一处交回的命中仍带完整后文;未交回的命中只作为上下文行出现,命中行数与抬头一致。
  expect(await text('grep_files', { pattern: 'hit', context: 2, head_limit: 1 })).toBe([
    '3 处命中,1 个文件,只交回前 1 处:',
    'n.md-1- a', 'n.md:2: hit 1', 'n.md-3- b', 'n.md-4- hit 2',
  ].join('\n'));
  expect(await text('grep_files', { pattern: 'hit', context: 4, head_limit: 2 })).toBe([
    '3 处命中,1 个文件,只交回前 2 处:',
    'n.md-1- a', 'n.md:2: hit 1', 'n.md-3- b', 'n.md:4: hit 2', 'n.md-5- c', 'n.md-6- d', 'n.md-7- e', 'n.md-8- hit 3',
  ].join('\n'));
});
