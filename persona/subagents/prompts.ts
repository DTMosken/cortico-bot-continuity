import type { PromptVarDecl } from 'cortico/core/types.ts';
import type { SubagentsConfig } from './config.ts';

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
