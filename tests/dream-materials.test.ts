import { expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { functionCall, functionResult, message, record } from 'cortico/protocol/open-responses/context.ts';
import { estimateMessagesTokens } from 'cortico/core/util.ts';
import { DreamMaterials, prepareDreamInput } from '../persona/subconscious/materials.ts';
import { responsesInput } from '../../Cortico/src/providers/transport/responses-input.ts';
import { PERSONA_DEFAULTS } from '../persona/config.ts';

const byteBudget = { maxInputBytes: PERSONA_DEFAULTS.dream.maxInputBytes! };

it('omits waking reasoning from new and retained materials while preserving legacy image positions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-material-view-'));
  try {
    const store = new DreamMaterials(dir);
    const thought = record({ type: 'reasoning', id: 'reason', content: [{ type: 'reasoning_text', text: 'old thought' }],
      summary: [{ type: 'summary_text', text: 'old summary' }], encrypted_content: 'old ciphertext' });
    const caption = message('user', 'original event', { blobs: [{ handle: 'log:image', mime: 'image/png', fallbackText: 'image' }] });
    const [id] = store.add([thought, caption]);
    const raw = join(dir, 'raw', id + '.json');
    expect(JSON.parse(readFileSync(raw, 'utf8'))).toEqual([caption]);

    writeFileSync(raw, JSON.stringify([thought, caption]));
    const resumed = new DreamMaterials(dir);
    const input = prepareDreamInput(resumed.pending(), { ...byteBudget, maxInputTokens: 8000, system: [], guide: '', state: '' });
    expect(input.materialIds).toEqual([id]);
    expect(JSON.stringify(input.messages)).not.toContain('handoffs/');
    expect(input.unreadImages[0]?.images[0]?.recordIndex).toBe(1);
    expect(JSON.stringify(input.messages)).not.toMatch(/old thought|old summary|old ciphertext/);
    const page = JSON.parse(resumed.read(id!, 0, 12000)).text;
    expect(page).toContain('original event');
    expect(page).not.toMatch(/old thought|old summary|old ciphertext/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['data:image/png;base64,AA==', 'https://example.invalid/image.png'])('keeps an image-only material as a reference: %s', imageUrl => {
  const store = new DreamMaterials();
  const source = record({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: imageUrl }] });
  store.add([source]);
  const input = prepareDreamInput(store.pending(), { ...byteBudget, maxInputTokens: 8000, system: [], guide: '', state: '' });
  expect(input.messages.some(entry => entry.item.type === 'message' && Array.isArray(entry.item.content)
    && entry.item.content.some(part => part.type === 'input_image'))).toBe(false);
  expect(input.unreadImages[0]!.images).toEqual([{ recordIndex: 0, partIndex: 0, ...(imageUrl.startsWith('https:') ? { url: imageUrl } : {}) }]);
  if (imageUrl.startsWith('data:')) expect(JSON.stringify(input.messages)).not.toContain(imageUrl);
  else expect(JSON.stringify(input.messages)).toContain(imageUrl);
  expect(store.pending()[0]!.records).toEqual([source]);
});

it('retains a paged material image URL in both the directory metadata and paged text', () => {
  const store = new DreamMaterials(), url = 'https://example.invalid/image.png';
  store.add([record({ type: 'message', role: 'user', content: [
    { type: 'input_text', text: 'caption '.repeat(10000) }, { type: 'input_image', image_url: url },
  ] }), message('user', 'later')]);
  const input = prepareDreamInput(store.pending(), { maxInputBytes: 4000, maxInputTokens: 8000, system: [], guide: '', state: '' });
  const first = store.list()[0]!;
  expect(input.included).not.toContain(first.id);
  expect(input.unreadImages[0]!.images[0]!.url).toBe(url);
  let next = 0, text = '';
  for (;;) {
    const page = JSON.parse(store.read(first.id, next, 12000)); text += page.text;
    if (page.next >= page.totalChars) break;
    next = page.next;
  }
  expect(text).toContain(url);
});

