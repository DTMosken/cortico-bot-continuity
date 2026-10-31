/**
 * 人格控制面声明局部 id 与标题；Memory 分层读数取自真目录；权限矩阵逐格执行 checkAccess 得出。
 * 工作区与版本历史两块经同一个 invoke 走服务端方法；浏览器端在 tests/workspace-panel.test.ts。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PersonaWebUiDecl } from 'cortico/core/types.ts';
import { personaWebUiDecl, personaPanels } from '../../persona/webUiSurface.ts';
import type { MemoryState } from '../../persona/webUiSurface.ts';
import { MemoTiers } from '../../persona/memoTiers.ts';
import type { PersonaRole } from '../../persona/permissions.ts';
import { GitWorkspaceMemory } from '../../base/persona/memory.ts';
import type { WorkspaceFile, WorkspaceNode } from '../../base/persona/webUiSurface.ts';
import type { CommitInfo } from '../../base/persona/workspaceGit.ts';
import { cleanup, tmpPersona, WORKSPACE_DIRS } from './helpers.ts';

let dir: string;
let decl: PersonaWebUiDecl;

const call = <T>(panel: string, method: string, args: unknown[] = []): Promise<T> =>
  decl.invoke!(panel, method, args) as Promise<T>;

beforeEach(() => {
  dir = tmpPersona();
  const memory = new GitWorkspaceMemory({ memoryDir: dir, warn: () => { /* 测试里不往控制台喊 */ } });
  memory.ensureDirs(WORKSPACE_DIRS);
  writeFileSync(join(dir, 'note', 'a.md'), '第一版\n', 'utf8');
  writeFileSync(join(dir, 'memo', 'today.md'), '今天\n', 'utf8');
  mkdirSync(join(dir, 'memo', 'active'), { recursive: true });
  writeFileSync(join(dir, 'memo', 'active', 'later.md'), '回头看\n', 'utf8');
  memory.git.init();
  decl = personaWebUiDecl({
    memory,
    memo: new MemoTiers(memory, { residentCap: 5, activeCap: 9 }),
    emergences: () => ['[surfaced from association] 一缕'],
  });
});

afterEach(() => cleanup(dir));

// ---------------------------------------------------------------------------

describe('Persona的面板声明', () => {
  it('三个面板都是局部 id + 真标题,不带 bot 名前缀', () => {
    expect(personaPanels().map((p) => p.id)).toEqual(['workspace', 'memory', 'history']);
    expect(personaPanels().map((p) => p.title)).toEqual(['工作区', 'Memory 分层', '版本历史']);
    expect(decl.panels).toEqual(personaPanels());
  });

  it('不认识的面板与方法各报各的,措辞写给人看', async () => {
    await expect(call('nope', 'state')).rejects.toThrow('未知面板');
    await expect(call('memory', 'nope')).rejects.toThrow('未知面板方法');
  });
});

describe('Memory 面板', () => {
  it('五层都在,memo 三级读数取自真目录', async () => {
    const st = await call<MemoryState>('memory', 'state');
    expect(st.tiers.map((t) => t.id)).toEqual([
      'MEMORY 0', 'MEMORY 1', 'MEMORY 2', 'MEMORY 3', 'MEMORY 4',
    ]);
    expect(st.memo.resident).toEqual(['today.md']);
    expect(st.memo.active).toEqual(['later.md']);
    expect(st.memo.residentCap).toBe(5);
    expect(st.memo.activeCap).toBe(9);
    // MEMORY 3 的读数来自Persona持有的浮现
    expect(st.tiers[3].live).toBe('1 缕');
  });

  it('权限矩阵逐格现算:主意识对 people/ 只能追加、external/ 全权,梦全区可写', async () => {
    const st = await call<MemoryState>('memory', 'state');
    expect(st.matrix.roles).toEqual(['main', 'dream', 'subagent']);
    const at = (zone: string, role: PersonaRole) => {
      const row = st.matrix.rows.find((r) => r.zone === zone)!;
      return row.cells[st.matrix.roles.indexOf(role)];
    };
    // 读一律放行,所以每一格都含 read
    for (const row of st.matrix.rows) {
      for (const cell of row.cells) expect(cell.allowed).toContain('read');
      expect(row.cells[st.matrix.roles.indexOf('subagent')].allowed).toEqual(['read']);
    }
    expect(at('note', 'main').allowed).toEqual(['read', 'write', 'append', 'rename']);
    expect(at('people', 'main').allowed).toEqual(['read', 'append']);
    expect(at('external', 'main').allowed).toEqual(['read', 'write', 'append', 'rename', 'delete']);
    expect(at('worldview', 'dream').allowed).toEqual(['read', 'write', 'append', 'rename', 'delete']);
    // 拒绝理由就是 agent 会收到的那句原话
    expect(at('worldview', 'main').denied[0].reason).toContain('dream');
  });

  it('宪法归梦修订:梦可改内容,不能改名删除;主意识只读', async () => {
    const st = await call<MemoryState>('memory', 'state');
    const row = st.matrix.rows.find((r) => r.zone === 'constitution')!;
    expect(row.cells[st.matrix.roles.indexOf('dream')].allowed).toEqual(['read', 'write', 'append']);
    expect(row.cells[st.matrix.roles.indexOf('main')].allowed).toEqual(['read']);
  });
});

