import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { message } from 'cortico/protocol/open-responses/context.ts';
import { makeFakeHarnessApi } from '../../Cortico/tests/core/helpers.ts';
import { HANDOFF_NOTE_TYPE } from '../base/persona/handoffNote.ts';
import { CORMINI_CONTEXT_DEFAULTS, Cormini, FIRST_TURN_FILES, type CorminiOptions } from '../base/persona/persona.ts';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (label: string) => { const dir = mkdtempSync(join(tmpdir(), `${label}-`)); roots.push(dir); return dir; };

/** 模板与自述都从 `templates` 目录读;不渲染前缀的用例不必建这些文件。 */
class TestPersona extends Cormini {
  constructor(opts: Omit<CorminiOptions, 'orientationFile'>, private readonly templates = '') {
    super({ ...opts, orientationFile: join(templates, 'ORIENTATION.md') });
  }
  protected override templateFile(name: string): string {
    return join(this.templates, name);
  }
}

it('keeps the template text around the World section with the first and last World segments', async () => {
  const dir = tempDir('cormini-world-split');
  writeFileSync(join(dir, 'PREFIX.md'), 'HEAD\n{{persona.constitution}}\n━━━ Worlds ━━━\n{{worlds.envPrompts}}\nTAIL END\n');
  writeFileSync(join(dir, 'ENV_SECTION.md'), '## {{world.id}}\n{{world.envPrompt}}\n');
  writeFileSync(join(dir, 'ORIENTATION.md'), 'Orientation.');
  const persona = new TestPersona({ memoryDir: join(dir, 'memory'), seedConstitution: 'Rules.' }, dir);
  const segments = await persona.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [
    { id: 'alpha', envPrompt: 'Alpha env.' },
    { id: 'beta', envPrompt: 'Beta env.' },
  ] });
  const worlds = segments.filter(segment => segment.title.startsWith('ENVIRONMENT · '));
  expect(worlds.map(segment => segment.title)).toEqual(['ENVIRONMENT · alpha', 'ENVIRONMENT · beta']);
  expect(worlds[0]!.text).toBe('\n━━━ Worlds ━━━\n## alpha\nAlpha env.');
  expect(worlds[1]!.text).toBe('\n## beta\nBeta env.\nTAIL END\n');
  expect(segments.map(segment => segment.text).join('')).toBe(
    'HEAD\nRules.\n━━━ Worlds ━━━\n## alpha\nAlpha env.\n## beta\nBeta env.\nTAIL END\n');
});

it('does not count handoff notes as new external events', () => {
  const persona = new TestPersona({ memoryDir: tempDir('cormini-delivery') });
  const notices: string[] = [];
  persona.attach(makeFakeHarnessApi({ injectInternal: (text, kind) => { if (kind === 'notice') notices.push(text); } }));
  const event = (type: string) => ({ cursor: 1, type, ts: new Date().toISOString(), source: 'core', origin: 'external' }) as EventEnvelope;
  persona.onDelivery({ events: [event(HANDOFF_NOTE_TYPE), event(HANDOFF_NOTE_TYPE)] });
  expect(notices).toEqual([]);
  persona.onDelivery({ events: [event(HANDOFF_NOTE_TYPE), event('message')] });
  expect(notices).toEqual(['[system] 1 条新事件。']);
});

it('treats only missing first-turn files as empty', () => {
  const dir = tempDir('cormini-first-turn');
  const persona = new TestPersona({
    memoryDir: join(dir, 'memory'), firstTurnDir: dir, context: () => ({ ...CORMINI_CONTEXT_DEFAULTS, firstTurn: true }),
  });
  writeFileSync(join(dir, FIRST_TURN_FILES.user), 'Hello.');
  writeFileSync(join(dir, FIRST_TURN_FILES.reply), 'Hi.');
  expect(persona.sessionHead().map(item => item.type)).toEqual(['message', 'message']);
  mkdirSync(join(dir, FIRST_TURN_FILES.thinking));
  expect(() => persona.sessionHead()).toThrow(/EISDIR/);
});

it('caps the handoff note budget at the model hard limit', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, 12)));
  const snapshot = Array.from({ length: 60 }, (_, i) =>
    message('user', `Message ${i}: ${'detail '.repeat(300)}`, { ts: new Date(Date.UTC(2026, 10, 1, 11, i)).toISOString() }));
  const note = async (maxTokens: number, hardTokens: number | null) => {
    const persona = new TestPersona({ memoryDir: tempDir('cormini-handoff'), context: () => ({ ...CORMINI_CONTEXT_DEFAULTS, maxTokens }) });
    const external: string[] = [];
    persona.attach(makeFakeHarnessApi({ injectExternal: text => { external.push(text); } }));
    await persona.onHandoff(snapshot, { hardTokens });
    return external.join('\n\n');
  };
  const uncapped = await note(64_000, null);
  const capped = await note(64_000, 6000);
  expect(capped.length).toBeLessThan(uncapped.length);
  expect(capped).toBe(await note(6000, null));
  expect(await note(64_000, 100_000)).toBe(uncapped);
});