it('injects only image references even when many complete images would exceed the byte budget', () => {
  const store = new DreamMaterials();
  const bytes = Buffer.alloc(1024 * 1024);
  const ref = { handle: 'log:fixture.png', mime: 'image/png', fallbackText: 'picture' };
  store.add(Array.from({ length: 20 }, () => message('user', 'picture', { blobs: [ref] })));
  const pending = store.pending();
  const options = { maxInputTokens: 8000, maxInputBytes: 2 * 1024 * 1024,
    system: [], guide: '', state: '' };
  const input = prepareDreamInput(pending, options);
  expect(input.included).toEqual(pending.map(material => material.id));
  expect(input.unreadImages).toHaveLength(20);
  expect(input.messages.flatMap(record => record.context.blobs ?? [])).toEqual([]);
  expect(input.inputBytes).toBeLessThanOrEqual(options.maxInputBytes);
  expect(JSON.stringify(input.messages)).toContain(ref.handle);
  expect(store.pending()).toEqual(pending);
});

it('keeps prefix and tool-output image references within the reserved schema budget', () => {
  const store = new DreamMaterials();
  const ref = { handle: 'log:fixture.png', mime: 'image/png', fallbackText: 'picture' };
  store.add([message('user', 'first'), functionCall('one', 'lookup', '{}'), functionResult('one', 'result', { blobs: [ref] }),
    message('user', 'second'), functionCall('two', 'lookup', '{}'), functionResult('two', 'result', { blobs: [ref] })]);
  const pending = store.pending();
  const options = { maxInputTokens: 8000, maxInputBytes: 40000, system: [message('user', 'prefix', { blobs: [ref] })], guide: '', state: '' };
  expect(prepareDreamInput(pending, options).included).toEqual(pending.map(material => material.id));
  const withoutPrefix = { ...options, system: [] };
  expect(prepareDreamInput(pending, withoutPrefix).included).toEqual(pending.map(material => material.id));
  expect(prepareDreamInput(pending, { ...withoutPrefix, reservedBytes: 14000 }).inputBytes).toBeGreaterThan(14000);
});

it('omits unreadable and non-image blob payloads and still enforces UTF-8 text bytes', () => {
  const store = new DreamMaterials();
  store.add([message('user', 'first', { blobs: [
    { handle: 'log:missing.png', mime: 'image/png', fallbackText: 'missing picture' },
    { handle: 'log:file.pdf', mime: 'application/pdf', fallbackText: 'document' },
  ] }), message('user', 'second')]);
  const input = prepareDreamInput(store.pending(), { ...byteBudget, maxInputBytes: 4000, maxInputTokens: 8000,
    system: [], guide: '', state: '' });
  expect(input.included).toHaveLength(2);
  const textStore = new DreamMaterials();
  textStore.add([message('user', '汉'.repeat(1000)), message('user', 'later')]);
  const paged = prepareDreamInput(textStore.pending(), { ...byteBudget, maxInputBytes: 2500, maxInputTokens: 8000,
    system: [], guide: '', state: '' });
  expect(paged.included).toEqual([]);
  expect(paged.materialIds).toEqual([textStore.list()[0]!.id]);
});

