import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeDefaults } from '../index.ts';
import { ContinuityPersona } from '../persona/index.ts';

it.each([true, false])('keeps the Subagents heading only with its section (enabled: %s)', async (enabled) => {
  const dir = mkdtempSync(join(tmpdir(), 'continuity-prefix-'));
  const cfg = composeDefaults(); cfg.subagents!.enabled = enabled;
  const persona = new ContinuityPersona({ memoryDir: join(dir, 'memory'), cfg });
  try {
    const prefix = (await persona.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] })).map(segment => segment.text).join('');
    expect(prefix.includes('━━━ Subagents ━━━')).toBe(enabled);
    expect(prefix).not.toMatch(/\n{3,}━━━ 记忆/u);
    if (enabled) expect(prefix).toMatch(/\S\n\n━━━ Subagents ━━━\n\S[\s\S]*\S\n\n━━━ 记忆 ━━━/u);
    else expect(prefix).toMatch(/\S\n\n━━━ 记忆 ━━━/u);
  } finally { await persona.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
