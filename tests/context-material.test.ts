import { expect, it } from 'vitest';
import { functionCall, functionResult, message, record } from 'cortico/protocol/open-responses/context.ts';
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

it('retains inline images and their positions while removing internal text', () => {
  const image = { type: 'input_image' as const, image_url: 'data:image/png;base64,AA==' };
  const source = record({ type: 'message', role: 'user', content: [
    { type: 'input_text', text: '[system/cognitive-frame]\nold state\n[system/tick] keep' }, image,
  ] });
  const clean = cleanSnapshot([source]);
  expect(clean.records[0]!.item).toMatchObject({ content: [{ text: '[system/tick] keep' }, image] });
  expect(cleanSnapshot([record({ type: 'message', role: 'user', content: [image] })]).records).toHaveLength(1);
  expect(source.item).toMatchObject({ content: [{ text: expect.stringContaining('old state') }, image] });
});
