# Changelog

## 0.7.0（未发布）

- 来源核对逐条校验覆盖引用，保留有效修正意见和覆盖记录；错误回执标出具体字段及无效引用，未修正前继续禁止候选收尾。

- 迁移子进程的模型调用在主进程启用流式传输，完整响应后才交回子进程，避免长核对结果误走整包响应超时；保留整体时限与取消。

- 认知帧新增“迁移旧约束”：两次费用确认后，在独立子进程中使用当前 LLM、决策服务及相关历史反复整理和回放候选；整理时限可选 5–30 分钟，默认 10 分钟，支持取消及收益不足时早停。
- 候选完成后保存到 Memory 并登记 Dream 待办，下次正常入梦应用；处理中到达的新待办不会被当前 Dream 的收尾覆盖，重启不重跑未完成生成。旧 STATE 不再由普通 Dream 自动一次性迁移。
- 同步基类文件／文件夹移动、按行剪切追加、整读限长和文件清单元数据；修复满 memo 层内改名被当作新增名额拒绝的问题，保留各角色权限。
- 审核读取元数据反映实际返回内容，完整区间和分段覆盖可用于 STATE 版本校验；候选可清空目标后原样按行搬入，避免模型重复输出整篇正文。

- 主线程文件写入审核补充当前上下文中已投递的聊天等事件正文，与工具回执共用证据预算，沿用脱敏并随上下文淘汰。
- Dream 迁移要求保留可审核硬约束及具体词项，合并相同范围的重复要求；不可见的事前自查留在正文，区分发言、记录与移动删除的适用对象，并按来源识别操作者渠道及句式讨论。
- 审核启用且文档有效时，服务故障、恢复及工具表待刷新均保持 main 的普通 STATE 正文，不再注入结构化约束全文。
- 暂存回执保留“疑似冲突／信息不足”类型及说明依据后继续执行的入口，省去重复的“尚未执行”和机制解释。
- 行动审核先判断当前规则是否适用，区分可见冲突、无关动作和必要信息不足，按实际读取长度判断规模，并只审新增修改，减少短读取、取消交易等误拦截。
- main 审核补充当前上下文中按预算保留的近期已完成工具回执，沿用脱敏和模型预算，明确标记省略；不把暂存或未执行动作当作证据。
- 精简 update_state 工具描述，将简短维护原则放入 Dream 开场指导，保留原义核对、scope、积极义务和时间戳等可检查要求。
- 暂存回执以自然语言说明未通过的约束及“疑似冲突／信息不足”结果，保留暂存 ID 和处理方法，并提示坚持执行时回应命中约束。
- 调整 STATE 迁移的 scope 指导：按当前部署与可见证据选择直接相关入口，保留操作者选定范围，避免为假设的文字出口扩大审核；来源冲突留在正文待确认。
- 新增 Dream 的 `state_review_tools`，按需查询当前部署的工具定义、标签及会话范围，迁移不再依赖预制工具表。
- 新增默认关闭的 STATE 行动审核，复用 Appraiser，在 main 和 Dream 的工具执行前检查适用约束。
- 审核通过后继续同一次回复中的工具序列；有疑问时暂存动作，允许取消或填写任意非空理由后坚持执行，后续副作用调用暂停且不自动重放。
- 新增 Dream 专用 `update_state`，使用版本比较原子维护 STATE 正文和约束；保留旧文件编辑入口、原权限及简短回执。
- 旧 STATE 在下一次正常 Dream 中整理，通知和任务跨重启保留；关闭审核保留原 STATE 提醒行为，开关不改写文件。
- 远程审核继续要求文本授权，对约束、工具参数、文件差异和局部对话脱敏，保留读取长度等机械数据；必要信息不足时暂存。
- 保留 World 草稿确认和屏障；`end_turn`、会话结束及重启清除未执行暂存。服务故障本轮回退，下一轮真实任务再试，不自动探测连接。
- WebUI 显示审核状态、禁用原因及待刷新工具状态；审核逻辑全部位于本扩展。
- 修复普通日期和时间戳被误判为审核信息不足的问题；较早对话可按预算裁剪，最新消息与明确引用的消息保持完整，同一会话及消息的不同标识格式使用一致别名。
- 将 Dream 材料读取纳入适用约束审核，并提供实际读取范围和长度；二进制读取报告字节数，目录等无效输入保留原工具的错误处理。
- `save_blob` 使用实际目标路径及二进制版本校验暂存，防止覆盖期间更新的附件；首次开启时立即登记并持久保存旧 STATE 整理任务。
- 将开关移到“认知帧”页顶部，改为“强化STATE约束”滑动开关并提示“需要决策服务”；标准远程 Jev 使用请求及单问题窗口预算，避免完整约束在本地固定 1000 预算下反复被暂存。
- STATE 读取不再附加版本尾注，扩展内部跟踪完整读取版本并校验后续更新，兼容显式 expectedRevision；暂存提示与处理工具说明移除理由不评分等实现细节。
- 约束必须明确填写适用 session 及工具名或标签；旧的无范围约束保留完整提示词并等待下一次正常 Dream 整理。迁移和日常维护同时检查 CONSTITUTION 及其他已有文档中的长期硬性行为约束，不再只整理 STATE 中已有条目。
- 修正远程 Jev 的 choice 选项为原生映射格式；运行日志记录逐条判断、概率、置信度，以及脱敏后的 HTTP 错误、超时和响应格式错误。
- main 在开场或普通正文变化时注入正文，不附加约束区，服务回退和恢复不切换为全文。关闭模式保留完整 STATE 和原提醒间隔；Dream 开场及显式读取仍提供全文，工具回执不夹带自动注入。
- Dream 按单个可审核动作拆分约束，区分违规发生的工具与前置步骤；无法在工具边界检查的要求和普通软偏好保留在 STATE 正文。
- 迁移与 Dream 维护逐条对照已读承诺，来源未明确允许的例外留空；按当前调用可见的证据选择审核对象与 scope，保留无法在该边界核验的原要求，并检查草稿确认及 STATE 更新等适用写入入口。
- 整理旧 STATE 时保留原句的选择关系、顺序、对象及范围，避免把“或”改成必须依次执行，或给一般记录要求增加目录限制；提交前对照不同发言约束的工具范围，检查遗漏的发布入口。
- 迁移提示逐项核对逗号、分号连接的独立义务，保留修订已有记录等积极要求，不能用“核实”概括后丢掉补正时间线；委派规则按待执行任务及会话能力选择范围，不一概视为无法审核的流程要求。

