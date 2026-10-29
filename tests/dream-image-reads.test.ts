import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogBlobStore } from 'cortico/core/blobs.ts';
import { functionCall, functionResult } from 'cortico/protocol/open-responses/context.ts';
import { makeTool } from '../../Cortico/tests/core/helpers.ts';
import { GitWorkspaceMemory } from '../base/persona/memory.ts';
import { createImageReadObserver } from '../persona/subconscious/image-reads.ts';
import type { UnreadMaterialImages } from '../persona/subconscious/materials.ts';

it('confirms a URL only after a matching declared URL read returns an image to the model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-url-read-'));
  try {
    const store = new LogBlobStore(dir), handle = store.put(Buffer.from('image'), 'image/png');
    const url = 'https://example.invalid/image.png';
    const unread: UnreadMaterialImages[] = [{ id: 'material', images: [{ recordIndex: 0, partIndex: 0, url }] }];
    const tool = { ...makeTool('open_image', ''), tags: ['read'] as const,
      parameters: { type: 'object', properties: { url: { type: 'string' } } } };
    const changes: string[][] = [];
    const observe = createImageReadObserver(unread, ref => store.read(ref), ids => changes.push(ids), [tool]);
    const calls = [functionCall('unrelated', 'open_image', JSON.stringify({ url: url + '/other', note: url })),
      functionResult('unrelated', 'image', { blobs: [{ handle, mime: 'image/png', fallbackText: 'image' }] }),
      functionCall('text-only', 'open_image', JSON.stringify({ url })), functionResult('text-only', 'No image available')];
    observe(calls);
    expect(unread).toHaveLength(1);
    calls.push(functionCall('matching', 'open_image', JSON.stringify({ url })));
    observe(calls);
    expect(unread).toHaveLength(1);
    calls.push(functionResult('matching', 'image', { blobs: [{ handle, mime: 'image/png', fallbackText: 'image' }] }));
    observe(calls);
    expect(unread).toEqual([]);
    expect(changes).toEqual([['material']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('hashes immutable images once, observes each receipt once and persists only changed material IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-image-hashes-'));
  try {
    const store = new LogBlobStore(dir), memory = new GitWorkspaceMemory({ memoryDir: join(dir, 'memory') });
    const a = Buffer.from('A'), b = Buffer.from('B');
    const first = store.put(a, 'image/png'), second = store.put(b, 'image/png');
    const saved = memory.blobs.put('blobs/current.png', a, 'image/png');
    const loads = new Map<string, number>(), changes: string[][] = [];
    const unread: UnreadMaterialImages[] = [{ id: 'first', images: [{ handle: first, recordIndex: 0 }] },
      { id: 'duplicate', images: [{ handle: first, recordIndex: 0 }] },
      { id: 'second', images: [{ handle: second, recordIndex: 0 }] }];
    const observe = createImageReadObserver(unread, handle => {
      loads.set(handle, (loads.get(handle) ?? 0) + 1);
      return handle.startsWith('mem:') ? memory.blobs.get(handle) : store.read(handle);
    }, ids => changes.push(ids), []);
    const records = [functionResult('first-read', 'image', { blobs: [{ handle: saved, mime: 'image/png', fallbackText: 'image' }] })];
    observe(records); observe(records);
    expect(changes).toEqual([['first', 'duplicate']]);
    memory.blobs.put('blobs/current.png', b, 'image/png');
    records.push(functionResult('second-read', 'image', { blobs: [{ handle: saved, mime: 'image/png', fallbackText: 'image' }] }));
    observe(records); observe(records);
    expect(unread).toEqual([]);
    expect(changes).toEqual([['first', 'duplicate'], ['second']]);
    expect(loads.get(saved)).toBe(2);
    expect(loads.get(first)).toBe(1);
    expect(loads.get(second)).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
