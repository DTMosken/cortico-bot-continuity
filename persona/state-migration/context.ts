/** Finite-context fallback replaces older repeatable read bodies; original telemetry remains intact. */
import { estimateMessagesTokens } from 'cortico/core/util.ts';
import { withText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';

export function trimMigrationReadFallback(messages: ContextRecord[], inputTokens: number): void {
  const target = inputTokens * 0.8;
  if (estimateMessagesTokens(messages) < target) return;
  const reads = new Set(['migration_sources', 'migration_history', 'migration_tools']);
  const calls = new Map<string, string>(), latest = new Map<string, string>();
  for (const record of messages) if (record.item.type === 'function_call' && reads.has(record.item.name)) {
    calls.set(record.item.call_id, record.item.name); latest.set(record.item.name, record.item.call_id);
  }
  for (let index = 0; index < messages.length; index++) {
    const record = messages[index];
    if (record.item.type !== 'function_call_output') continue;
    const name = calls.get(record.item.call_id);
    if (!name || latest.get(name) === record.item.call_id) continue;
    messages[index] = withText(record, '[migration read body omitted to preserve context] Original call arguments remain above. Read the source/history/tool again if its content is needed; the current draft and review findings remain in context.');
    if (estimateMessagesTokens(messages) < target) break;
  }
}
