import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import { estimateMessagesTokens } from 'cortico/core/util.ts';
import { DreamMaterials, prepareDreamInput } from '../persona/subconscious/materials.ts';

it('bounds initial input, retains complete recent tool pairs and keeps omitted materials readable after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-materials-'));
  try {
    const store = new DreamMaterials(dir);
    store.add([message('system', 'system'), message('user', 'old '.repeat(20000)),
      message('user', 'recent'), functionCall('r', 'lookup', '{}'), functionResult('r', 'receipt')]);
    const input = prepareDreamInput(store.pending(), { maxInputTokens: 8000, maxBackgroundTokens: 1000, system: [message('system', 'system')], guide: 'instructions', state: 'current', background: '' });
    expect(estimateMessagesTokens(input.messages)).toBeLessThanOrEqual(8000);
    expect(input.messages.some((record) => record.item.type === 'function_call' && record.item.call_id === 'r')).toBe(true);
    expect(input.messages.some((record) => record.item.type === 'function_call_output' && record.item.call_id === 'r')).toBe(true);
    expect(input.omitted).toHaveLength(1);
    const restored = new DreamMaterials(dir);
    expect(restored.read(input.omitted[0]!, 0, 1000)).toContain('old');
    restored.complete(input.included, 0);
    restored.cleanup(1, 2 * 86400000);
    expect(restored.pending()).toHaveLength(1);
    expect(restored.read(input.omitted[0]!, 0, 1000)).toContain('old');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
