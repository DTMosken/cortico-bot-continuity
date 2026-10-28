import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { functionCall, functionResult, message } from 'cortico/protocol/open-responses/context.ts';
import { estimateMessagesTokens } from 'cortico/core/util.ts';
import { DreamMaterials, prepareDreamInput } from '../persona/subconscious/materials.ts';
import { responsesInput } from '../../Cortico/src/providers/transport/responses-input.ts';
import { PERSONA_DEFAULTS } from '../persona/config.ts';

const byteBudget = { maxInputBytes: PERSONA_DEFAULTS.dream.maxInputBytes!, blobBytes: () => null };

it('batches image attachments by base64 bytes even when all text fits', () => {
  const store = new DreamMaterials();
  const bytes = Buffer.alloc(1024 * 1024);
  const ref = { handle: 'log:fixture.png', mime: 'image/png', fallbackText: 'picture' };
  store.add(Array.from({ length: 20 }, () => message('user', 'picture', { blobs: [ref] })));
  const pending = store.pending();
  const options = { maxInputTokens: 8000, maxBackgroundTokens: 0, maxInputBytes: 2 * 1024 * 1024,
    blobBytes: () => bytes.byteLength, system: [], guide: '', state: '', background: '' };
  const input = prepareDreamInput(pending, options);
  expect(input.included).toEqual([pending[0]!.id]);
  expect(input.omitted).toHaveLength(pending.length - 1);
  expect(input.messages.flatMap(record => record.context.blobs ?? [])).toEqual([ref]);
  const wire = responsesInput({ model: 'fixture', input: [] }, { context: input.messages },
    { media: { enabled: () => true, read: () => bytes } });
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(options.maxInputBytes);
  expect(input.inputBytes).toBeLessThanOrEqual(options.maxInputBytes);
  store.complete(input.materialIds);
  const next = prepareDreamInput(store.pending(), options);
  expect(next.included).toEqual([pending[1]!.id]);
});

it('counts prefix images, tool-output images and reserved tool schemas in the byte budget', () => {
  const store = new DreamMaterials();
  const ref = { handle: 'log:fixture.png', mime: 'image/png', fallbackText: 'picture' };
  store.add([message('user', 'first'), functionCall('one', 'lookup', '{}'), functionResult('one', 'result', { blobs: [ref] }),
    message('user', 'second'), functionCall('two', 'lookup', '{}'), functionResult('two', 'result', { blobs: [ref] })]);
  const pending = store.pending();
  const options = { maxInputTokens: 8000, maxInputBytes: 40000, maxBackgroundTokens: 0, blobBytes: () => 10000,
    system: [message('user', 'prefix', { blobs: [ref] })], guide: '', state: '', background: '' };
  expect(prepareDreamInput(pending, options).included).toEqual([pending[0]!.id]);
  const withoutPrefix = { ...options, system: [] };
  expect(prepareDreamInput(pending, withoutPrefix).included).toEqual(pending.map(material => material.id));
  expect(prepareDreamInput(pending, { ...withoutPrefix, reservedBytes: 14000 }).included).toEqual([pending[0]!.id]);
});

it('omits unreadable and non-image blob payloads and still enforces UTF-8 text bytes', () => {
  const store = new DreamMaterials();
  store.add([message('user', 'first', { blobs: [
    { handle: 'log:missing.png', mime: 'image/png', fallbackText: 'missing picture' },
    { handle: 'log:file.pdf', mime: 'application/pdf', fallbackText: 'document' },
  ] }), message('user', 'second')]);
  const input = prepareDreamInput(store.pending(), { ...byteBudget, maxInputBytes: 4000, maxInputTokens: 8000,
    maxBackgroundTokens: 0, blobBytes: handle => handle.endsWith('.pdf') ? 100000 : null,
    system: [], guide: '', state: '', background: '' });
  expect(input.included).toHaveLength(2);
  const textStore = new DreamMaterials();
  textStore.add([message('user', '汉'.repeat(1000)), message('user', 'later')]);
  const paged = prepareDreamInput(textStore.pending(), { ...byteBudget, maxInputBytes: 2500, maxInputTokens: 8000,
    maxBackgroundTokens: 0, system: [], guide: '', state: '', background: '' });
  expect(paged.included).toEqual([]);
  expect(paged.materialIds).toEqual([textStore.list()[0]!.id]);
});

it('retains an oversized image material instead of offering text-only paged reading', () => {
  const store = new DreamMaterials();
  store.add([message('user', 'picture', { blobs: [
    { handle: 'log:fixture.png', mime: 'image/png', fallbackText: 'picture' },
  ] }), message('user', 'later')]);
  const pending = store.pending();
  expect(() => prepareDreamInput(pending, { maxInputTokens: 8000, maxBackgroundTokens: 0,
    maxInputBytes: 1024, blobBytes: () => 1024, system: [], guide: '', state: '', background: '',
  })).toThrow(/image.*byte budget/i);
  expect(store.pending().map(material => material.id)).toEqual(pending.map(material => material.id));
});

it('offers an oversized oldest material for paged reading before later materials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-materials-'));
  try {
    const store = new DreamMaterials(dir);
    store.add([message('system', 'system'), message('user', 'old '.repeat(20000)),
      message('user', 'recent'), functionCall('r', 'lookup', '{}'), functionResult('r', 'receipt')]);
    const input = prepareDreamInput(store.pending(), { ...byteBudget, maxInputTokens: 8000, maxBackgroundTokens: 1000, system: [message('system', 'system')], guide: 'instructions', state: 'current', background: '' });
    expect(estimateMessagesTokens(input.messages)).toBeLessThanOrEqual(8000);
    expect(input.materialIds).toEqual([store.list()[0]!.id]);
    expect(input.included).toEqual([]);
    expect(input.omitted).toHaveLength(2);
    const restored = new DreamMaterials(dir);
    expect(restored.read(input.materialIds[0]!, 0, 1000)).toContain('old');
    restored.complete(input.materialIds, 0);
    const next = prepareDreamInput(restored.pending(), { ...byteBudget, maxInputTokens: 8000, maxBackgroundTokens: 1000, system: [message('system', 'system')], guide: 'instructions', state: 'current', background: '' });
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
  const options = { ...byteBudget, maxInputTokens: 3000, maxBackgroundTokens: 0, system: [], guide: '', state: '', background: '' };
  const input = prepareDreamInput(pending, options);
  expect(input.materialIds).toEqual([pending[0]!.id]);
  expect(input.included).toEqual(input.materialIds);
  expect(input.omitted).toEqual([pending[1]!.id]);
  expect(estimateMessagesTokens(input.messages)).toBeLessThanOrEqual(options.maxInputTokens);
});
