import { expect, it } from 'vitest';
import { appliesTo, parseState, renderState, validateState } from '../persona/state-document.ts';

const constraint = { id: 'metadata', scope: {}, instruction: 'Omit processing timestamps.\nKeep useful facts.', exceptions: 'Keep deadlines.' };

it('preserves legacy text and round-trips structured text without a second state file', () => {
  const text = 'Current concerns.\n\nKeep this whitespace.\n';
  expect(parseState(text)).toMatchObject({ text, structured: false, constraints: [] });
  const rendered = renderState({ text, constraints: [constraint] });
  expect(parseState(rendered)).toMatchObject({ text, constraints: [constraint], structured: true });
  expect(renderState(parseState(rendered))).toBe(rendered);
  expect(parseState(renderState({ text, constraints: [] })).structured).toBe(true);
});

it('preserves all raw content on malformed constraints and rejects ambiguous updates', () => {
  const malformed = 'Keep this.\n## Action constraints\n### broken\n- instruction: unquoted\n';
  expect(parseState(malformed)).toMatchObject({ text: malformed, raw: malformed, structured: false });
  expect(parseState(malformed).error).toBeTruthy();
  expect(() => validateState({ text: '', constraints: [constraint, constraint] })).toThrow('unique');
  expect(() => validateState({ text: '## Action constraints', constraints: [] })).toThrow('reserved');
});

it('intersects scope fields, unions their values and defaults to main/dream side effects', () => {
  const write = { name: 'edit_file', tags: ['write'] as const };
  expect(appliesTo(constraint, 'dream', write)).toBe(true);
  expect(appliesTo(constraint, 'worker', write)).toBe(false);
  expect(appliesTo(constraint, 'main', { name: 'read_file', tags: ['read'] })).toBe(false);
  const rule = { ...constraint, scope: { sessions: ['dream'], tools: ['edit_file', 'write_file'], tags: ['write' as const] } };
  expect(appliesTo(rule, 'main', write)).toBe(false);
  expect(appliesTo(rule, 'dream', write)).toBe(true);
  expect(appliesTo(rule, 'dream', { name: 'edit_file', tags: ['read'] })).toBe(false);
});
