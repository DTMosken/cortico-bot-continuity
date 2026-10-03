import type { PromptVarDecl } from 'cortico/core/types.ts';
import type { SubagentsConfig } from './config.ts';
import type { SpawnResult, Subagents } from './index.ts';
import { charSlice, type TaskRecord } from './store.ts';

export const SUBAGENT_VAR_DECLS: PromptVarDecl[] = [
  { name: 'subagents.availableTools', description: '按工具组列出的可委派工具；主线显示前缀装配时的快照，worker 显示本次分配。', multiline: true },
  { name: 'subagents.maxWorkers', description: '同时运行的任务上限。' },
  { name: 'subagents.softRounds', description: 'worker 收尾提示轮次。' },
  { name: 'subagents.maxRounds', description: 'worker 硬结束轮次。' },
  { name: 'subagents.maxSummaryChars', description: '完成摘要的字符上限。' },
  { name: 'subagents.resultPageChars', description: '完整结果查询的默认页长，单位字符。' },
];

export function subagentVars(config: SubagentsConfig, availableTools: string): Record<string, string> {
  return {
    'subagents.availableTools': availableTools,
    'subagents.maxWorkers': String(config.maxWorkers),
    'subagents.softRounds': String(config.softRounds),
    'subagents.maxRounds': String(config.maxRounds),
    'subagents.maxSummaryChars': String(config.maxSummaryChars),
    'subagents.resultPageChars': String(config.resultPageChars),
  };
}

export function subagentSection(title: string, text: string): string {
  return '━━━ ' + title + ' ━━━\n' + text;
}

export function subagentTaskText(assignment: { taskId: string; task: string; materials: string[] }): string {
  return [
    subagentSection('子代理任务', '任务 ID：' + assignment.taskId),
    subagentSection('任务要求', assignment.task),
    ...(assignment.materials.length
      ? assignment.materials.map((material, index) => subagentSection('材料 ' + (index + 1), material))
      : [subagentSection('材料', '无')]),
  ].join('\n\n');
}

function resultReference(record: Pick<TaskRecord, 'id' | 'resultChars'>): string {
  return '结果长度：' + record.resultChars + ' 字符\n读取：subagent_get(taskId="' + record.id + '")';
}

function taskDetails(record: Omit<TaskRecord, 'materials'>): string {
  return [
    '任务 ID：' + record.id, '状态：' + record.status,
    '开始时间：' + record.startedAt,
    ...(record.finishedAt ? ['结束时间：' + record.finishedAt] : []),
    '工具：' + (record.tools.join(', ') || '无'),
    '收尾轮数：' + record.softRounds, '轮数上限：' + record.maxRounds,
  ].join('\n');
}

export function subagentCompletionText(record: TaskRecord, maxSummaryChars: number): string {
  return [
    subagentSection('子代理任务结束', '任务 ID：' + record.id + '\n状态：' + record.status),
    subagentSection('摘要', charSlice(record.summary, 0, maxSummaryChars)),
    subagentSection('完整结果', resultReference(record)),
  ].join('\n\n');
}

export function subagentSpawnText(result: SpawnResult): string {
  if (result.accepted) return subagentSection('子代理任务已启动', '任务 ID：' + result.taskId + '\n状态：' + result.status);
  return [
    subagentSection('子代理任务未启动', '原因：' + result.reason),
    ...(result.availableTools !== undefined ? [subagentSection('当前可用工具', result.availableTools)] : []),
  ].join('\n\n');
}

export function subagentListText(page: ReturnType<Subagents['list']>, args: Record<string, unknown>): string {
  return [
    subagentSection('子代理任务列表', '任务总数：' + page.total + '\n本页任务数：' + page.tasks.length),
    ...page.tasks.flatMap((record, index) => [
      subagentSection('任务 ' + (index + 1), taskDetails(record)),
      subagentSection('任务要求', record.task),
      subagentSection('摘要', record.summary || '暂无摘要'),
      subagentSection('完整结果', resultReference(record)),
    ]),
    subagentSection('任务分页', page.nextOffset === null
      ? '已到任务列表末尾。' : '下一页：subagent_list(offset=' + page.nextOffset
        + (args.limit === undefined ? '' : ', limit=' + args.limit)
        + (args.status === undefined ? '' : ', status="' + args.status + '"') + ')'),
  ].join('\n\n');
}

export function subagentResultText(page: ReturnType<Subagents['get']>, maxChars: unknown): string {
  return [
    subagentSection('子代理任务', taskDetails(page)),
    subagentSection('任务要求', page.task),
    subagentSection('摘要', page.summary || '暂无摘要'),
    subagentSection('完整结果', '结果长度：' + page.resultChars + ' 字符\n起始字符位置：' + page.offsetChars + '\n\n' + page.result),
    subagentSection('结果分页', page.nextOffset === null ? '已到完整结果末尾。'
      : '下一页：subagent_get(taskId="' + page.id + '", offsetChars=' + page.nextOffset
        + (maxChars === undefined ? '' : ', maxChars=' + maxChars) + ')'),
  ].join('\n\n');
}
