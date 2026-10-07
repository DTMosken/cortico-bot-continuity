/**
 * Cormini 文件工具之外,这份人格实现自己的三样:memo 容量守门、`move_file`、
 * `schedule_wake` 的 schema,以及两条认知路径的 "Using your tools" 文案。
 */
import type { ToolDef, ToolSpec } from 'cortico/core/types.ts';
import { WorkspaceError, type GitWorkspaceMemory } from '../base/persona/memory.ts';
import { MemoTiers } from './memoTiers.ts';
import type { PersonaRole } from './permissions.ts';

/** JSON Schema 简写 */
const S = (props: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  required,
});

/** memo 三层归属(仅一级文件);其它路径返回 null */
function memoTierOf(ws: GitWorkspaceMemory, rel: string): 'resident' | 'active' | 'archived' | null {
  const n = ws.normalize(rel);
  if (/^memo\/active\/[^/]+$/i.test(n)) return 'active';
  if (/^memo\/archived\/[^/]+$/i.test(n)) return 'archived';
  if (/^memo\/[^/]+$/i.test(n)) return 'resident';
  return null;
}

const quote = (names: string[]): string =>
  names.length ? names.map((n) => `"${n}"`).join(', ') : '(none)';

/**
 * 容量守门:向已满的层新建文件时硬拦(容量是Persona的合法机械规则)。
 * 只拦"新增一个文件":覆写已存在的、同层内改名都不增加数量,放行。
 * fromRel 给出时(move_file)用于识别同层搬运。满时引导用 move_file 手动下沉。
 */
export function memoCapGuard(ws: GitWorkspaceMemory, memo: MemoTiers, destRel: string, fromRel?: string): string | null {
  const tier = memoTierOf(ws, destRel);
  const fromTier = fromRel ? memoTierOf(ws, fromRel) : null;
  if (tier === 'resident' && !ws.exists(destRel) && fromTier !== 'resident') {
    const residents = memo.residentFiles();
    if (residents.length >= memo.caps.residentCap) {
      return (
        `memo/ (resident, shown in full every prefix) is full (${residents.length}/${memo.caps.residentCap}). ` +
        `Move one down to memo/active/ with move_file first, then retry. Current residents: ${quote(residents)}.`
      );
    }
  }
  if (tier === 'active' && !ws.exists(destRel) && fromTier !== 'active') {
    const actives = memo.activeFiles();
    if (actives.length >= memo.caps.activeCap) {
      return (
        `memo/active/ is full (${actives.length}/${memo.caps.activeCap}). ` +
        `Move one down to memo/archived/ with move_file first, then retry. Current active/: ${quote(actives)}.`
      );
    }
  }
  return null;
}

export interface MoveFileDeps {
  ws: GitWorkspaceMemory;
  /** 写准入(同Persona的 writeGuard):返回理由就拒绝 */
  guard: (op: 'rename' | 'write', path: string, role: string) => string | null;
  capGuard: (to: string, from: string) => string | null;
}

/** 工作区内移动或改名。memo 层间搬运走它;父目录按需创建。 */
export function moveFileTool(deps: MoveFileDeps): ToolDef {
  const { ws } = deps;
  return {
    name: 'move_file',
    description: 'Move or rename a file within your workspace. Use it to shift a memo between tiers when one is full '
      + '(memo/ → memo/active/ → memo/archived/); parent folders are created as needed.',
    tags: ['write'],
    parameters: S({
      from: { type: 'string', description: 'Current path, relative to your workspace.' },
      to: { type: 'string', description: 'New path, relative to your workspace.' },
    }, ['from', 'to']),
    handler: async (args, ctx) => {
      const from = String(args.from ?? '');
      const to = String(args.to ?? '');
      if (!from || !to) return '[move failed] from 与 to 都要给';
      const denied = deps.guard('rename', from, ctx.role) ?? deps.guard('write', to, ctx.role) ?? deps.capGuard(to, from);
      if (denied) return `[move failed] ${denied}`;
      try {
        ws.renameFile(from, to);
      } catch (e) {
        if (e instanceof WorkspaceError) return `[move failed] ${e.message}`;
        return `[move failed] ${e instanceof Error ? e.message : String(e)}`;
      }
      return `[moved] ${ws.normalize(from)} → ${ws.normalize(to)}`;
    },
  };
}