- 迁移入口和完成状态改为核对当前 STATE，修正恢复旧文档、清空文件及缺少 scope 时的状态与提示。
- 修复等价路径分段读取 STATE 的完整覆盖识别，以及反斜杠路径、越界或空源文件移动的审核预览。
- 迁移回放与生产取消草稿的免审规则保持一致，无适用约束的回放不再冒充决策验证。
- 迁移增加独立上下文的来源核对，按实际工具覆盖检查遗漏、原义、scope、维护流程混入及冗余；改稿后重新检查，起草时避免工具名与标签交集造成误解。

- 迁移来源核对逐项记录独立义务的原句及覆盖位置，拒绝无来源引用、未覆盖条目和无依据约束；不同适用条件或例外的义务不再建议混合压缩。
- 迁移回放与参考判断不一致时使旧核对失效，将原动作与结果交回独立核对；仍允许对忠实但无法改善的模型误判按收益递减结束。
- 开启强化 STATE 约束时，Dream 展示保留材料的暂存及 proceed/cancel 请求计数，可通过现有材料工具定位原动作、理由和结果；同时主动复核成功动作，从来源与证据判断收紧、放宽或保留约束，不以 proceed 自动判定误拦。


- 独立核对不再重复传入整批历史正文，起草回执只返回问题与覆盖统计；接近窗口上限时省略较旧的可重读查询回执，保留当前稿、意见、最新证据及完整原始遥测，减少迁移因上下文耗尽而中止。
- 来源核对区分硬性义务、软性偏好和普通事实，可观察的偏好不自动升级为审核约束。


- 关闭强化 STATE 约束时保持原材料目录与提示，不额外扫描审核线索；无审核线索的材料不附空统计。

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
