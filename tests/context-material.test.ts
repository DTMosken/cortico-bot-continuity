import { expect, it } from 'vitest';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { cleanSnapshot } from '../persona/context-material.ts';

it('removes internal cognitive blocks without losing notices, external text or tool pairs', () => {
  const snapshot = [
    message('user', '[system] 2 条新事件。\n[system/cognitive-frame]\nold state\n[system/tick] still useful'),
    functionCall('events', 'external_event_frame', '{}'),
    functionResult('events', '[system/cognitive-frame]\nquoted by an external sender'),
    functionCall('read', 'read_file', '{"path":"handoffs/old.md"}'),
    functionResult('read', 'recursive handoff'),
  ];
  const clean = cleanSnapshot(snapshot);
  expect(textOf(clean.records[0]!)).toBe('[system] 2 条新事件。\n[system/tick] still useful');
  expect(clean.records.map((record) => record.item.type)).toEqual(['message', 'function_call', 'function_call_output']);
  expect(textOf(clean.records[2]!)).toContain('quoted by an external sender');
  expect(clean.background).toBe('recursive handoff');
});

it('preserves dream emergence after legacy frames and plain notices after closed STATE blocks', () => {
  const clean = cleanSnapshot([
    message('user', '[system/cognitive-frame]\nold frame\n[surfaced from dream] retained emergence'),
    message('user', '[system/continuity-state]\nold state\n[/system/continuity-state]\nAn unrelated internal notice.'),
  ]);
  expect(clean.records.map(textOf)).toEqual(['[surfaced from dream] retained emergence', 'An unrelated internal notice.']);
});
