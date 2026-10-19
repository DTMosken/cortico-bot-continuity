import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import { estimateMessagesTokens } from 'cortico/core/util.ts';
import { DreamMaterials, prepareDreamInput } from '../persona/subconscious/materials.ts';

it('offers an oversized oldest material for paged reading before later materials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-materials-'));
  try {
    const store = new DreamMaterials(dir);
    store.add([message('system', 'system'), message('user', 'old '.repeat(20000)),
      message('user', 'recent'), functionCall('r', 'lookup', '{}'), functionResult('r', 'receipt')]);
    const input = prepareDreamInput(store.pending(), { maxInputTokens: 8000, maxBackgroundTokens: 1000, system: [message('system', 'system')], guide: 'instructions', state: 'current', background: '' });
    expect(estimateMessagesTokens(input.messages)).toBeLessThanOrEqual(8000);
    expect(input.materialIds).toEqual([store.list()[0]!.id]);
    expect(input.included).toEqual([]);
    expect(input.omitted).toHaveLength(2);
    const restored = new DreamMaterials(dir);
    expect(restored.read(input.materialIds[0]!, 0, 1000)).toContain('old');
    restored.complete(input.materialIds, 0);
    const next = prepareDreamInput(restored.pending(), { maxInputTokens: 8000, maxBackgroundTokens: 1000, system: [message('system', 'system')], guide: 'instructions', state: 'current', background: '' });
    expect(next.messages.some((record) => record.item.type === 'function_call' && record.item.call_id === 'r')).toBe(true);
    expect(next.messages.some((record) => record.item.type === 'function_call_output' && record.item.call_id === 'r')).toBe(true);
    restored.cleanup(1, 2 * 86400000);
    expect(restored.pending()).toHaveLength(1);
    expect(restored.read(next.materialIds[0]!, 0, 1000)).toContain('recent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('fills a batch from the oldest pending records within the input budget', () => {
  const store = new DreamMaterials();
  store.add([message('user', 'old '.repeat(1500)), message('user', 'new '.repeat(1500))]);
  const pending = store.pending();
  const options = { maxInputTokens: 3000, maxBackgroundTokens: 0, system: [], guide: '', state: '', background: '' };
  const input = prepareDreamInput(pending, options);
  expect(input.materialIds).toEqual([pending[0]!.id]);
  expect(input.included).toEqual(input.materialIds);
  expect(input.omitted).toEqual([pending[1]!.id]);
  expect(estimateMessagesTokens(input.messages)).toBeLessThanOrEqual(options.maxInputTokens);
});
