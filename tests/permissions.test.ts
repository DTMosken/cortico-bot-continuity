import { describe, expect, it } from 'vitest';
import { checkAccess, zoneOf } from '../persona/permissions.ts';

describe('continuity state permissions', () => {
  it('reserves runtime state for the Persona and grants the dream STATE.md only', () => {
    expect(zoneOf('state/STATE.md')).toBe('state');
    expect(checkAccess('main', 'write', 'state/STATE.md').ok).toBe(false);
    expect(checkAccess('main', 'write', 'state/runtime.json').ok).toBe(false);
    expect(checkAccess('dream', 'write', 'state/STATE.md').ok).toBe(true);
    expect(checkAccess('dream', 'append', 'state/STATE.md').ok).toBe(true);
    expect(checkAccess('dream', 'write', 'state/runtime.json').ok).toBe(false);
    expect(checkAccess('dream', 'rename', 'state/STATE.md').ok).toBe(false);
  });
});
