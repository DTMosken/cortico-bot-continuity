/** Request context carries current time reminders and a fallback for repeatable read bodies. */
import { estimateMessagesTokens } from 'cortico/core/util.ts';
import { message, withText, type ContextRecord } from 'cortico/protocol/open-responses/context.ts';
import { textOf } from 'cortico/protocol/open-responses/context-helpers.ts';
import type { MigrationTiming } from './contracts.ts';

export function migrationTimeBudget(timing?: MigrationTiming, now = Date.now()) {
  if (!timing) return undefined;
  const remainingMs = Math.max(0, timing.deadlineAtMs - now);
  return { remainingSeconds: Math.ceil(remainingMs / 1000), finishingReserveSeconds: Math.ceil(timing.finishingReserveMs / 1000),
    phase: remainingMs <= timing.finishingReserveMs ? 'finishing' : 'drafting' };
}

export function updateMigrationTimeReminder(messages: ContextRecord[], timing?: MigrationTiming): void {
  const budget = migrationTimeBudget(timing);
  if (!budget) return;
  const prefix = '[migration time budget]';
  for (let index = messages.length - 1; index >= 0; index--) {
    const record = messages[index];
    if (record.item.type === 'message' && record.item.role === 'user' && textOf(record).startsWith(prefix)) messages.splice(index, 1);
  }
  const guidance = budget.phase === 'finishing'
    ? 'Use remaining time to consolidate once, check the current draft, replay affected allow/remind boundaries and finish. Stop optional exploration, extra examples and cosmetic rewrites; fix known substantive defects. Edits still require checking and replay. Time pressure cannot justify weakening requirements or accepting an unchecked draft.'
    : 'Reserve the finishing budget for consolidation, the final source check, affected allow/remind replays and completion. Reach a source-faithful draft before that reserve begins; finish earlier when ready.';
  messages.push(message('user', `${prefix} ${JSON.stringify(budget)}\n${guidance}`));
}

export function trimMigrationReadFallback(messages: ContextRecord[], inputTokens: number): void {
  const target = inputTokens * 0.8;
  if (estimateMessagesTokens(messages) < target) return;
  const reads = new Set(['read_file', 'grep_files', 'glob_files', 'list_files']);
  const notice = '[migration read body omitted to preserve context] Original call arguments remain above. Read the source/history/tool again if its content is needed; the current draft and review findings remain in context.';
  const calls = new Map<string, string>(), latest = new Map<string, string>();
  for (const record of messages) if (record.item.type === 'function_call' && reads.has(record.item.name)) {
    calls.set(record.item.call_id, record.item.name); latest.set(record.item.name, record.item.call_id);
  }
  for (let index = 0; index < messages.length; index++) {
    const record = messages[index];
    if (record.item.type !== 'function_call_output') continue;
    const name = calls.get(record.item.call_id);
    if (!name || latest.get(name) === record.item.call_id) continue;
    if (textOf(record).length <= notice.length) continue;
    messages[index] = withText(record, notice);
    if (estimateMessagesTokens(messages) < target) break;
  }
}
