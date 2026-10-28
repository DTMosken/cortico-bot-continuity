import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { functionCall, functionResult, message, record } from 'cortico/protocol/open-responses/context.ts';
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

it('omits oversized images from input while retaining their handles and later materials', () => {
  const store = new DreamMaterials();
  store.add([message('user', 'picture', { blobs: [
    { handle: 'log:fixture.png', mime: 'image/png', fallbackText: 'picture' },
  ] }), message('user', 'later')]);
  const pending = store.pending();
  const input = prepareDreamInput(pending, { maxInputTokens: 8000, maxBackgroundTokens: 0,
    maxInputBytes: 4000, blobBytes: () => 10000, system: [], guide: '', state: '', background: '',
  });
  expect(input.included).toEqual(pending.map(material => material.id));
  expect(input.unreadImages).toEqual([{ id: pending[0]!.id, images: [{ handle: 'log:fixture.png', recordIndex: 0 }] }]);
  expect(input.messages.flatMap(record => record.context.blobs ?? [])).toEqual([]);
  expect(JSON.stringify(input.messages)).toContain('[image not read]');
  expect(JSON.stringify(input.messages)).toContain('log:fixture.png');
  expect(input.inputBytes).toBeLessThanOrEqual(4000);
  expect(store.pending()).toEqual(pending);
  expect(store.pending().map(material => material.id)).toEqual(pending.map(material => material.id));
});

it('preserves small images when omitting a larger tool-output image and repeated handles', () => {
  const store = new DreamMaterials();
  const large = { handle: 'log:large.png', mime: 'image/png', fallbackText: 'large' };
  const small = { handle: 'log:small.png', mime: 'image/png', fallbackText: 'small' };
  store.add([message('user', 'caption', { blobs: [large, small] }), functionCall('one', 'lookup', '{}'),
    functionResult('one', 'receipt', { blobs: [large] }), message('user', 'later')]);
  const pending = store.pending();
  const input = prepareDreamInput(pending, { maxInputTokens: 8000, maxInputBytes: 6000, maxBackgroundTokens: 0,
    blobBytes: handle => handle === large.handle ? 10000 : 30, system: [], guide: '', state: '', background: '' });
  expect(input.included).toEqual(pending.map(material => material.id));
  expect(input.messages.flatMap(record => record.context.blobs ?? [])).toEqual([small]);
  expect(input.unreadImages).toEqual([{ id: pending[0]!.id, images: [
    { handle: large.handle, recordIndex: 0 }, { handle: large.handle, recordIndex: 2 },
  ] }]);
  const wire = responsesInput({ model: 'fixture', input: [] }, { context: input.messages },
    { media: { enabled: () => true, read: handle => Buffer.alloc(handle === large.handle ? 10000 : 30) } });
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(6000);
  expect(store.pending()).toEqual(pending);
});

it('retains inline original image parts and identifies their location when omitted', () => {
  const store = new DreamMaterials();
  const imageUrl = `data:image/png;base64,${Buffer.alloc(10000).toString('base64')}`;
  store.add([record({ type: 'message', role: 'user', content: [
    { type: 'input_image', image_url: imageUrl }, { type: 'input_text', text: 'caption' },
  ] }), message('user', 'later')]);
  const pending = store.pending();
  const input = prepareDreamInput(pending, { ...byteBudget, maxInputTokens: 8000, maxInputBytes: 4000,
    maxBackgroundTokens: 0, system: [], guide: '', state: '', background: '' });
  expect(input.included).toEqual(pending.map(material => material.id));
  expect(input.unreadImages).toEqual([{ id: pending[0]!.id, images: [{ recordIndex: 0, partIndex: 0 }] }]);
  expect(JSON.stringify(input.messages)).not.toContain(imageUrl);
  expect(JSON.stringify(input.messages)).toContain('caption');
  expect(JSON.stringify(input.messages)).toContain('[image not read]');
  expect(store.pending()).toEqual(pending);
});

it('keeps oversized-image material in the directory and admits later material when its remaining text also needs paging', () => {
  const store = new DreamMaterials();
  store.add([message('user', 'caption '.repeat(2000), { blobs: [
    { handle: 'log:large.png', mime: 'image/png', fallbackText: 'picture' },
  ] }), message('user', 'later')]);
  const pending = store.pending();
  const input = prepareDreamInput(pending, { maxInputTokens: 8000, maxInputBytes: 4000, maxBackgroundTokens: 0,
    blobBytes: () => 10000, system: [], guide: '', state: '', background: '' });
  expect(input.materialIds).toEqual(pending.map(material => material.id));
  expect(input.included).toEqual([pending[1]!.id]);
  expect(input.unreadImages[0]!.id).toBe(pending[0]!.id);
  expect(input.inputBytes).toBeLessThanOrEqual(4000);
  expect(store.pending()).toEqual(pending);
});

