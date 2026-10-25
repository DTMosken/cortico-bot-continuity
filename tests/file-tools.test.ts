import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger } from 'cortico/core/util.ts';
import { composeDefaults } from '../index.ts';
import { Appraiser } from '../persona/appraisal.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { workspaceTools, fileReadView } from '../base/persona/workspaceTools.ts';
import { ContinuityPersona } from '../persona/index.ts';
import { StateReview, prepareStateAction } from '../persona/state-review.ts';
import { parseState, renderState } from '../persona/state-document.ts';
const roots: string[] = [], stops: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'file-tools-test-')); roots.push(dir); return dir; };
const ctx = { role: 'dream', log: nullLogger() };
const document = { text: 'Current concern.', constraints: [{ id: 'style', scope: { sessions: ['main'], tools: ['chat_send'] }, instruction: 'Omit processing metadata.', exceptions: '' }] };

it('previews actual read lengths at the boundary and recognizes complete explicit reads', async () => {
  const text = 'one\ntwo\n';
  expect(fileReadView('s', text, {}, text.length).full).toBe(true);
  const partial = fileReadView('s', text, {}, text.length - 1); expect(partial.full).toBe(false); expect(partial.body).toBe('one');
  expect(fileReadView('s', text, { offset: 1 }, 1).full).toBe(true);
  expect(fileReadView('s', 'a'.repeat(30), {}, 5)).toMatchObject({ body: 'aaaaa', full: false, completeLines: false });
  const memory = new GitWorkspaceMemory({ memoryDir: root() }); memory.writeFileAtomic('state/STATE.md', 'one\ntwo\nthree\n');
  const cfg = composeDefaults();
  const appraiser = new Appraiser(cfg.appraisal!); stops.push(() => appraiser.dispose());
  const review = new StateReview({ memory, appraiser, core: () => null, enabled: () => false, readOverride: () => null, speechContext: () => ({ recentDialogue: [] }), wholeReadFallbackChars: () => 5 });
  const tools = review.wrap([...workspaceTools({ memory, writeGuard: () => null, readOverride: () => null, prefixResidentFiles: () => [], wholeReadFallbackChars: () => 5 }), review.updateTool()], 'dream');
  const call = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.handler(args, ctx);
  await call('read_file', { path: 'state/STATE.md' });
  expect(await call('update_state', { text: 'new', constraints: [] })).toContain('Read STATE.md in full');
  await call('read_file', { path: 'state/STATE.md', offset: 2, limit: 1 });
  expect(await call('update_state', { text: 'new', constraints: [] })).toContain('Read STATE.md in full');
  await call('read_file', { path: 'state/STATE.md', offset: 3 });
  expect(await call('update_state', { text: 'new', constraints: [] })).toContain('[written] state/STATE.md');
});

it('uses Persona moveGuard for full-tier rename and preserves role/capacity checks for folders and line moves', async () => {
  const cfg = composeDefaults(); cfg.memo = { residentCap: 2, activeCap: 1 };
  const persona = new ContinuityPersona({ cfg, memoryDir: root() }); stops.push(() => persona.dispose());
  persona.memory.writeFileAtomic('memo/a.md', 'A'); persona.memory.writeFileAtomic('memo/b.md', 'B');
  const tools = (role: string) => persona.declareSessions().find(session => session.id === role)!.tools();
  const move = (role: string, args: Record<string, unknown>) => tools(role).find(tool => tool.name === 'move_file')!.handler(args, { ...ctx, role });
  expect(await move('main', { from: 'memo/a.md', to: 'memo/renamed.md' })).toContain('[moved]');
  persona.memory.writeFileAtomic('note/source.md', 'outside');
  expect(await move('main', { from: 'note/source.md', to: 'memo/new.md' })).toContain('full');
  persona.memory.writeFileAtomic('state/STATE.md', 'Original.');
  expect(await move('main', { from: 'note/source.md', to: 'state/STATE.md', offset: 1 })).toContain('[move failed]');
  expect(await move('dream', { from: 'state/STATE.md', to: 'note/state.md' })).toContain('[move failed]');
  persona.memory.writeFileAtomic('external/tree/a.md', 'A'); persona.memory.writeFileAtomic('external/tree/nested/b.md', 'B');
  expect(await move('main', { from: 'external/tree', to: 'external/dest' })).toContain('[moved]');
  expect(persona.memory.exists('external/tree')).toBe(false); expect(persona.memory.readFile('external/dest/nested/b.md')).toBe('B');
  expect(await move('main', { from: 'external/dest/a.md', to: 'external/dest/nested/b.md' })).toContain('[move failed]');
});

it('applies canonical candidates by clearing then cutting all lines without retyping, and leaves an empty source', async () => {
  const persona = new ContinuityPersona({ cfg: composeDefaults(), memoryDir: root() }); stops.push(() => persona.dispose());
  const candidate = renderState({ ...document, text: '中文当前状态。\n' });
  persona.memory.writeFileAtomic('note/state-migration/task/candidate.md', candidate); persona.memory.writeFileAtomic('state/STATE.md', 'Old');
  const tools = persona.declareSessions().find(session => session.id === 'dream')!.tools();
  const call = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.handler(args, ctx);
  await call('write_file', { path: 'state/STATE.md', content: '' });
  expect(persona.memory.readFile('note/state-migration/task/candidate.md')).toBe(candidate);
  expect(await call('move_file', { from: 'note/state-migration/task/candidate.md', to: 'state/STATE.md', offset: 1 })).toContain('[moved]');
  expect(persona.memory.readFile('state/STATE.md')).toBe(candidate); expect(persona.memory.readFile('note/state-migration/task/candidate.md')).toBe('');
  expect(parseState(persona.memory.readFile('state/STATE.md')).error).toBeUndefined();
});

it('prepares line-move differences and detects folder membership changes before resolving staged actions', () => {
  const memory = new GitWorkspaceMemory({ memoryDir: root() });
  memory.writeFileAtomic('note/a.md', 'first\nsecond\n'); memory.writeFileAtomic('note/b.md', 'existing');
  const options = { memory, core: () => null, readOverride: () => null, speechContext: () => ({ recentDialogue: [] }) };
  const tool = { name: 'move_file', tags: ['write' as const], description: '', parameters: {} };
  const line = prepareStateAction(options, tool, { from: 'note/a.md', to: 'note/b.md', offset: 2 }, 'dream');
  expect(line.action).toMatchObject({ move: { mode: 'cut_lines_append' }, change: { moved: 'second', sourceAfter: 'first\n', destinationAfter: 'existing\nsecond\n' } });
  const folder = prepareStateAction(options, tool, { from: 'note', to: 'external/archive' }, 'dream');
  expect(folder.action).toMatchObject({ move: { mode: 'move_directory', pairs: [{ from: 'note/a.md', to: 'external/archive/a.md' }, { from: 'note/b.md', to: 'external/archive/b.md' }] } });
  const revision = folder.target(); memory.writeFileAtomic('note/new.md', 'new'); expect(folder.target()).not.toBe(revision);
});
