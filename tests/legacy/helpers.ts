/** Persona(bots/corti-soulmate/persona)测试公共fixture:临时目录工作区、角色ctx、工具查找 */
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext, ToolDef } from '../../../Cortico/src/core/types.ts';
import type { PersonaRole } from '../../persona/permissions.ts';
import { nullLogger } from '../../../Cortico/src/core/util.ts';

/** 这份人格的工作区骨架(ContinuityPersona 构造时就是拿它去 ensureDirs 的) */
export { WORKSPACE_DIRS } from '../../persona/index.ts';

export function tmpPersona(): string {
  return mkdtempSync(join(tmpdir(), 'persona-test-'));
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows偶发句柄未释放,不影响断言
  }
}

export function ctxFor(role: PersonaRole): ToolCallContext {
  return { role, log: nullLogger() };
}

export function pick(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

/** 把文件mtime设为指定epoch秒(memo时间序控制) */
export function touch(absPath: string, epochSec: number): void {
  utimesSync(absPath, epochSec, epochSec);
}
