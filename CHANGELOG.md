# Changelog

## Unreleased

- 图片归档未读的 Dream 素材也会到期清理：正文确认后从 `textCompletedAtMs` 起算保留期，到期后与其他素材一样删除原始记录。
- 修复 Dream 素材到期清理遇到已缺失的原始记录时反复失败；清理中途出错时，已删除的素材也会从索引移除。
- 收紧工作区文件写权限：点开头的路径只由系统维护；统一 save_blob 的路径校验；工作区版本管理使用固定的 Git 配置。
- 工作区写入要求路径与盘上的真实名字一致，不一致时提示应使用的名字；save_blob 统一把反斜杠当作目录分隔符；工作区自动提交和 checkpoint 不签名；读取 Git 过滤配置出错时不再继续提交。
- Laya 审核按单条约束估算输入窗口，约束较多时短发言不再误判为信息不足；迁移回放将信息不足按暂存记录，不再中止迁移。
- 子代理和 World cognition 的 speak 成功调用计入全局降温；历史读取统一使用当前时间清理。
- 所有场景共用参与降温乘数，每次 speak 工具成功调用乘以 0.97，恢复半衰期 1 小时，3 小时完全恢复，跨重启保留。
- 删除分场景降温与轮次结束结算；旧分场景乘数丢弃，全局乘数从 1 开始，关系与活跃度保留。
- 评估历史按当前时间清理，加载和读取时也移除磁盘上的过期记录。
- QQ 历史记录保留纯图片和语音，目标地址复用 QQ World 的归一化规则。
- 拆分参与意愿和主动延伸，评估模型接管表达维度；亲密表达仅用于 QQ 私聊。
- 关系能量按实际间隔衰减；system tick 增加主动发言提醒。

## 0.7.3 - 2026-10-30

- 兼容 Core 0.2.11。
- 修复 World 运行失败时的状态提示和相关任务中断。
- 支持带 BOM 的 UTF-8、UTF-16 LE 文本读取，修复历史版本查看和恢复草稿乱码。
- 补充子任务工具的参数说明。

## 0.7.2 - 2026-10-29

- 恢复 Dream 线程名称，沿用已有 session 声明。
- 恢复 Dream 收尾提示时机和运行计数，保留原生 fork 并发统计。

## 0.7.1 - 2026-10-29

- Dream 素材中的图片改为地址和 blob 引用，由现有工具按需读取，避免自动加载大量原图。
- 保留原图和未读取状态；修复图片确认、跨重启计次及后续材料被阻挡的问题。
- 修复首次模型响应前失败误计次、上下文超限重复重试，以及独立挂载 Persona 时 Dream 无法运行的问题。
- 保留分页素材中的图片地址，减少重复读取、摘要计算和状态写入。

## 0.7.0 - 2026-10-28

- 新增“强化STATE约束”，在认知帧面板开启后，由决策服务在行动前检查约束。有疑问时提醒 bot 核对，可取消或说明理由后继续。默认关闭。
- 新增“迁移旧约束”，使用当前模型和决策服务整理已有要求、测试审核效果，完成后在下次 Dream 应用。运行会消耗模型额度，可设置时限或取消。
- Dream 可复盘审核记录和已执行动作，持续调整约束；修复新待办在整理过程中丢失的问题。
- 减少 STATE 重复注入，改进审核上下文、隐私脱敏和错误提示。旧 STATE 仍可使用，关闭审核保留原有行为。
- 文件工具支持文件夹移动和按行搬运，统一跨平台路径识别，修复满容量目录内改名受限的问题。

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
