import { expect, it } from 'vitest';
import { appliesTo, parseState, renderState, validateState } from '../persona/state-document.ts';

const constraint = { id: 'metadata', scope: { sessions: ['main', 'dream'], tags: ['write' as const, 'speak' as const, 'act' as const] }, instruction: 'Omit processing timestamps.\nKeep useful facts.', exceptions: 'Keep deadlines.' };

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

it('intersects explicit scope fields and unions their values', () => {
  const write = { name: 'edit_file', tags: ['write'] as const };
  expect(appliesTo(constraint, 'dream', write)).toBe(true);
  expect(appliesTo(constraint, 'worker', write)).toBe(false);
  expect(appliesTo(constraint, 'main', { name: 'read_file', tags: ['read'] })).toBe(false);
  const rule = { ...constraint, scope: { sessions: ['dream'], tools: ['edit_file', 'write_file'], tags: ['write' as const] } };
  expect(appliesTo(rule, 'main', write)).toBe(false);
  expect(appliesTo(rule, 'dream', write)).toBe(true);
  expect(appliesTo(rule, 'dream', { name: 'edit_file', tags: ['read'] })).toBe(false);
});

it('requires sessions and a tool selector on updates while preserving scopeless legacy documents for migration', () => {
  const legacy = 'Keep.\n## Action constraints\n### old\n- instruction: "Keep useful facts."\n- exceptions: ""\n';
  expect(parseState(legacy)).toMatchObject({ raw: legacy, structured: true, needsScopeMigration: true,
    constraints: [{ id: 'old', scope: {}, instruction: 'Keep useful facts.' }] });
  expect(appliesTo(parseState(legacy).constraints[0], 'dream', { name: 'write_file', tags: ['write'] })).toBe(false);
  for (const scope of [undefined, {}, { sessions: ['dream'] }, { tools: ['write_file'] }, { sessions: ['dream'], tags: [] }]) {
    expect(() => validateState({ text: '', constraints: [{ ...constraint, scope }] })).toThrow();
  }
  expect(() => validateState({ text: '', constraints: [{ ...constraint, scope: { sessions: ['dream'], tools: ['write_file'] } }] })).not.toThrow();
  expect(() => validateState({ text: '', constraints: [{ ...constraint, scope: { sessions: ['main'], tags: ['speak'] } }] })).not.toThrow();
});
