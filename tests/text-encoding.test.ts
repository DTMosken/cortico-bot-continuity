import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger } from 'cortico/core/util.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import { composeDefaults } from '../index.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { workspaceTools } from '../base/persona/workspaceTools.ts';
import { workspaceInvoke, type WorkspaceFile } from '../base/persona/webUiSurface.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { prepareStateAction } from '../persona/state-review.ts';
import { ensureSecretPlaceholder } from '../persona/secret-file.ts';
import { migrationHistory } from '../persona/state-migration/index.ts';

const encodings = [
  { name: 'UTF-8', encode: (text: string) => Buffer.from(text, 'utf8') },
  { name: 'UTF-8 BOM', encode: (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) },
  { name: 'UTF-16 LE', encode: (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) },
];
let dir: string;
let memory: GitWorkspaceMemory;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'continuity-text-'));
  memory = new GitWorkspaceMemory({ memoryDir: join(dir, 'memory') });
  memory.ensureDirs(['note', 'people', 'memo']);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = { role: 'dream', log: nullLogger() };
const tools = () => workspaceTools({ memory, writeGuard: () => null, readOverride: () => null, prefixResidentFiles: () => [] });
const tool = (name: string) => tools().find(item => item.name === name)!;
const textOf = (result: string | { text: string }) => typeof result === 'string' ? result : result.text;

