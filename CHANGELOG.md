# Changelog

## Unreleased

- STATE 迁移的来源检查返回无法解析或格式无效的结果时，按原检查方式重新请求，最多重试 2 次，不再直接终止迁移；来源检查的引用错误修正最多 3 轮，仍无效时报错结束。
- STATE 迁移的来源检查每次回答最多使用 30 轮模型请求，达到上限时报“来源检查达到轮数上限”，不再持续读取文件直到总时限并显示为整理超时；来源检查读取文件时也更新剩余时间提醒。格式无效时在同一段对话中附上无效回答重新请求，不再从头读取文件。
- STATE 迁移整理超出模型上下文或达到轮数上限时，失败原因如实显示，不再显示为“迁移已停止”。
- 修复 STATE 迁移子进程在发送较大结果后立即断开，结果可能丢失。
- STATE 迁移读取历史时跳过损坏的 Dream 原始素材文件并记录警告，不再因单个文件导致迁移失败。
- STATE 迁移的决策回放临时目录改建在迁移工作区内，随工作区一并清理，进程被结束时不再在系统临时目录残留用户内容。
- 多语言 Laya 模型加载失败后 30 秒内的请求直接返回同一错误，不再每次请求都重新加载。
- 多语言 Laya 的 Python worker 在 Windows 上不再弹出控制台窗口。
- 列出 Conda 环境时，只有环境清单不存在才视为没有环境；其他读取错误照常报出，认知帧设置页照常加载，错误显示在 Python 环境选项下方。
- 多语言 Laya 安装脚本优先使用 `CONDA_EXE`；未设置时在 Windows 上经 shell 调用 `conda`，可以找到 `conda.bat`。经 shell 调用时每个参数都加双引号，环境名中的 `&` 等字符不再被 cmd 解释；参数含 `"` 或 `%` 时报错并提示设置 `CONDA_EXE`。
- 修复文件工具的 glob 花括号里含 `*` 或 `?` 时搜索报错；花括号里的每个备选项按同样的通配规则匹配。
- 不区分大小写的文件系统上，可以只改文件名的大小写（如 `a.md` 改为 `A.md`），按移动同一份文件处理；其他与盘上真实名字不一致的路径仍然拒绝。这类改名同时更新工作区 Git 索引，在默认忽略大小写的仓库里也会被提交，不再显示“无改动，未提交”。
- 列出和遍历工作区文件时跳过原子写的临时文件和符号链接，与工作区面板的树一致。
- read_file 只在文件不存在时报告未找到，其他读取错误照实报告；`blobs/` 判断改为按规范化后的路径。
- read_file 和按行 move_file 的 limit 小于 1 时报错，不再当作 1 行处理。
- move_file 的目标以反斜杠结尾时当作文件夹。
- grep_files 相邻命中的上下文合并，不再重复输出同一行。达到 head_limit 时，最后一处交回的命中保留完整后文，未交回的命中作为上下文行显示。
- 前缀模板中 World 段之后的文字保留在最后一个 World 段末尾，不再错位或丢失。
- 交接笔记不再算作新的外部事件，不再提示“N 条新事件”。
- 首轮对话源文件只在不存在时当作空，其他读取错误由 Core 记录警告。
- 交接笔记预算不超过模型上下文上限 hardTokens 乘以保留比例。
- 心跳处于空拍回退时收到外部事件，下一拍改为按基线间隔，不再等完回退后的长间隔。
- 修复默认配置的 loop、memo 和 tick 在多份配置间共用，修改一份会影响其他配置。
- 配置页轮询读取失败时，状态行显示“读取失败”和原因，不再一直显示“已保存”；保存前发出、保存后才返回的轮询结果被丢弃，不再覆盖刚保存的配置。上一次轮询尚未返回时跳过本次轮询，服务器响应超过轮询间隔时不再丢弃全部结果。
- 控制台各面板的错误提示只显示错误信息，不再带 `WebUiInvokeError:` 前缀。
- 子代理任务列表读取和取消任务失败时只保留一行状态提示，不再每次轮询追加一行。
- 工作区版本历史中，diff 和全文分别加载，其中一项失败不再让整条记录显示“diff 失败”。
- 工作区目录树的顶层目录也记住展开状态；首次打开时顶层目录仍默认展开。
- 回滚确认框不再列举具体存储种类，改为说明按清单清除全部存储。
- 控制台记忆页和前缀装配读取工作区根目录、WORLDVIEW.md 和手册目录时，先检查是否存在；真实读取错误不再被吞掉。
- 关闭子代理时，系统前缀不再保留空的 Subagents 段标题；段标题移入 `SUBAGENTS.md`，自定义了 `PREFIX.md` 的部署需删去 `{{persona.subagents}}` 前的段标题；自定义了 `SUBAGENTS.md` 的部署需在其开头加上 `━━━ Subagents ━━━` 段标题。
- CORE.md 写权限矩阵补上 `state/` 一行，起草确认工具更正为 `qq_confirm`。
- 梦写入 `state/` 下 STATE.md 以外的文件时，拒绝理由不再固定提到 runtime.json。
- 识别交接笔记读取时，路径先规范化并忽略大小写。
- `debugLog` 的说明更正为记录来源、模型变体和 8 项评分。
- 即时评估处理很长的当前消息时，先按固定上限截短再裁剪，不再阻塞数秒；请求内容不变。
- 评估历史的 `recent()` 返回副本，调用方修改结果不再影响内部记录。
- 停止 Dream 时中止正在进行的模型请求，不再等待请求结束；本次整理记为中断，未确认的素材保留。
- Dream 在第一轮之后超出模型上下文时记为中断并按重试设置重试；只有第一轮超出时才按初始输入超出预算处理、不重试。
- 梦面板保存配置后仍显示整理进行中的状态和整理记录，整理进行中时“强制交接并入梦”保持禁用。
- 子代理任务结束 30 天后，加载时删除其记录、结果和提醒文件；运行中的任务不删除。
- 梦素材到期清理遇到无法删除的原文文件（如 Windows 上被占用的文件）时记录警告并保留该条，其余到期素材照常清理，此后的清理不再每次停在同一条。梦结束时的素材和轨迹清理失败只记录警告，不再报“梦队列失败”并中断本轮后续批次。
- 远程审核在正文中替换身份别名时，不足 3 个字符的身份只在前后不紧邻文字或数字时替换，昵称（如“好”）不再破坏中文正文；文件工具的 `from` 和 `to` 一律按路径处理，不带斜杠的目标路径不再被当作身份替换。
- 存档点面板的回滚、新建和删除结果以及统一重置的结果，在面板刷新后仍然显示；部分失败保持标红，回滚部分失败时也打开逐项结果。
- 工作区面板保存、删除和改名的回执区分“无改动，未提交”和“Git 提交失败”，失败时附带原因；版本状态行显示建仓失败和最近一次提交失败的原因。
- 回滚到存档点前先提交工作区当前改动，回滚前的内容可从 Git reflog 找回；提交失败时不回滚，也不清除存储。
- 新建存档点时，提交当前改动失败会报错，不再把存档点打在上一次提交上。
- 已开启的 STATE 行动审核暂时不可用时，保存其他配置项不再被拒绝；只在开启审核或修改评估设置时检查可用性。认知帧设置页整页保存时，值未变的评估设置不算修改。
- 远程审核将 `sceneKey` 作为身份字段替换为别名，非数字的会话标识（如 `slack:channel:<名称>`）不再原样发送。
- 远程审核先把链接替换为别名，再检查认证信息；链接参数（如分享链接中的 `xsec_token`）不再使审核判为信息不足，链接以外的认证信息仍会识别。
- 认知评估发送给远程决策服务的消息文本中，认证信息替换为 `[secret]`，评估照常进行。
- 远程审核和认知评估替换认证信息时，`Cookie:` 与 `Set-Cookie:` 请求头的值整行替换，带引号的值（含转义引号）整段替换，不再只替换第一个 Cookie 或引号内的第一个词。
- 远程审核中，名称像认证字段但值不含文本的键（如 `includeCredentials: false`、`isSecret: true`）不再被当作认证信息，不再使审核判为信息不足。
- 修复远程审核和认知评估处理很长的连续标识符文本时，邮箱匹配耗时随长度平方增长并阻塞事件循环。
- 远程审核识别更多认证信息格式：带前缀的名称（如环境变量和 `x-` 请求头）、以 secret、token、password、api key 等结尾的字段名，以及常见密钥前缀和私钥块。
- STATE 迁移的来源检查只内联 STATE 与 CONSTITUTION，其他来源列出路径和大小，由检查模型用只读文件工具按需读取；工作区较大时不再超出模型上下文。STATE 与 CONSTITUTION 本身超出上下文时，在开始整理前报错。
- 空闲时自动提交工作区遇到 Git 失败以外的异常时，交给 Core 记录警告，不再静默忽略。
- 修复工作区面板新建文件后直接打开新文件，丢弃当前文件未保存的修改；现在会先确认。
- 修复清空 session 后越过软阈值时跳过“交接快来了”提醒直接交接，交接笔记沿用清空前的分界。
- 修复深夜 tick 间隔设为 0 时整夜连续触发 tick，0 与留空一样表示深夜不 tick。
- 修复评估历史文件结构损坏时 bot 无法启动，改为从空历史开始。
- 修复多语言 Laya worker 退出后后续评估永久等待：退出或出错的 worker 不再复用，下次请求重新启动；启动限时 15 分钟、单次评估限时 60 秒，超时结束 worker；持续读取 worker 错误输出，避免写满后卡死，失败时附带最后 4 KB。
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
