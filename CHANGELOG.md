# Changelog

## 0.8.3 - 2026-11-10

- QQ 发言审核按目标群聊或私聊读取最近对话；确认发送成功的发言记入对应会话。支持内建 QQ、cortico-world-qq-promax-kpect、cortico-world-qq-final 和 cortico-world-astrbot。
- 扩展中文显示名为「接续 Continuity」，英文为「Continuity」。README 改为用户指南，涵盖安装、决策模型配置、Dream 和子代理设置。
- WebUI 的上下文预算和子代理配置说明现在指向「模型供应商」页。

## 0.8.2 - 2026-11-08

- 交接记录的归档路径跨重启保留。Dream 仅在材料有确切来源时提示上一份交接笔记。
- Dream 使用专用身份和宪法前缀，按需读取交接笔记与 Memory。交接材料省略历史推理，已有待整理材料继续使用原 ID。旧配置中的 `dream.maxBackgroundTokens` 可保留，已不参与预算。

## 0.8.1 - 2026-11-06

- `read_file` 可直接读取 `log:` 附件。梦通过 `surface.skipImages` 明确跳过无需整理的图片，归档仍标记为未读；读取失败的必要图片继续待处理。移除按入梦次数自动归档的规则，已有归档及到期清理保持不变。
- 已有未完成材料等待梦读取或明确跳过图片；旧 `deferredImages` 计次不再触发归档，材料确认时移除。

## 0.8.0 - 2026-11-05

### 升级须知

- 需要 Core 0.2.13 或更新版本。
- 已有部署建议检查工作区的 `.git/config` 和 `.git/hooks`，确认其中没有不是自己写入的内容。
- 工作区里点开头的路径只由系统维护，不再可写；写入路径要与盘上的真实名字一致，不一致时提示应使用的名字。
- 自定义了 `PREFIX.md` 的部署需删去 `{{persona.subagents}}` 前的段标题；自定义了 `SUBAGENTS.md` 的部署需在开头加上 `━━━ Subagents ━━━`。关闭子代理时不再留下空标题。
- 自定义了 `CORE.md` 的部署需手动合并本版更新：`mem:` 句柄的写法、写权限矩阵的 `state/` 一行，以及起草确认工具 `qq_confirm`。
- 到期清理范围扩大：子代理任务结束 30 天后删除其记录、结果和提醒文件；图片归档未读的 Dream 素材从正文确认起算，到 `dream.materialRetentionDays` 后删除。

### 新增与行为变化

- 新增参与降温，默认开启：所有场景共用一个乘数，每次 speak 工具成功调用（含子代理和 World cognition）乘以“参与度衰减”系数，恢复半衰期 1 小时，3 小时完全恢复，跨重启保留；只影响参与意愿。认知帧面板可用滑条调整系数（0.8–1，默认 0.95，越高越活泼，1 关闭降温）。
- 认知评估拆分参与意愿和主动延伸，表达维度改由评估模型给出，每次评估的问题从 3 个增加到 7–8 个；评估不可用时这些维度显示为不可用；亲密表达仅用于 QQ 私聊。认知帧改为由 bot 自行决定是否参与，`debugLog` 记录来源、模型变体和 8 项评分。
- 关系能量按实际间隔衰减；system tick 增加主动发言提醒。
- 评估发给远程决策服务的消息文本中，认证信息替换为 `[secret]`；远程审核把 `sceneKey` 替换为别名，并识别更多认证信息格式，`Cookie:` 请求头和带引号的值整段替换。
- 回滚到存档点前先提交工作区当前改动，回滚前的内容可从 Git reflog 找回；提交失败时不回滚，也不清除存储。新建存档点时提交失败会报错。
- 不区分大小写的文件系统上，可以只改文件名的大小写（如 `a.md` 改为 `A.md`）。
- 工作区 Git 调用不启用 fsmonitor，不留常驻进程。
- QQ 历史记录保留纯图片和语音；评估历史按当前时间清理，加载和读取时也移除过期记录。
- “强化STATE约束”开关移到标题左侧；迁移旧约束只确认一次；控制台部分卡片去掉英文副标题和与界面重复的说明文字。

### 修复

- Dream：停止时中止正在进行的模型请求；第一轮之后超出模型上下文时按重试设置重试；素材、轨迹清理或运行记录保存失败只记录警告，不再中断本轮后续批次；到期清理不再反复停在无法删除或已缺失的素材上；梦面板保存配置后仍显示进行中的状态和整理记录。
- STATE 迁移：来源检查只内联 STATE 与 CONSTITUTION，其他来源由检查模型按需读取，工作区较大时不再超出模型上下文；检查结果无效时重试，不再直接终止；单个损坏的 Dream 素材只跳过并记录警告；失败原因如实显示；修复子进程发送较大结果后结果可能丢失；决策回放目录随迁移工作区清理。
- Laya：模型加载失败后 30 秒内直接返回同一错误；worker 退出或超时后重新启动，不再永久等待；Windows 上不再弹出控制台窗口；安装脚本依次使用 `CORTICO_CONDA_COMMAND`、`CONDA_EXE` 和 `conda`，可以找到 `conda.bat`；列出 Conda 环境的读取错误如实显示；审核按单条约束估算输入窗口，约束较多时短发言不再误判为信息不足，迁移回放不再因此中止。
- 远程审核与评估：不足 3 个字符的昵称不再破坏中文正文；文件工具的 `from` 和 `to` 一律按路径处理；链接参数（如 `access_token`）和值不是文本的认证字段不再使审核判为信息不足；处理很长的连续标识符或当前消息时不再阻塞事件循环；行动审核暂时不可用时不再拒绝保存其他配置；连接测试直接拒绝非 http(s) 的自定义决策服务地址。
- 文件工具：Windows 上文件被短暂占用时重试约 3 秒；glob 花括号里可以含 `*` 或 `?`；列出和遍历时跳过临时文件和符号链接；read_file 如实报告未找到以外的读取错误；read_file 和按行 move_file 的 limit 小于 1 时报错；move_file 的目标以反斜杠结尾时当作文件夹，save_blob 同样把反斜杠当作目录分隔符；grep_files 合并相邻命中的上下文。
- 交接与节奏：交接笔记不再算作新的外部事件，预算不超过 hardTokens 乘以保留比例，识别其读取时路径忽略大小写；清空 session 后越过软阈值时不再跳过提醒；心跳空拍回退中收到外部事件时，下一拍按基线间隔；深夜 tick 间隔为 0 时表示不 tick；默认配置的 loop、memo 和 tick 不再在多份配置间共用；前缀模板中 World 段之后的文字不再错位或丢失；首轮对话源文件和自动提交的异常交给 Core 记录。
- 控制台：配置页轮询失败时显示原因，晚到的轮询结果不再覆盖刚保存的配置；错误提示不再带 `WebUiInvokeError:` 前缀；子代理面板失败提示只保留一行；工作区面板区分“无改动”和“提交失败”，新建文件前先确认未保存的修改，版本历史的 diff 和全文分别加载，目录树顶层也记住展开状态；存档点操作结果在刷新后仍然显示；记忆页和前缀装配不再吞掉真实读取错误。
- 梦写入 `state/` 下 STATE.md 以外的文件时，拒绝理由不再固定提到 runtime.json。

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