it('admits readable material when unread image captions fill the batch', () => {
  const store = new DreamMaterials();
  const blobs = [{ handle: 'log:large.png', mime: 'image/png', fallbackText: 'image' }];
  store.add([message('user', 'A'.repeat(300000), { blobs }), message('user', 'B'.repeat(150000), { blobs }), message('user', 'later')]);
  const pending = store.pending();
  const input = prepareDreamInput(pending, { ...byteBudget, maxInputTokens: PERSONA_DEFAULTS.dream.maxInputTokens!,
    blobBytes: () => 9 * 1024 * 1024, maxBackgroundTokens: 0, system: [], guide: '', state: '', background: '' });
  expect(input.included).toContain(pending[2]!.id);
  expect(input.materialIds).toEqual(pending.map(material => material.id));
  expect(input.unreadImages.map(material => material.id)).toEqual(pending.slice(0, 2).map(material => material.id));
  expect(input.inputTokens).toBeLessThanOrEqual(PERSONA_DEFAULTS.dream.maxInputTokens!);
  expect(input.inputBytes).toBeLessThanOrEqual(byteBudget.maxInputBytes);
  expect(store.pending()).toEqual(pending);
});

it('offers a text paging entry even when the directory already contains unread images', () => {
  const store = new DreamMaterials();
  store.add([message('user', 'caption '.repeat(2000), { blobs: [
    { handle: 'log:large.png', mime: 'image/png', fallbackText: 'image' },
  ] }), message('user', 'large text '.repeat(2000)), message('user', 'later')]);
  const pending = store.pending();
  const options = { maxInputTokens: 8000, maxInputBytes: 4000, maxBackgroundTokens: 0,
    blobBytes: () => 10000, system: [], guide: '', state: '', background: '' };
  const input = prepareDreamInput(pending, options);
  expect(input.materialIds).toContain(pending[1]!.id);
  expect(input.unreadImages.map(material => material.id)).toEqual([pending[0]!.id]);
  expect(input.included).not.toContain(pending[1]!.id);
  expect(store.read(pending[1]!.id, 0, 100)).toContain('large text');
  store.complete([pending[1]!.id]);
  expect(prepareDreamInput(store.pending(), options).included).toContain(pending[2]!.id);
  expect(store.pending().find(material => material.id === pending[0]!.id)).toEqual(pending[0]);
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

it('keeps one extra independent dream for each unread image and archives it without confirming the original', () => {
  const store = new DreamMaterials();
  const handle = 'log:large.png';
  store.add([message('user', 'caption', { blobs: [{ handle, mime: 'image/png', fallbackText: 'image' }] })]);
  const original = store.pending()[0]!;
  const unread = [{ id: original.id, images: [{ handle, recordIndex: 0 }] }];
  store.beginDream();
  store.recordUnread(unread);
  store.recordUnread(unread);
  expect(store.pending()[0]!.archivedImages).toBeUndefined();
  store.beginDream();
  store.recordUnread(unread);
  expect(store.pending()[0]!.archivedImages).toBeUndefined();
  store.beginDream();
  expect(store.pending()[0]!.archivedImages).toEqual(unread[0]!.images);
  const input = prepareDreamInput(store.pending(), { ...byteBudget, maxInputTokens: 8000, maxBackgroundTokens: 0,
    blobBytes: () => { throw new Error('Archived image bytes must not be loaded'); }, system: [], guide: '', state: '', background: '' });
  expect(input.unreadImages).toEqual([]);
  expect(input.archivedImages).toEqual(unread);
  expect(input.messages.flatMap(record => record.context.blobs ?? [])).toEqual([]);
  expect(JSON.stringify(input.messages)).toContain('[image archived unread]');
  store.complete(input.materialIds, 123);
  expect(store.pendingCount()).toBe(0);
  expect(store.list()[0]).toMatchObject({ completedAtMs: null, textCompletedAtMs: 123, archivedImages: unread[0]!.images });
  store.cleanup(1, 100 * 86400000);
  expect(store.list()).toHaveLength(1);
  expect(store.archivedUnreadCount()).toBe(1);
  expect(store.read(original.id, 0, 100)).toContain('caption');
});

it('counts the extra dream separately for images first omitted in different dreams', () => {
  const store = new DreamMaterials();
  const [id] = store.add([message('user', 'caption')]);
  const a = { recordIndex: 0, partIndex: 0 }, b = { recordIndex: 0, partIndex: 1 };
  store.beginDream();
  store.recordUnread([{ id: id!, images: [a] }]);
  store.beginDream();
  store.recordUnread([{ id: id!, images: [a, b] }]);
  store.beginDream();
  expect(store.pending()[0]!.archivedImages).toEqual([a]);
  store.recordUnread([{ id: id!, images: [a, b] }]);
  store.beginDream([{ id: id!, images: [a, b] }]);
  expect(store.pending()[0]!.archivedImages).toEqual([a, b]);
  store.beginDream([{ id: id!, images: [a, b] }]);
  expect(store.pending()[0]!.archivedImages).toEqual([a, b]);
});