/** `schedule_wake` 的 schema;handler 由Persona接到 WakeManager 上。 */
export function scheduleWakeSpec(): ToolSpec {
  return {
    name: 'schedule_wake',
    description:
      'Schedule a wake at either an absolute time or a relative number of minutes. Optionally block live event delivery until then, with a literal keyword for early wake and a bounded overflow release.',
    tags: ['flow'],
    parameters: {
      ...S({
        at: {
          type: 'string',
          description: 'Absolute ISO 8601 timestamp with timezone offset. Use either at or after_minutes.',
        },
        after_minutes: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Relative delay in minutes. Decimals are allowed; values below 10 seconds are raised to 10 seconds.',
        },
        note: { type: 'string', description: 'Text returned when the wake fires.' },
        block: {
          type: 'boolean',
          default: false,
          description:
            'If true, hold live event delivery until this wake fires or wake_keyword matches. Manual operator pause remains independent.',
        },
        wake_keyword: {
          type: 'string',
          minLength: 1,
          description:
            'Optional, only used with block=true. A case-sensitive literal substring match in a new external event wakes early and cancels this wake.',
        },
        overflow_limit: {
          type: 'integer',
          minimum: 1,
          default: 100,
          description:
            'Only used with block=true. When queued external events exceed this count, release the current batch once while keeping the block and scheduled wake active.',
        },
      }, ['note']),
      oneOf: [{ required: ['at'] }, { required: ['after_minutes'] }],
    },
  };
}

export function toolUsageText(role: PersonaRole, caps: { residentCap: number; activeCap: number }): string {
  switch (role) {
    case 'subagent':
      return 'Memory is read-only. Use assigned read tools and return proposed changes in result.';
    case 'main':
      return [
        '* Paths are relative to your workspace; tool schemas define operations and parameters.',
        '* Run independent tool calls in parallel when possible.',
        '* External speech arrives in `external_event_frame` deliveries. User messages are internal machinery: ticks, wakes and notices.',
        '* When you are done acting, call `end_turn`; making no more tool calls also ends the turn.',
        '* Direct output is private thought. To communicate, use the World speaking tools and follow their sending flow.',
        '* `note/` holds long-term notes, read on demand. Organize `note/library/` as you choose.',
        `* \`memo/\` holds current schedules, events and deadlines: ${caps.residentCap} resident files, up to ${caps.activeCap} in \`active/\`. When full, use \`move_file\` to move a file down (resident → \`active/\` → \`archived/\`) before adding another; nothing moves automatically.`,
        '* You may create, rename and delete files in `external/` freely.',
        '* `MEMORY 0–4` is a snapshot from the last system-prefix build. File writes take effect immediately; reload or handoff refreshes the snapshot. Use tool receipts to track later changes.',
        '* Each `people/` file’s first line supplies its name and summary to the roster. Append observations below it; the dream revises the first line.',
        "* When speaking, rely on your workspace content firstly, only reply with professional level knowledge when you judge it's necessary.",
      ].join('\n');
    case 'dream':
      return [
        'You are the only rewriter of this workspace: read, write, append, edit, move and delete are all open to you, CONSTITUTION.md included.',
        '',
        '* `edit_file` requires `old_string` to match exactly once; for large changes, replace the whole file with `write_file`',
        `* memo tiers are plain folders you keep in shape with \`move_file\` (${caps.residentCap} resident shown in full, up to ${caps.activeCap} in \`active/\`, cold storage in \`archived/\`); caps are enforced when writing, so move a file down before overfilling a tier`,
        '* Renaming discipline: when adjusting filenames (alias strings) under `people/`, never drop an alias that could still be used to find someone — a rename that breaks the retrieval path is the violation, not the rename itself',
        '* `CONSTITUTION.md` changes require judgment, not elapsed time: apply a change only when the evidence supports it, it is necessary now, and it is likely to remain useful. No fixed waiting period or evidence count is required',
        '* For `CONSTITUTION.md` section `# 我喜欢的语言风格`, assess Behavior → Feedback globally across sessions and independent interactions, then consolidate durable preferences instead of overfitting the latest reaction',
        '* When done, confirm complete or partial consolidation with `surface`; its schema describes the closure fields. Text may be empty; nonempty text reaches the waking thread.',
      ].join('\n');
  }
}
