# Changelog

## 0.7.0（未发布）

- 新增默认关闭的“强化STATE约束”，在认知帧面板使用滑动开关，显示决策服务要求、可用状态及禁用原因。复用现有 Appraiser 配置与远程文本授权，开启和重启不自动测试连接。
- STATE.md 保持唯一权威文件，支持普通正文和带明确 session、工具名或标签的 Action constraints。新增 Dream 专用 update_state，校验格式及版本后原子写回；保留原有文件编辑入口和角色权限。关闭审核保持原 STATE 提醒行为，切换开关不改写文件。
- 在 main 和 Dream 的适用工具执行前审核；通过后继续执行，有疑问时暂存并用自然语言指出约束及“疑似冲突／信息不足”。bot 可取消或填写非空理由坚持执行；后续副作用调用暂停且不自动重放。原 World 权限和草稿确认仍生效，目标或 STATE 变化使旧暂存失效，turn 结束及重启清除暂存。
- 审核使用实际草稿、文件变化、读取范围及长度、有限近期对话和已投递事件；远程请求统一脱敏并检查输入预算。按实际动作判断适用性，只审新增修改，避免把已删除的旧错误或缺少核实回执直接认作违规。日志记录逐条判断、概率、置信度及脱敏后的服务错误。
- 审核可用且 STATE 格式有效时，main 仅在开场或普通正文变化时注入正文，工具回执不重复附加全文；服务故障和恢复不注入约束区。故障时当前调用按原行为执行、本轮停止审核，下轮真实任务再尝试；首次故障提示 bot 可通知维护者。
- 新增“迁移旧约束”入口。两次费用确认后，用当前 LLM、决策服务、实际工具定义及只读历史在隔离子进程整理旧 STATE、CONSTITUTION 等已有要求；时限可选 5–30 分钟，默认 10 分钟，支持取消，不额外触发 Dream。
- 迁移从旧 STATE 原文起草，来源审阅同时生成正反例及例外场景，再隔离回放并针对问题修稿。同主题、同范围且条件兼容的要求可合并，保留独立义务和各条款例外；没有固定条数上限或强制整理回合。局部复核保留修改差异和回放证据，响应格式及引用错误在同一次审阅内修正，保留其他有效意见与案例；到期或服务失败不应用中途稿。
- 完成的迁移候选保存到 Memory 并登记持久 Dream 待办，下次正常入梦对照当前 STATE 处理差异后原样搬入。支持取消待应用候选；重启不重跑未完成生成。普通 Dream 不再自动一次性迁移旧约束。
- Dream 可用 state_review_tools 查询实际工具及会话范围，并通过现有材料工具复盘暂存、proceed／cancel 及成功动作。根据来源和证据调整约束，不把 proceed 自动当作误拦；关闭审核时不额外扫描审核线索。新到达的待办不会被当前 Dream 收尾覆盖，pendingTasks 明确仅记录未完成的 Memory 整理工作。
- 更新基类文件工具，支持文件／文件夹移动和按行剪切追加，保留权限及目标检查；满 memo 层内改名不占新名额。读取提供实际行数、字符数及文件清单元数据，修复等价路径、分段完整读取、移动预览与附件目标版本校验。
- 认知帧不再向行动模型注入原始数值评分，保留语义连续状态和分档行为指导。

## 0.6.0 - 2026-10-22

- Add `list_wakes` and `cancel_wake` for scheduled wakes and their delivery blocks.
- Support `schedule_wake(at, note, repeat=true)` at the same local time each day, with a persistent wake ID and timezone. Relative wakes remain one-shot.
- Process Dream materials oldest first in input-sized batches and continue after confirmed progress, up to `dream.maxBatches` (default 3).
- Return actionable `surface` validation errors and preserve pending future tasks when all materials in the current batch have been processed.
- Fix worker deadline tests and Dream test receipts containing context-budget reminders.

`surface(processedMaterials="all")` now confirms the active batch and is valid with `status="partial"`. Set `dream.maxBatches=1` to retain one batch per handoff or manual continuation. Existing materials and run records remain readable.

## 0.5.1 - 2026-10-17

- Retain the question, speech calls and actual receipts from the batch crossing the soft context threshold in the recent handoff note.
- Keep startup available when Dream run history, saved context or pending-task notes are damaged or unreadable.
- Preserve malformed state files beside the original path and report recovery in the log; retain unconfirmed materials.

## 0.5.0 - 2026-10-16

- Target Cortico 0.2.1 and bot contract 7.
- Rename browser contributions, imports and bundles to WebUI.
- Add extension self-description, official index tags and publishing guidance.

The built-in chat World is `console`. Migrate deployment `worlds.terminal` to `worlds.console`, move `worlds/terminal/ENV_PROMPT.md` to `worlds/console/ENV_PROMPT.md`, and rename `logging.console` to `logging.stdout` when present. Update the prompt variable `terminal.pin` to `console.pin` and subagent permission keys `terminal` / `terminal_send` to `console` / `console_send`. Existing `terminal.*` event records remain stored but do not appear on the Console page.

## 0.4.2

- Last release using the previous Cortico extension contract.
