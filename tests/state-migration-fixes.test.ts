import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger } from 'cortico/core/util.ts';
import { composeDefaults } from '../index.ts';
import { Appraiser } from '../persona/appraisal.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { workspaceTools } from '../base/persona/workspaceTools.ts';
import { StateReview, prepareStateAction } from '../persona/state-review.ts';
import { renderState } from '../persona/state-document.ts';
import { StateMigration } from '../persona/state-migration/index.ts';

const roots: string[] = [], closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ctx = { role: 'dream', log: nullLogger() };
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'migration-fixes-')); roots.push(root); return root; };
function setup() {
  const memory = new GitWorkspaceMemory({ memoryDir: temp() });
  const config = composeDefaults();
  const appraiser = new Appraiser(config.appraisal!); closers.push(() => appraiser.dispose());
  const options = { memory, core: () => null, appraiser, enabled: () => true, readOverride: () => null, speechContext: () => ({ recentDialogue: [] }) };
  return { memory, appraiser, options, config };
}

it('derives migration availability from external edits, scope validity and empty documents without waiting for a turn', () => {
  const { memory, options, config } = setup(); memory.writeFileAtomic('state/STATE.md', renderState({ text: '', constraints: [] }));
  const review = new StateReview(options); review.begin('main');
  memory.writeFileAtomic('state/STATE.md', 'Legacy again.'); expect(review.status()).toMatchObject({ status: '不可用', migrationPending: true });
  memory.writeFileAtomic('state/STATE.md', ''); expect(review.status().migrationPending).toBe(false);
  memory.writeFileAtomic('state/STATE.md', 'ordinary\n\n## Action constraints\n### old\n- instruction: "Keep it"\n- exceptions: ""\n');
  config.appraisal!.provider = 'laya';
  expect(review.status().reason).toContain('迁移旧约束'); expect(review.status().reason).not.toContain('下一次正常 Dream');
});

it('clears a delivered completion marker when STATE is reverted to a legacy or invalid document', () => {
  const { memory, appraiser } = setup();
  const migration = new StateMigration({ memory, appraiser, enabled: () => true, runtime: () => null, api: () => null, dream: () => undefined,
    appraisalConfig: () => composeDefaults().appraisal!, tools: () => [], readChars: () => 100, contextTokens: () => 1000 });
  memory.writeFileAtomic('state/STATE.md', renderState({ text: 'done', constraints: [] }));
  Object.assign(migration, { deliveredId: 'done', last: { status: 'waiting' } }); expect(migration.state().status).toBe('complete');
  memory.writeFileAtomic('state/STATE.md', 'old format'); expect(migration.state().status).toBe('idle');
});

it.each(['./state/STATE.md', 'state\\STATE.md'])('recognizes full range coverage through equivalent STATE path %s', async path => {
  const { memory, options } = setup(); memory.writeFileAtomic('state/STATE.md', 'one\ntwo\n');
  const review = new StateReview({ ...options, enabled: () => false, wholeReadFallbackChars: () => 4 });
  const tools = review.wrap([...workspaceTools({ memory, writeGuard: () => null, readOverride: () => null, prefixResidentFiles: () => [], wholeReadFallbackChars: () => 4 }), review.updateTool()], 'dream');
  const call = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.handler(args, ctx);
  await call('read_file', { path }); await call('read_file', { path, offset: 2 });
  expect(await call('update_state', { text: 'new', constraints: [] })).toContain('[written]');
});

it('previews the same normalized folder destination and rejects impossible line changes without inventing a diff', async () => {
  const { memory, options } = setup(); memory.writeFileAtomic('note/sub/a.md', 'one\ntwo\n');
  const spec = { name: 'move_file', description: '', tags: ['write' as const], parameters: {} };
  const prepared = prepareStateAction(options, spec, { from: 'note\\sub', to: 'external\\dest' }, 'dream');
  expect(prepared.action).toMatchObject({ move: { pairs: [{ from: 'note/sub/a.md', to: 'external/dest/a.md' }] } });
  const invalid = prepareStateAction(options, spec, { from: 'note/sub/a.md', to: 'note/new.md', offset: 99 }, 'dream');
  expect(invalid.action.change).toBeUndefined(); expect(invalid.action.invalid).toBeDefined();
  memory.writeFileAtomic('note/empty.md', '');
  expect(prepareStateAction(options, spec, { from: 'note/empty.md', to: 'note/new.md', offset: 1 }, 'dream').action.change).toBeUndefined();
});