it('omits oversized images from input while retaining their handles and later materials', () => {
  const store = new DreamMaterials();
  store.add([message('user', 'picture', { blobs: [
    { handle: 'log:fixture.png', mime: 'image/png', fallbackText: 'picture' },
  ] }), message('user', 'later')]);
  const pending = store.pending();
  const input = prepareDreamInput(pending, { maxInputTokens: 8000, maxInputBytes: 4000, system: [], guide: '', state: '',
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

it('retains tool-output image references and repeated handles without loading image payloads', () => {
  const store = new DreamMaterials();
  const large = { handle: 'log:large.png', mime: 'image/png', fallbackText: 'large' };
  const small = { handle: 'log:small.png', mime: 'image/png', fallbackText: 'small' };
  store.add([message('user', 'caption', { blobs: [large, small] }), functionCall('one', 'lookup', '{}'),
    functionResult('one', 'receipt', { blobs: [large] }), message('user', 'later')]);
  const pending = store.pending();
  const input = prepareDreamInput(pending, { maxInputTokens: 8000, maxInputBytes: 6000, system: [], guide: '', state: '' });
  expect(input.included).toEqual(pending.map(material => material.id));
  expect(input.messages.flatMap(record => record.context.blobs ?? [])).toEqual([]);
  expect(input.unreadImages).toEqual([{ id: pending[0]!.id, images: [
    { handle: large.handle, recordIndex: 0 }, { handle: small.handle, recordIndex: 0 }, { handle: large.handle, recordIndex: 2 },
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
    system: [], guide: '', state: '' });
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
  const input = prepareDreamInput(pending, { maxInputTokens: 8000, maxInputBytes: 4000, system: [], guide: '', state: '' });
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
    system: [], guide: '', state: '' });
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
  const options = { maxInputTokens: 8000, maxInputBytes: 4000, system: [], guide: '', state: '' };
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
    const input = prepareDreamInput(store.pending(), { ...byteBudget, maxInputTokens: 8000, system: [message('system', 'system')], guide: 'instructions', state: 'current' });
    expect(estimateMessagesTokens(input.messages)).toBeLessThanOrEqual(8000);
    expect(input.materialIds).toEqual([store.list()[0]!.id]);
    expect(input.included).toEqual([]);
    expect(input.omitted).toHaveLength(2);
    const restored = new DreamMaterials(dir);
    expect(restored.read(input.materialIds[0]!, 0, 1000)).toContain('old');
    restored.complete(input.materialIds, 0);
    const next = prepareDreamInput(restored.pending(), { ...byteBudget, maxInputTokens: 8000, system: [message('system', 'system')], guide: 'instructions', state: 'current' });
    expect(next.messages.some((record) => record.item.type === 'function_call' && record.item.call_id === 'r')).toBe(true);
    expect(next.messages.some((record) => record.item.type === 'function_call_output' && record.item.call_id === 'r')).toBe(true);
    restored.cleanup(1, 2 * 86400000);
    expect(restored.pending()).toHaveLength(1);
    expect(restored.read(next.materialIds[0]!, 0, 1000)).toContain('recent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('cleans up expired materials whose raw file is already missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-materials-'));
  try {
    const store = new DreamMaterials(dir);
    const ids = store.add([message('user', 'gone'), message('user', 'kept')]);
    store.complete(ids, 0);
    rmSync(join(dir, 'raw', `${ids[0]}.json`));
    expect(() => store.cleanup(1, 2 * 86400000)).not.toThrow();
    expect(new DreamMaterials(dir).list()).toEqual([]);
    expect(existsSync(join(dir, 'raw', `${ids[1]}.json`))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('fills a batch from the oldest pending records within the input budget', () => {
  const store = new DreamMaterials();
  store.add([message('user', 'old '.repeat(1500)), message('user', 'new '.repeat(1500))]);
  const pending = store.pending();
  const options = { ...byteBudget, maxInputTokens: 3000, system: [], guide: '', state: '' };
  const input = prepareDreamInput(pending, options);
  expect(input.materialIds).toEqual([pending[0]!.id]);
  expect(input.included).toEqual(input.materialIds);
  expect(input.omitted).toEqual([pending[1]!.id]);
  expect(estimateMessagesTokens(input.messages)).toBeLessThanOrEqual(options.maxInputTokens);
});

it('expires archived-image materials from their text confirmation and deletes their raw files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-materials-'));
  try {
    const handle = 'log:large.png';
    const store = new DreamMaterials(dir);
    const [archived, plain] = store.add([message('user', 'caption', { blobs: [{ handle, mime: 'image/png', fallbackText: 'image' }] }),
      message('user', 'plain')]);
    const unread = [{ id: archived!, images: [{ handle, recordIndex: 0 }] }];
    store.complete([archived!, plain!], 1000, unread);
    expect(store.list().find(item => item.id === archived)!.archivedImages).toEqual(unread[0]!.images);
    expect(store.list().map(item => [item.completedAtMs, item.textCompletedAtMs])).toEqual([[null, 1000], [1000, undefined]]);

    store.cleanup(1, 1000 + 86400000 - 1);
    const kept = new DreamMaterials(dir);
    expect(kept.list().map(item => item.id)).toEqual([archived, plain]);
    expect(kept.read(archived!, 0, 100)).toContain('caption');

    kept.cleanup(1, 1000 + 86400000);
    expect(new DreamMaterials(dir).list()).toEqual([]);
    expect(existsSync(join(dir, 'raw', `${archived}.json`))).toBe(false);
    expect(existsSync(join(dir, 'raw', `${plain}.json`))).toBe(false);
    expect(kept.archivedUnreadCount()).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('expires ordinary materials from completedAtMs and keeps unconfirmed ones', () => {
  const store = new DreamMaterials();
  const [confirmed, pending] = store.add([message('user', 'confirmed'), message('user', 'pending')]);
  store.complete([confirmed!], 0);
  store.cleanup(1, 86400000 - 1);
  expect(store.list().map(item => item.id)).toEqual([confirmed, pending]);
  store.cleanup(1, 86400000);
  expect(store.list().map(item => item.id)).toEqual([pending]);
  store.cleanup(1, 100 * 86400000);
  expect(store.pending().map(item => item.id)).toEqual([pending]);
});

it('keeps archived inline image coordinates and original records when preparing input', () => {
  const store = new DreamMaterials();
  const large = 'data:image/png;base64,' + 'A'.repeat(20000);
  const nextLarge = 'data:image/png;base64,' + 'B'.repeat(10000);
  const small = 'data:image/png;base64,AA==';
  const original = record({ type: 'message', role: 'user', content: [
    { type: 'input_text', text: 'caption' }, { type: 'input_image', image_url: large },
    { type: 'input_image', image_url: nextLarge }, { type: 'input_image', image_url: small },
  ] });
  const [id] = store.add([original]);
  const first = [{ id: id!, images: [{ recordIndex: 0, partIndex: 1 }] }];
  const materials = store.pending();
  materials[0]!.archivedImages = first[0]!.images;
  const input = prepareDreamInput(materials, { ...byteBudget, maxInputBytes: 6000, maxInputTokens: 8000,
    system: [], guide: '', state: '' });
  expect(input.archivedImages).toEqual(first);
  expect(input.unreadImages).toEqual([{ id, images: [{ recordIndex: 0, partIndex: 2 }, { recordIndex: 0, partIndex: 3 }] }]);
  const encoded = JSON.stringify(input.messages);
  expect(encoded).not.toContain(large);
  expect(encoded).not.toContain(nextLarge);
  expect(encoded).not.toContain(small);
  expect(input.inputBytes).toBeLessThanOrEqual(6000);
  expect(store.pending()[0]!.records).toEqual([original]);
});

it('skips an undeletable raw file, keeps it indexed and expires the remaining materials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-materials-'));
  try {
    const warnings: unknown[] = [];
    const store = new DreamMaterials(dir, { warn: (msg: string, data?: unknown) => { warnings.push({ msg, data }); } });
    const ids = store.add([message('user', 'blocked'), message('user', 'second'), message('user', 'third')]);
    store.complete(ids, 0);
    const blocked = join(dir, 'raw', `${ids[0]}.json`);
    rmSync(blocked);
    mkdirSync(blocked);
    expect(() => store.cleanup(1, 2 * 86400000)).not.toThrow();
    expect(new DreamMaterials(dir).list().map(item => item.id)).toEqual([ids[0]]);
    for (const id of ids.slice(1)) expect(existsSync(join(dir, 'raw', `${id}.json`))).toBe(false);
    expect(warnings).toHaveLength(1); expect(JSON.stringify(warnings[0])).toContain(ids[0]);
    rmSync(blocked, { recursive: true });
    new DreamMaterials(dir).cleanup(1, 2 * 86400000);
    expect(new DreamMaterials(dir).list()).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
