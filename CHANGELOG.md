# Changelog

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