describe.each(encodings)('$name files', ({ encode }) => {
  it('reads Memory and read_file without changing the source bytes', async () => {
    const text = '第一行🙂\n线索一\n';
    const bytes = encode(text), file = join(memory.memoryDir, 'note', 'source.md');
    writeFileSync(file, bytes);
    expect(memory.readFile('note/source.md')).toBe(text);
    const receipt = textOf(await tool('read_file').handler({ path: 'note/source.md' }, ctx));
    expect(receipt).toContain('第一行🙂');
    expect(receipt).toContain('线索一');
    expect(receipt).not.toContain('\ufeff');
    expect(readFileSync(file)).toEqual(bytes);
  });

  it('finds text in grep_files while excluding binary data', async () => {
    writeFileSync(join(memory.memoryDir, 'note', 'source.md'), encode('第一行\n线索一\n'));
    writeFileSync(join(memory.memoryDir, 'note', 'binary.bin'), Buffer.from('线索\0binary'));
    const receipt = textOf(await tool('grep_files').handler({ pattern: '线索' }, ctx));
    expect(receipt).toContain('note/source.md');
    expect(receipt).toContain('线索一');
    expect(receipt).not.toContain('binary.bin');
  });

  it('edits decoded text and writes UTF-8 without a BOM', async () => {
    const file = join(memory.memoryDir, 'note', 'source.md');
    writeFileSync(file, encode('第一行🙂\n旧线索\n'));
    const receipt = textOf(await tool('edit_file').handler({ path: 'note/source.md', old_string: '旧线索', new_string: '新线索' }, ctx));
    expect(receipt).toMatch(/^\[edited\]/);
    expect(readFileSync(file)).toEqual(Buffer.from('第一行🙂\n新线索\n'));
  });

  it.each([false, true])('appends without mixing encodings (trailing newline=%s)', async newline => {
    const file = join(memory.memoryDir, 'note', 'source.md');
    writeFileSync(file, encode('原文🙂' + (newline ? '\n' : '')));
    const receipt = textOf(await tool('append_file').handler({ path: 'note/source.md', content: '追加线索' }, ctx));
    expect(receipt).toMatch(/^\[appended\]/);
    expect(readFileSync(file)).toEqual(Buffer.from('原文🙂\n追加线索'));
  });

  it('moves decoded lines and normalizes both text files', async () => {
    writeFileSync(join(memory.memoryDir, 'note', 'source.md'), encode('保留\n移动🙂\n'));
    writeFileSync(join(memory.memoryDir, 'note', 'target.md'), encode('目标'));
    const receipt = textOf(await tool('move_file').handler({ from: 'note/source.md', to: 'note/target.md', offset: 2, limit: 1 }, ctx));
    expect(receipt).toMatch(/^\[moved\]/);
    expect(readFileSync(join(memory.memoryDir, 'note', 'source.md'))).toEqual(Buffer.from('保留\n'));
    expect(readFileSync(join(memory.memoryDir, 'note', 'target.md'))).toEqual(Buffer.from('目标\n移动🙂\n'));
  });

  it('reviews the same decoded text that append_file will modify', () => {
    const text = '当前约束🙂';
    writeFileSync(join(memory.memoryDir, 'note', 'source.md'), encode(text));
    const prepared = prepareStateAction({ memory, core: () => null, readOverride: () => null, speechContext: () => ({ recentDialogue: [] }) },
      tool('append_file'), { path: 'note/source.md', content: '新增' }, 'dream');
    expect(prepared.action).toMatchObject({ previousTail: text });
  });

  it('previews decoded WebUI text with a revision based on the original bytes', async () => {
    const text = '文件预览🙂\n', bytes = encode(text);
    writeFileSync(join(memory.memoryDir, 'note', 'source.md'), bytes);
    const file = await workspaceInvoke(memory)('workspace', 'read', ['note/source.md']) as WorkspaceFile;
    expect(file.content).toBe(text);
    expect(file.revision).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(file.size).toBe(bytes.length);
    memory.git.init();
    const invoke = workspaceInvoke(memory);
    await expect(invoke('workspace', 'write', ['note/source.md', '已保存🙂\n', file.revision])).resolves.toMatchObject({ ok: true });
    expect(readFileSync(join(memory.memoryDir, 'note', 'source.md'))).toEqual(Buffer.from('已保存🙂\n'));
    await expect(invoke('workspace', 'write', ['note/source.md', '过期修改', file.revision])).resolves.toMatchObject({ ok: false });
  });

  it('assembles the actual Persona prefix from encoded templates and Memory', async () => {
    const prompts = join(dir, 'prompts'); mkdirSync(prompts);
    const persona = new ContinuityPersona({ memoryDir: memory.memoryDir, cfg: composeDefaults(), promptsDir: prompts });
    try {
      writeFileSync(join(prompts, 'ORIENTATION.md'), encode('方向🙂'));
      writeFileSync(join(prompts, 'PREFIX.md'), encode('━━━ Test ━━━\n{{persona.orientation}}\n{{persona.constitution}}\n{{memory.all}}'));
      writeFileSync(join(prompts, 'MEMORY.md'), encode('{{memory.worldview}}\n{{memory.roster}}\n{{memory.memoResident}}'));
      writeFileSync(join(memory.memoryDir, 'CONSTITUTION.md'), encode('长期原则🙂'));
      writeFileSync(join(memory.memoryDir, 'WORLDVIEW.md'), encode('世界判断🙂'));
      writeFileSync(join(memory.memoryDir, 'people', '同伴.md'), encode('同伴：旧友🙂\n补充记录'));
      writeFileSync(join(memory.memoryDir, 'memo', 'today.md'), encode('待办🙂'));
      const prefix = (await persona.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] })).map(segment => segment.text).join('');
      for (const text of ['方向🙂', '长期原则🙂', '世界判断🙂', '同伴：旧友🙂', '待办🙂']) expect(prefix).toContain(text);
      expect(prefix).not.toContain('\ufeff');
    } finally { await persona.dispose(); }
  });

  it('adds a missing secret placeholder without duplicates or mixed encodings', () => {
    const file = join(dir, '.env'), bytes = encode('EXISTING=fixture\n');
    writeFileSync(file, bytes);
    ensureSecretPlaceholder(dir, 'EXISTING');
    expect(readFileSync(file)).toEqual(bytes);
    ensureSecretPlaceholder(dir, 'ADDED');
    expect(readFileSync(file)).toEqual(Buffer.from('EXISTING=fixture\nADDED=\n'));
  });

  it('loads retained JSON materials as readable migration history', async () => {
    const raw = join(dir, 'continuity', 'dream', 'raw'); mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, 'fixture.json'), encode(JSON.stringify([message('user', '历史材料🙂')])));
    const history = await migrationHistory(dir);
    expect(history).toHaveLength(1);
    expect(history[0].text).toContain('历史材料🙂');
    expect(history[0].text).not.toContain('\ufeff');
  });
});

it('continues to reject binary files in the WebUI', async () => {
  writeFileSync(join(memory.memoryDir, 'note', 'binary.bin'), Buffer.from([1, 0, 2]));
  await expect(workspaceInvoke(memory)('workspace', 'read', ['note/binary.bin'])).rejects.toThrow('二进制文件');
});

it('preserves attachment bytes even when they start with a text BOM', () => {
  const bytes = Buffer.from([0xff, 0xfe, 1, 0, 255]);
  const handle = memory.blobs.put('fixture.bin', bytes, 'application/octet-stream');
  expect(memory.blobs.get(handle)?.bytes).toEqual(bytes);
});
