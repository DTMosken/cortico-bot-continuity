import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwnedStoragePart, StoragePart } from 'cortico/core/types.ts';
import definition from '../index.ts';
import { loadDeployment } from '../../Cortico/src/deploy.ts';
import type { ContinuityPersona } from '../persona/index.ts';
import type { DreamRun } from '../persona/subconscious/index.ts';
import { cortiWebUiPages, type CortiOpsDeps, type OpsResetResult } from '../webui-page.ts';

const roots: string[] = [], stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function part(key: string, cleared: string[], order = 0): OwnedStoragePart {
  return { key, label: key, kind: 'memory', owner: 'core', order, stat: () => '', clear: () => { cleared.push(key); return `${key} cleared`; } };
}

/** 真实 bot 装配出的部署操作页；存储清单由测试提供。 */
function opsPage(storage: OwnedStoragePart[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ops-page-'));
  roots.push(dir);
  const parts = definition.build(loadDeployment(definition, dir), []);
  const persona = parts.persona as ContinuityPersona;
  stops.push(() => persona.dispose());
  persona.git.ensureRepo();
  const [page] = parts.webUi!.webUiPages!({ storage, language: 'zh' });
  const invoke = (panel: string, method: string, args: unknown[] = []) => page.invoke!(panel, method, args);
  return { persona, invoke, root: persona.memory.memoryDir };
}

/** 新鲜的索引锁不会被当作超时锁清除，git add 因此失败。 */
function lockIndex(root: string): () => void {
  const lock = join(root, '.git', 'index.lock');
  writeFileSync(lock, '');
  const now = new Date();
  utimesSync(lock, now, now);
  return () => rmSync(lock, { force: true });
}

describe('deployment ops page', () => {
  it('rejects rollback and reset while the storage manifest lacks session or events', async () => {
    const cleared: string[] = [];
    const { persona, invoke, root } = opsPage([part('session', cleared, 10)]);
    persona.memory.writeFileAtomic('note/a.md', 'keep\n');
    const state = await invoke('reset', 'state') as { ready: boolean; reason: string };
    expect(state.ready).toBe(false);
    expect(state.reason).toContain('events');
    await expect(invoke('checkpoints', 'rollback', ['checkpoint0'])).rejects.toThrow('存储清单不完整');
    await expect(invoke('reset', 'run', ['checkpoint0'])).rejects.toThrow('存储清单不完整');
    expect(cleared).toEqual([]);
    expect(readFileSync(join(root, 'note/a.md'), 'utf8')).toBe('keep\n');
  });

  it('validates checkpoint names before touching the repository', async () => {
    const { persona, invoke } = opsPage([]);
    await expect(invoke('checkpoints', 'create', ['  '])).rejects.toThrow('缺少 checkpoint 名');
    await expect(invoke('checkpoints', 'create', [42])).rejects.toThrow('缺少 checkpoint 名');
    await expect(invoke('checkpoints', 'create', ['-d'])).rejects.toThrow('checkpoint 名只能含');
    await expect(invoke('checkpoints', 'create', ['a b'])).rejects.toThrow('checkpoint 名只能含');
    await expect(invoke('checkpoints', 'remove', [''])).rejects.toThrow('缺少 checkpoint 名');
    await expect(invoke('checkpoints', 'remove', ['checkpoint0'])).rejects.toThrow('不能删除');
    await expect(invoke('checkpoints', 'rollback', [''])).rejects.toThrow('缺少 checkpoint 名');
    await expect(invoke('reset', 'run', [''])).rejects.toThrow('缺少 checkpoint 名');
    expect(persona.git.listTags().map((t) => t.name)).toEqual(['checkpoint0']);
  });

  it('runs rollback through the same reset transaction as the reset panel', async () => {
    const calls: Array<{ panel: string; checkpoint: string; parts: string[] }> = [];
    let panel = '';
    const storage = [part('events', []), part('session', [], 10)];
    const deps = {
      name: 'continuity',
      checkpoints: { list: () => [], create: () => '', remove: () => '' },
      status: () => ({ available: true, repo: true, dirty: false, head: null, lastCommit: null, tags: [], initError: null, commitError: null }),
      storage: () => storage,
      reset: { run: async (checkpoint: string, parts: StoragePart[]) => {
        calls.push({ panel, checkpoint, parts: parts.map((p) => p.key) });
        return { ok: true, persona: 'done', results: [] };
      } },
      dream: { trigger: () => ({ ok: true, message: '' }), resume: () => ({ ok: true, message: '' }) },
      dreamState: () => ({ dreaming: false, queued: 0, pendingMaterials: 0, pendingTasks: [], runs: [], retryAt: null }),
      dreamConfigInvoke: async () => null,
      subagentsInvoke: async () => null,
    } satisfies CortiOpsDeps;
    const [page] = cortiWebUiPages(deps);
    panel = 'checkpoints';
    await page.invoke!('checkpoints', 'rollback', [' cp1 ']);
    panel = 'reset';
    await page.invoke!('reset', 'run', ['cp1']);
    expect(calls).toEqual([
      { panel: 'checkpoints', checkpoint: 'cp1', parts: ['events', 'session'] },
      { panel: 'reset', checkpoint: 'cp1', parts: ['events', 'session'] },
    ]);
  });

  it('keeps the dream running state and records in the dream config save result', async () => {
    const running = { dreaming: true, queued: 0, pendingMaterials: 1, pendingTasks: [], runs: [{ id: 'run-1', status: 'running' } as DreamRun], retryAt: null };
    const [page] = cortiWebUiPages({
      name: 'continuity',
      checkpoints: { list: () => [], create: () => '', remove: () => '' },
      status: () => ({ available: true, repo: true, dirty: false, head: null, lastCommit: null, tags: [], initError: null, commitError: null }),
      storage: () => [], reset: { run: async () => ({ ok: true, persona: '', results: [] }) },
      dream: { trigger: () => ({ ok: true, message: '' }), resume: () => ({ ok: true, message: '' }) },
      dreamState: () => ({ ...running, values: { 'dream.maxRounds': 4 }, revision: 'old' }),
      dreamConfigInvoke: async (method) => method === 'options' ? [] : { values: { 'dream.maxRounds': 5 }, revision: 'new' },
      subagentsInvoke: async () => null,
    } satisfies CortiOpsDeps);
    expect(await page.invoke!('dream', 'saveDraft', [{ 'dream.maxRounds': 5 }, 'old'])).toEqual({ ...running, values: { 'dream.maxRounds': 5 }, revision: 'new' });
    expect(await page.invoke!('dream', 'options', [])).toEqual([]);
  });

  it('commits uncommitted work before rolling back so it stays recoverable', async () => {
    const cleared: string[] = [];
    const { persona, invoke, root } = opsPage([part('events', cleared), part('session', cleared, 10)]);
    persona.memory.writeFileAtomic('note/draft.md', 'unsaved work\n');
    const out = await invoke('checkpoints', 'rollback', ['checkpoint0']) as OpsResetResult;
    expect(out.ok).toBe(true);
    expect(cleared).toEqual(['events', 'session']);
    expect(existsSync(join(root, 'note/draft.md'))).toBe(false);
    const saved = persona.git.fileAt('HEAD@{1}', 'note/draft.md');
    expect(saved).toBe('unsaved work\n');
  });

  it('aborts rollback without resetting or clearing when the commit fails', async () => {
    const cleared: string[] = [];
    const { persona, invoke, root } = opsPage([part('events', cleared), part('session', cleared, 10)]);
    const head = persona.git.log({ limit: 1 })[0]!.fullHash;
    persona.memory.writeFileAtomic('note/draft.md', 'unsaved work\n');
    const unlock = lockIndex(root);
    await expect(invoke('reset', 'run', ['checkpoint0'])).rejects.toThrow('提交当前改动失败，未回滚');
    unlock();
    expect(cleared).toEqual([]);
    expect(readFileSync(join(root, 'note/draft.md'), 'utf8')).toBe('unsaved work\n');
    expect(persona.git.log({ limit: 1 })[0]!.fullHash).toBe(head);
  });

  it('refuses to tag a checkpoint when committing the current work fails', async () => {
    const { persona, invoke, root } = opsPage([]);
    persona.memory.writeFileAtomic('note/a.md', 'content\n');
    const unlock = lockIndex(root);
    await expect(invoke('checkpoints', 'create', ['cp1', 'note'])).rejects.toThrow('提交当前改动失败，未创建 checkpoint');
    unlock();
    expect(persona.git.listTags().map((t) => t.name)).toEqual(['checkpoint0']);
    const state = await invoke('checkpoints', 'state') as { status: { commitError: string | null } };
    expect(state.status.commitError).toBeTruthy();

    const created = await invoke('checkpoints', 'create', ['cp1', 'note']) as { result: string };
    expect(created.result).toContain('cp1');
    const cp1 = persona.git.listTags().find((t) => t.name === 'cp1')!;
    expect(persona.git.fileAt(cp1.hash, 'note/a.md')).toBe('content\n');
  });
});
