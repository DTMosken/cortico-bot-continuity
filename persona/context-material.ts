/** Snapshot cleanup preserves external event text and call/result identity. */
import { withText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { hasRole, textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import { HANDOFF_NOTE_TYPE } from '../base/persona/handoffNote.ts';

export function cleanSnapshot(snapshot: readonly ContextRecord[]): { records: ContextRecord[]; background: string } {
  const skip = new Set<string>();
  const results = new Map(snapshot.filter((entry) => entry.item.type === 'function_call_output')
    .map((entry) => [entry.item.type === 'function_call_output' ? entry.item.call_id : '', textOf(entry)]));
  let background = '';
  for (const entry of snapshot) {
    if (entry.item.type !== 'function_call' || entry.item.name !== 'read_file') continue;
    try {
      const path = JSON.parse(entry.item.arguments).path;
      const normalized = typeof path === 'string' ? path.replaceAll('\\', '/').replace(/^\.\//, '') : '';
      if (normalized.toLowerCase() === 'state/state.md') { skip.add(entry.item.call_id); continue; }
      if (normalized.startsWith('handoffs/')) {
        skip.add(entry.item.call_id);
        background = results.get(entry.item.call_id) ?? background;
      }
    } catch { /* Invalid historical tool arguments remain visible. */ }
  }
  const records: ContextRecord[] = [];
  for (const entry of snapshot) {
    if ((entry.item.type === 'function_call' || entry.item.type === 'function_call_output') && skip.has(entry.item.call_id)) continue;
    const refs = entry.context.frame?.events;
    let next = entry;
    if (refs?.some((ref) => ref.type === HANDOFF_NOTE_TYPE)) {
      const text = textOf(entry);
      const kept = refs.filter((ref) => ref.type !== HANDOFF_NOTE_TYPE);
      background = refs.filter((ref) => ref.type === HANDOFF_NOTE_TYPE).map((ref) => text.slice(ref.start, ref.start + ref.chars)).join('\n\n');
      let body = text.slice(0, refs[0]!.start);
      const events = kept.map((ref) => {
        const start = body.length;
        body += text.slice(ref.start, ref.start + ref.chars) + '\n';
        return { ...ref, start };
      });
      if (!kept.length && entry.item.type === 'function_call_output') {
        skip.add(entry.item.call_id);
        continue;
      }
      next = { ...withText(entry, body.trimEnd()), context: { ...entry.context, frame: { events } } };
    }
    if (hasRole(next, 'user')) {
      const text = textOf(next);
      const boundary = next.context.frame?.events[0]?.start ?? text.length;
      const head = text.slice(0, boundary)
        .replace(/^\[system\/(cognitive-frame|continuity-state)\][\s\S]*?^\[\/system\/\1\]\n?/gm, '')
        .replace(/^\[system\/(?:cognitive-frame|continuity-state)\][\s\S]*?(?=^\[(?:system(?:\]|\/)|surfaced from dream\])|$(?![\s\S]))/gm, '')
        .trimEnd();
      const tail = text.slice(boundary);
      const body = head + (head && tail ? '\n' : '') + tail;
      if (!body.trim()) continue;
      next = withText(next, body);
      if (next.context.frame) next = { ...next, context: { ...next.context, frame: { events: next.context.frame.events.map((ref) => ({ ...ref, start: ref.start + body.length - text.length })) } } };
    }
    records.push(next);
  }
  background = background.replace(/\[previous-handoff-background\][\s\S]*?\[\/previous-handoff-background\]/g, '').trim();
  return { records: records.filter((entry) => entry.item.type !== 'function_call' || !skip.has(entry.item.call_id)), background };
}
