/** Read evidence comes from image tool receipts included in a successful model request. */
import { createHash } from 'node:crypto';
import type { CoreApi, ToolDef } from 'cortico/core/types.ts';
import type { ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { UnreadMaterialImages } from './materials.ts';

function contains(value: unknown, url: string): boolean {
  return value === url || (value !== null && typeof value === 'object' && Object.values(value).some(child => contains(child, url)));
}

export function createImageReadObserver(unread: UnreadMaterialImages[], blob: CoreApi['blob'], changed: (ids: string[]) => void, tools: readonly ToolDef[]) {
  const originalDigests = new Map<string, string>();
  const immutableDigests = new Map<string, string>();
  const loaded = new Set<string>(), loadedUrls = new Set<string>();
  const urls = new Set(unread.flatMap(entry => entry.images.flatMap(image => image.url ? [image.url] : [])));
  const requestedUrls = new Map<string, string[]>();
  const urlFields = new Map(tools.filter(tool => tool.tags.includes('read')).map(tool => [tool.name,
    Object.entries((tool.parameters.properties ?? {}) as Record<string, { format?: string }>)
      .filter(([name, schema]) => /^(urls?|image_urls?)$/.test(name) || schema.format === 'uri').map(([name]) => name)]));
  let seen = 0;
  const digest = (handle: string): string | null => {
    if (handle.startsWith('log:') && immutableDigests.has(handle)) return immutableDigests.get(handle)!;
    const source = blob(handle);
    const value = source ? createHash('sha256').update(source.bytes).digest('hex') : null;
    if (handle.startsWith('log:') && value) immutableDigests.set(handle, value);
    return value;
  };
  return (messages: readonly ContextRecord[]): void => {
    if (!unread.length) return;
    let hasNewImage = false;
    for (const entry of messages.slice(seen)) {
      const item = entry.item;
      if (item.type === 'function_call' && urls.size) {
        try {
          const args = JSON.parse(item.arguments) as Record<string, unknown>;
          requestedUrls.set(item.call_id, [...urls].filter(url => (urlFields.get(item.name) ?? []).some(field => contains(args[field], url))));
        }
        catch { /* Invalid historical arguments provide no URL read evidence. */ }
      }
      if (item.type !== 'function_call_output' || textOf(entry).startsWith('[failed]')) continue;
      let hasImage = false;
      for (const ref of entry.context.blobs ?? []) if (ref.mime.startsWith('image/')) {
        const value = digest(ref.handle);
        if (value) { loaded.add(value); hasImage = true; hasNewImage = true; }
      }
      if (hasImage) for (const url of requestedUrls.get(item.call_id) ?? []) loadedUrls.add(url);
    }
    seen = messages.length;
    if (!hasNewImage) return;
    const ids: string[] = [];
    for (const entry of [...unread]) {
      const remaining = entry.images.filter(image => {
        if (image.url && loadedUrls.has(image.url)) return false;
        if (!image.handle) return true;
        if (!originalDigests.has(image.handle)) {
          const value = digest(image.handle);
          if (value) originalDigests.set(image.handle, value);
        }
        const value = originalDigests.get(image.handle);
        return !value || !loaded.has(value);
      });
      if (remaining.length === entry.images.length) continue;
      entry.images = remaining;
      if (!remaining.length) unread.splice(unread.indexOf(entry), 1);
      ids.push(entry.id);
    }
    if (ids.length) changed(ids);
  };
}
