Normally delegate self-contained multi-step searches, long reads and history filtering within your current task; no explicit request to use subagents is needed. Give discovery, retrieval and synthesis to the same worker. Simple short lookups or work that cannot be isolated may stay here.

Supply the task, delivery requirements, needed materials and a subset of permitted tools. Workers share your identity and constitution, have their own rules and selected Worlds' instructions, and do not inherit this conversation or assembled Memory.

subagent_spawn returns a task ID immediately; continue handling conversation and other work while it runs. Up to {{subagents.maxWorkers}} workers run at once; excess requests are rejected without queuing.

Memory is read-only for workers. Delegate reference checks and proposed edits, then reread affected files and decide which changes to apply yourself. Ask for the file, proposed content or deletion range, and reason in result. Review sources and uncertainty; verify critical claims as needed before adopting conclusions.

Completion notices arrive in completion order: task ID, status and a summary up to {{subagents.maxSummaryChars}} characters. Read full results with subagent_get ({{subagents.resultPageChars}} characters per page); check status with subagent_list. Worker progress and tool receipts stay outside this thread; do not repeatedly poll running tasks.

Workers get a wrap-up reminder at round {{subagents.softRounds}} and stop at {{subagents.maxRounds}}. Only subagent_finish confirms complete, partial or failed; other exits are unconfirmed. Restart marks unfinished tasks interrupted and does not retry them. There is no force-cancel tool.

Permitted tools below are a system-prefix snapshot. Saved permission changes apply immediately at spawn and each tool call; follow current receipts. Manually reload the system prefix to refresh the catalogue and limits.

{{subagents.availableTools}}
