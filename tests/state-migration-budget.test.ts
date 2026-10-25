import { afterEach, expect, it, vi } from 'vitest';
import { message, functionCall, functionResult } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { FakeLLM, textReply } from '../../Cortico/tests/core/helpers.ts';
import { migrationTimeBudget, updateMigrationTimeReminder } from '../persona/state-migration/context.ts';
import { checkMigrationSources } from '../persona/state-migration/source-check.ts';
import type { MigrationInput } from '../persona/state-migration/contracts.ts';
import { checkedSources } from './migration-check-fixture.ts';

afterEach(() => vi.useRealTimers());

it('refreshes one deadline reminder without losing tool results and enters the finishing reserve', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
  const timing = { deadlineAtMs: 600000, finishingReserveMs: 240000 };
  const records = [message('system', 'Keep source meaning.'), functionCall('read', 'migration_sources', '{}'), functionResult('read', 'Source body.')];
  updateMigrationTimeReminder(records, timing);
  expect(migrationTimeBudget(timing)).toMatchObject({ remainingSeconds: 600, finishingReserveSeconds: 240, phase: 'drafting' });
  vi.setSystemTime(360000); updateMigrationTimeReminder(records, timing);
  expect(migrationTimeBudget(timing)).toMatchObject({ remainingSeconds: 240, phase: 'finishing' });
  expect(records).toHaveLength(4); expect(textOf(records[2])).toBe('Source body.');
  expect(textOf(records[3])).toContain('"remainingSeconds":240');
  expect(textOf(records[3])).toContain('Stop optional exploration');
  vi.setSystemTime(700000); updateMigrationTimeReminder(records, timing);
  expect(migrationTimeBudget(timing)?.remainingSeconds).toBe(0); expect(records).toHaveLength(4);
});

it('leaves standalone untimed contexts unchanged', () => {
  const records = [message('system', 'Untimed check.')], original = structuredClone(records);
  updateMigrationTimeReminder(records); expect(records).toEqual(original); expect(migrationTimeBudget()).toBeUndefined();
});

it('gives the independent checker current remaining time with complete source input', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(420000);
  const sources = { 'state/STATE.md': 'Do not alter identifiers.' }, llm = new FakeLLM();
  llm.script(textReply(checkedSources(sources, ['ids'])));
  const input: MigrationInput = { spec: { model: 'fixture', thinking: false }, contextTokens: 10000, readChars: 100,
    tools: [], sources, history: [], timing: { deadlineAtMs: 600000, finishingReserveMs: 240000 } };
  await checkMigrationSources(input, llm, new AbortController().signal, { text: '', constraints: [
    { id: 'ids', instruction: sources['state/STATE.md'], exceptions: '', scope: { sessions: ['main'], tags: ['speak'] } },
  ] }, sources, [], []);
  const payload = JSON.parse(llm.calls[0].messages.at(-1)!.content as string);
  expect(payload.sources).toEqual(sources);
  expect(payload.timeBudget).toEqual({ remainingSeconds: 180, finishingReserveSeconds: 240, phase: 'finishing' });
});