describe('工作区与版本历史面板', () => {
  it('目录树目录在前、同类按名,隐藏文件不进树', async () => {
    writeFileSync(join(dir, 'note', '.draft.md'), '藏起来\n', 'utf8');
    const { nodes } = await call<{ nodes: WorkspaceNode[] }>('workspace', 'tree');
    const memo = nodes.find((n) => n.path === 'memo')!;
    expect(memo.children!.map((n) => [n.path, n.type])).toEqual([
      ['memo/active', 'dir'], ['memo/archived', 'dir'], ['memo/today.md', 'file'],
    ]);
    const note = nodes.find((n) => n.path === 'note')!;
    expect(note.children!.map((n) => n.path)).toEqual(['note/library', 'note/playbook', 'note/a.md']);
    expect(note.children!.find((n) => n.path === 'note/a.md')!.size).toBe(Buffer.byteLength('第一版\n'));
  });

  it('保存、改名、删除各以 operator 署名提交一次,历史、diff 与旧版内容都取得到', async () => {
    const file = await call<WorkspaceFile>('workspace', 'read', ['note/a.md']);
    expect(await call('workspace', 'write', ['note/a.md', '第二版\n', file.revision])).toMatchObject({ ok: true });
    expect(await call('workspace', 'rename', ['note/a.md', 'note/b.md'])).toMatchObject({ ok: true });
    expect(await call('workspace', 'remove', ['note/b.md'])).toMatchObject({ ok: true, revision: '' });
    expect(existsSync(join(dir, 'note', 'b.md'))).toBe(false);

    const st = await call<{ status: { dirty: boolean }; commits: CommitInfo[] }>('history', 'state');
    expect(st.status.dirty).toBe(false);
    expect(st.commits.slice(0, 3).map((c) => [c.message, c.author])).toEqual([
      ['控制台删除 note/b.md', 'operator'],
      ['控制台改名 note/a.md → note/b.md', 'operator'],
      ['控制台编辑 note/a.md', 'operator'],
    ]);
    const edit = st.commits[2]!;
    const fileHistory = await call<{ commits: CommitInfo[] }>('workspace', 'history', ['note/a.md']);
    expect(fileHistory.commits.map((c) => c.message)).toContain('控制台编辑 note/a.md');
    expect((await call<{ diff: string }>('history', 'diff', [edit.hash, 'note/a.md'])).diff).toContain('+第二版');
    expect((await call<{ content: string }>('history', 'at', [edit.hash, 'note/a.md'])).content).toBe('第二版\n');
  });

  it('底本变了或目标已存在时什么都不动,回执 conflict', async () => {
    const file = await call<WorkspaceFile>('workspace', 'read', ['note/a.md']);
    writeFileSync(join(dir, 'note', 'a.md'), '别处改过\n', 'utf8');
    expect(await call('workspace', 'write', ['note/a.md', '我的版本\n', file.revision])).toEqual({
      ok: false, conflict: true, error: '文件已在别处被修改，请重新载入后再保存',
    });
    expect(await call('workspace', 'rename', ['note/a.md', 'note/b.md', file.revision])).toEqual({
      ok: false, conflict: true, error: '文件已在别处被修改，请重新载入后再改名',
    });
    expect(await call('workspace', 'remove', ['note/a.md', file.revision])).toEqual({
      ok: false, conflict: true, error: '文件已在别处被修改，请重新载入后再删除',
    });
    expect(await call('workspace', 'write', ['memo/today.md', '新建', '', true])).toEqual({
      ok: false, conflict: true, error: '同名文件已经存在',
    });
    const today = await call<WorkspaceFile>('workspace', 'read', ['memo/today.md']);
    await call('workspace', 'remove', ['memo/today.md']);
    expect(await call('workspace', 'write', ['memo/today.md', '我的版本\n', today.revision])).toEqual({
      ok: false, conflict: true, error: '文件已被移动或删除',
    });
    expect(readFileSync(join(dir, 'note', 'a.md'), 'utf8')).toBe('别处改过\n');
    expect(existsSync(join(dir, 'note', 'b.md'))).toBe(false);
    expect(existsSync(join(dir, 'memo', 'today.md'))).toBe(false);
  });
});
