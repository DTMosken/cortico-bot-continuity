<!-- Owner: index.ts, base/persona/persona.ts, persona/appraisal.ts, persona/config.ts, persona/character-state.ts, persona/laya-python.ts, persona/index.ts, persona/tools.ts, console/config.ts, console/cognition.ts, console/cognition-preview.ts, console/subagents.ts, persona/subagents/index.ts, persona/subagents/config.ts, persona/subagents/store.ts, persona/subagents/runtime.ts, persona/subagents/prompts.ts, persona/SUBAGENTS.md, persona/SUBAGENT_WORKER.md, persona/cognition.ts, persona/subconscious/index.ts, persona/subconscious/prompts.ts, persona/subconscious/materials.ts, python/laya_multilingual_worker.py -->

# cortico-bot-continuity

`cortico-bot-continuity` 是一个面向 Cortico 的 Bot 扩展。它在 Persona 的 Memory 中保存跨会话状态，并按场景和触发名单生成认知帧，帮助回复延续近期互动状态。

## 功能

- 继承分层记忆、梦、作息、QQ 草稿确认与控制台能力。
- 私聊按人物、群聊按群场景维护机械状态；非 QQ World 有可识别场景时也独立维护，未知场景仍生成认知帧。
- 机械状态随所在人物或场景的消息增加并衰减；旧版状态自动归档后迁移可识别条目。
- 认知帧保留主动性、话题延续、温度、玩笑、自我披露和克制六个维度，并在帧尾给出分类和输出风格建议。
- **梦**把适用于所有人的持续约束写入 `state/STATE.md`；个人信息保存在 `people/`。
- 主 agent 可把独立任务交给后台子代理，继续处理对话；子代理按完成顺序返回摘要，完整结果按需读取。

状态只由事件时间、数量、来源和发送者标识更新，不会从消息文本推断信任、冒犯或情绪。

## 安装

要求 Node.js 22 或更新版本，以及 Cortico 0.1.7 或更新版本（Bot 扩展 API 6）。

在 Cortico 仓库的 `extensions/` 目录安装：

```powershell
Set-Location "<Cortico 仓库路径>\extensions"
corepack pnpm add --ignore-workspace cortico-bot-continuity
```

在部署目录的 `deployment.json` 中设置：

```json
{
  "bot": "cortico-bot-continuity"
}
```

之后按常规方式重启 Cortico 进程。Bot 声明 QQ、Terminal 和 WebSearch World；各 World 是否启用、
凭据及部署参数仍由部署配置决定。

## World 兼容性

本包配合 Cortico，在主 session 中提供 [World 兼容等级](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/world-compatibility.md)的 **L1–L4** 宿主能力。

| 等级 | 提供的能力 |
| --- | --- |
| L1 | 工具调用、附件回执、环境提示与 World 生命周期。 |
| L2 | 事件存储与唤醒、工具屏障与结束本轮、调用取消、轮次结束通知、模型能力与用量接口。 |
| L3 | 合批、抢占与主动打断、延迟及候选事件、临时事件、事件库读取与队列消费、排队事件撤回与提级、事件投递与丢弃通知、上下文交接通知。 |
| L4 | 主 session 输出流 `outputTap`、运行阶段通知 `onRunPhase`、模型失败统计 `llmStalls`、World 后台认知 `cognition.request`。 |

后台认知须启用 `subagents.enabled`。关闭后，`WorldHost.cognition` 不可用；在“World扩展子代理权限”中禁用请求方 World 或其请求的工具时，认知请求返回错误。World 的降级行为由其自身契约定义。控制台面板与配置组不计入等级。

## 子代理与 World 后台认知

主线通过 `subagent_spawn/list/get` 管理任务；World 通过 `cognition.request` 请求后台计算。两者共用执行器、并行名额和任务记录。

“子代理”页有两套权限：

- **主线子代理权限**：主 agent 从已允许且当前可见的工具中选择本次任务的工具。首次建立目录时，只读工具默认开启；后续发现的新工具默认关闭。原有选择保留。
- **World扩展子代理权限**：World 只能请求自己的工具。缺省允许整组及其工具，显式关闭后拒绝相关请求。旧的主线权限不会复制到这里。隐藏 World 不影响其后台请求；关闭整组会停止该 World 的在途任务。

World 工具可按需授权读、写、动作和发送。每次调用重新检查权限；关闭单个工具后，下一次调用收到拒绝回执。Persona 的 Memory 工具始终只读：主线任务须显式选择，World 任务自动获得“主线子代理权限”中已开启的 Memory 只读工具。此限制由 Persona 文件工具执行；World 自己提供的终端等工具仍按各自契约操作外部环境。

默认同时运行 **4** 项任务，满额拒绝，不排队。默认第 **16** 轮起报告已用和剩余轮数，工具仍然可用；第 **64** 轮结束。World 的 `hint.rounds` 仅是建议。任务默认时限 **15 分钟**；配置 `timeoutMs` 最多 900000，以匹配当前 Minecraft 引擎的 16 分钟 RPC 等待期限。Dream 使用自己的额度。

接受任务时固定模型、provider、轮数、时限和上下文预算。预算取 Persona 阶段额度与已知模型输入上限的较小值；每轮估算提示词、历史、材料和工具定义的占用。达到 **80%** 提醒一次；达到 **100%** 不再请求模型。工具结果可能直接使上下文超限，此时保留已有文本，不额外请求收尾。不会自动压缩、交接或续跑；需要继续时，由主线或 World 决定是否另起任务。

主线工具：

- `subagent_spawn`：`mode="start"`（缺省）接受 `task`、文本数组 `materials`、工具名数组 `tools` 和可选 `context`，立即返回任务 ID。`tools` 可为空。`context="isolated"`（缺省）只含身份、宪法、worker 规则、材料和相关 World 环境说明；`context="main"` 复制接受时的主线上下文，裁掉尚未配平的工具调用尾部。World 请求固定使用主线快照。后续主线消息不会追加到任务中，权限不会随上下文继承。
- `subagent_spawn(mode="cancel", taskId="...")`：只接受这两个参数；重复取消返回当前状态。停止信号传给 provider 与在途工具，禁止后续调用。底层工作尚未退出时显示“停止中”，继续占用名额；World 的请求立即收到停止原因。已执行的外部动作不会回滚。
- `subagent_list`：支持 `status`、`source`（`main/world`）、`worldId`、`offset`、`limit`，返回实际模型轮数、最大单次上游输入 token、结束原因和提醒索引。上游未计量时显示“未知”。
- `subagent_get`：按 `taskId`、`offsetChars`、`maxChars` 读取结果；指定从 1 开始的 `reminderIndex` 时读取该提醒的证据。运行中也能查询。默认每页 2000 字符，`maxChars` 不超过配置页长。

worker 可调用 `subagent_notify(summary, details)` 保存证据并提醒主线，摘要默认最多 1000 字符。证据成功落盘后才注入主线事件，任务继续执行。主线空闲时被唤醒，忙碌时按正常内部事件投递。提醒不写 Memory，也不会在任务结束或重启时重发。

例如，PWSR 状态对账可以先读 Memory，再用 World 工具恢复目标或路标，并检查回执。空表不阻塞其他操作。需要保存语义变更时，通过提醒或结果把证据交给主 agent；主 agent 重新读取当前 Memory 后决定如何写入。机械位置与进度不要求周期同步。Minecraft 蓝图通过自己的 `mc_blueprint` 工具保存整份数据，Memory 只需由主 agent 按需记下键和描述。

非空自然文本结束为 `complete`。也可用 `subagent_finish(status, summary, result)` 指定 `complete/partial/failed`；前两者要求非空结果，失败要求摘要中说明原因。无效参数可在后续轮次改正。轮数或上下文用尽时，有文本为 `partial`，无文本为 `failed`；取消为 `cancelled`，超时为 `timed_out`，停机或请求方 World 卸载/重启为 `interrupted`。卸载/重启的中断从装配层生命周期通知时生效。World 收到完整文本、带原因的部分文本或错误，并自行判断外部任务是否完成。

任务 JSON、结果 TXT 和提醒证据保存在部署 dataDir 的 `continuity/subagents/`，保留期限不限，不自动删除或归档；可跨主线上下文交接查询。重启把 `running/stopping` 改为 `interrupted`，不重跑。临时 session 实际退出后关闭，Core 仅保留最近 8 个已关闭临时 session；任务结果仍在磁盘上。

保存配置立即更新权限；新任务使用新额度，已启动任务保持启动额度。旧配置中显式写入的轮数保留，未配置的值使用新默认值。主线说明保持快照，需手动“重载系统前缀”更新。

“系统提示词”页可编辑 `SUBAGENTS.md`（主线规范）和 `SUBAGENT_WORKER.md`（worker 规范）。部署中的同名覆盖文件优先；若已有覆盖，请更新其中的旧轮数、强制 finish、发送限制等规则。已有 PREFIX.md 覆盖需包含 `{{persona.subagents}}`。新任务读取当前模板，主线修改后手动重载系统前缀。

## 即时评估

即时评估只影响本轮回复的主动性、话题延续和玩笑度。评分本身不写入个人档案；插件会在 `state/appraisal-history.json` 中保存各会话最近 20 条、24 小时内收到的消息，以及 QQ 工具报告发送成功的回复。群聊整批只评估一次；输入明确区分当前消息与历史，并按本地估算将完整评分请求限制在 1000 token 内。启用 `debugLog` 才记录有限评分。
远程决策模型获得脱敏后的当前及近期历史文本；未开启 `appraisal.jev.allowRemoteText` 时不会调用远端。
`appraisal.provider` 是互斥选择，默认 `random`：

将此配置写入部署目录的 `config.json`，不要写入只引用扩展的 `deployment.json`。在控制台中，打开 Persona 的“认知帧”页并启用“记录即时评估输出”即可将 `appraisal.debugLog` 设为 `true`。

只需查看运行结果时，`config.json` 中的最小改动为：

```json
{
  "appraisal": { "debugLog": true }
}
```

```json
{
  "appraisal": {
    "provider": "random",
    "debugLog": false,
    "laya": {
      "idleTtlMinutes": 5,
      "variant": "english",
      "pythonExecutable": ""
    },
    "jev": {
      "allowRemoteText": false,
      "endpoint": "https://api.typesafe.ai/v1/systemone",
      "timeoutMs": 1000
    }
  }
}
```

`debugLog: true` 只记录来源、模型变体和三个评分，不记录消息原文或发送者标识。

### random

默认选项。它从当前消息生成可复现的本地实验值，不加载模型，也不发送网络请求。适合零额外依赖、调试基线和默认生产配置。

### 英文 Laya

设置 `provider: "laya"` 且 `laya.variant: "english"`。它使用可选依赖 `@receptron/laya` 的本地 ONNX 运行时；首次使用会下载英文检查点，之后从本机缓存加载。保留它即可在多语言模型之外继续比较英文 ONNX 行为。

```json
{
  "appraisal": {
    "provider": "laya",
    "laya": { "idleTtlMinutes": 5, "variant": "english", "pythonExecutable": "" }
  }
}
```

### 官方多语言 Laya

设置 `provider: "laya"` 且 `laya.variant: "multilingual"`。控制台从 `%USERPROFILE%\.conda\environments.txt` 发现环境，选择后保存该环境的 `python.exe` 路径；worker 直接启动该 Python，不依赖 bot 进程的 `conda` 或 PATH。worker 使用官方 `laya` 包加载 `convaiinnovations/laya` 的 `multilingual` 检查点。评估请求仅经本机子进程的标准输入输出传递，不监听端口。

在扩展目录执行一次安装和模型验证：

```powershell
corepack pnpm laya:multilingual:setup <你的 Conda 环境名>
```

该命令会向指定环境安装 `laya`，首次运行下载官方模型，并以固定中文输入验证 `noul` 输出。成功时输出一行 `{"type":"verified",...}`。若 `conda` 未在 PATH 中，使用一行 PowerShell 命令指定 Conda 可执行文件：

```powershell
$env:CORTICO_CONDA_COMMAND = '<Conda 安装目录>\Scripts\conda.exe'; corepack pnpm laya:multilingual:setup <你的 Conda 环境名>
```

安装完成后，控制台 Persona 的“认知帧”页中的“多语言 Laya Python 环境”会列出可用环境。选择 `tf-gpu` 后，运行时配置保存它的 `python.exe` 路径；不需要填写 Conda 命令或环境名。

```json
{
  "appraisal": {
    "provider": "laya",
    "debugLog": true,
    "laya": {
      "idleTtlMinutes": 5,
      "variant": "multilingual",
      "pythonExecutable": "<你的 Conda 环境目录>\\python.exe"
    }
  }
}
```

`idleTtlMinutes` 控制两种 Laya 的内存释放时间。与 simple-trpg-check 同进程运行且使用相同模型时，两者共用模型或 worker；multilingual 还需选择同一 Python 解释器。请求依次执行，最后一次请求后按使用者中最长的 TTL 释放。多语言 worker 的首次加载可能需要下载模型，先运行安装命令可以避免在投递时下载。

### 远程决策模型

在 Persona 的“认知帧”页选择“远程决策模型”，启用“允许远程模型处理文本”，再选择“决策服务”和“决策模型”。模型输入框提供预设，也接受模型 ID；留空使用所选服务的默认 JEV 模型。OpenRouter 的 Luna Decisions 预设为 `openai/gpt-6-luna-decisions`。

“打开密钥文件”打开部署 `.env`，TypeSafe、OpenRouter、自定义服务分别读取 `CORTICO_JEV_TYPESAFE_API_KEY`、`CORTICO_JEV_OPENROUTER_API_KEY`、`CORTICO_JEV_API_KEY`。同一服务的模型共用密钥；旧部署中的 `CORTICO_JEV_API_KEY` 仍可用于 TypeSafe。配置键 `provider: "jev"` 和 `appraisal.jev` 继续用于远程决策模型。

自定义服务须支持 SystemOne 请求和答案格式。请求按配置超时且不重试，失败时将语义评分标为不可用。“测试连接”使用已保存配置和固定测试文本，只有所选模型返回有效评估才报告成功。

```json
{
  "appraisal": {
    "provider": "jev",
    "jev": {
      "allowRemoteText": true,
      "source": "typesafe",
      "model": "",
      "endpoint": "https://api.typesafe.ai/v1/systemone",
      "timeoutMs": 1000
    }
  }
}
```

### 回收英文 Laya 模型

多语言 Python 模型不依赖英文 ONNX 权重。选择 `multilingual` 或 `random` 并停止进程后，可以删除 `%USERPROFILE%\.cache\receptron-laya` 以回收英文模型磁盘空间；它只会在再次选择 `english` 时重新下载。不要移除 `@receptron/laya` 这个可选依赖，否则英文 Laya 选项无法使用。

## Memory 与状态迁移

Persona 的运行状态保存在部署的 `memory/state/` 中：

- `runtime.json` 保存版本化的全局精力、按发送者区分的互动热度、事件 cursor 和可复现 seed，采用原子写入。
- `STATE.md` 是 Dream 维护的全局语义状态；主 Persona 按独立的注入频率读取。
- 从 v1 首次启动时，旧运行状态和语义状态会分别归档为 `runtime.v1.json` 与 `STATE.v1.md`；新 `STATE.md` 从全局约束模板开始。个人或关系信息应保留在 `people/`。

运行状态位于 Memory 工作区内，因此会随该工作区的 checkpoint 和备份保存。

## 本地开发

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm typecheck:web
corepack pnpm build:console
Set-Location "<Cortico 仓库路径>"
corepack pnpm check:extension "<Cortico 仓库路径>\extensions\node_modules\cortico-bot-continuity"
```

项目采用 MIT License，详见 [LICENSE](LICENSE)。

部分代码源自 Phantivia 编写的 Cortico `bots/corti-soulmate/`。新增和修改部分由 DTMosken 编写；LICENSE 保留上游版权声明。


## 认知帧与 STATE

认知处理只针对主线收到的外部事件。worker 完成通知是内部事件；仅有内部事件的一批不生成认知帧、不更新认知状态，也不刷新 STATE。同批有外部事件时，按那些外部事件处理。

认知帧配置先成为草稿，点击“保存整页”后从下一批外部投递生效。连接测试使用已保存配置，密钥操作独立执行。

白名单优先于黑名单；没有命中时默认触发。一条规则中的 World、事件类型、场景类型、场景 ID 和发送者 ID 条件全部满足才命中，多条规则任意命中即可。空条件匹配所有消息。近期消息用当前草稿预览匹配原因，候选来自已投递事件，也允许手填 ID。

每个条件独立选择精确或正则匹配；现有字符串条件仍为精确匹配。正则匹配整个值，默认区分大小写，可单独开启忽略大小写。使用 RE2JS 线性匹配引擎，支持字符组、分组、或与重复，不支持回溯引用和前后查找。`world(\..*)?` 匹配根类型和以点分隔的子类；也可使用精确 `world` 和正则 `world\..*` 两条规则。正则正文无需 `/` 分隔符。非法正则阻止加入草稿与整页保存；手动配置中的无效规则整条跳过，控制台显示错误，投递时记录诊断。

预览按 World → 事件类型折叠，只统计最近最多 200 条投递事件。World 默认展开，事件类型默认折叠；浏览器按部署保存展开状态。触发和屏蔽过滤默认全选，分类计数只包含当前显示的消息。每类先显示最新 10 条，可每次增加 10 条，并保留匹配原因和快捷建规则。

一批消息中，每个有允许消息的场景生成一帧。被屏蔽的消息仍作为同场景评估上下文，所有消息继续投递主模型，机械状态和近期历史继续更新。

STATE 正文不再重复嵌入各帧。主线开启新上下文时刷新；外部投递时检查内容变化，默认每 10 个外部投递批次再提醒一次；`cognition.stateReminderBatches=0` 关闭重复提醒。实际刷新后计数归零。dream 写入 STATE 后，下一批外部投递或新上下文可见，不单独唤醒。STATE 仍由 dream 维护。

## 交接与梦预算

新部署的 `context.keepRatio` 默认 0.1；已有部署的显式配置保留。交接笔记使用本地渲染，不增加摘要模型调用；清理内部认知帧和 STATE 通知，保留一份独立背景，背景最多占交接笔记预算的四分之一且不超过 8000 个本地估算 token，不逐场嵌套复制。

```json
{
  "dream": {
    "maxInputTokens": 128000,
    "maxBackgroundTokens": 8000,
    "softRounds": 40,
    "maxRounds": 60,
    "maxRetries": 2,
    "retryDelaySec": 30,
    "materialRetentionDays": 30,
    "traceRetentionDays": 7,
    "recordDetailedTrace": false
  }
}
```

dream 的初始输入包含前缀、任务引导、材料目录、一份当前 STATE 和受预算限制的旧背景。近期完整消息与工具调用／回执优先进入上下文；较早材料保存在部署 dataDir 下的 `continuity/dream/raw/`，通过只读 `dream_materials` 与 `dream_read_material` 按页、按范围读取。未直接注入的材料仍未整理。预算是本地估算，不包含服务端工具声明与后续工具结果。

主循环的默认软／硬上限仍为 8／16。dream 默认第 40 轮提示收尾，第 60 轮硬结束；不在上限外增加收尾请求。等待中的交接材料合并进入下一场，运行中的一场保持原输入。

收尾工具 `surface` 接收 `status`（complete／partial）、`processedMaterials`（材料 ID 数组）、`pendingTasks`（剩余待办）和 `text`。全部完成且没有待办时，`processedMaterials` 可用 `"all"`，展开为本场梦开始时确定的材料 ID；新排队材料不包含在内，记录仍保存完整 ID 数组。部分完成必须列出已处理的 ID。text 可为空。只有明确确认的已整理材料开始计算保留期。异常、达到上限或自然退出但没有确认时，默认间隔 30 秒最多重试 2 次；每次重新读取当前 STATE 和未确认材料，已有 Memory 修改保留。重试耗尽后材料仍保留；明确确认部分完成时不自动重试。待办由 dream 写入 Memory 的 `note/dream-pending.json`。

“梦”页的“继续未完成整理”只整理保留材料，不触发主线程交接，不添加当前主线程的新经历。前缀和背景随交接保存在 dataDir 下的 `continuity/dream/context.json`，供重启后继续使用；旧部署没有此文件时，从当前主线程取得前缀和交接背景。等待重试时可见下次重试时间，诊断显示重试来源。Core 停止定时器后不再触发重试；Persona 停止时取消等待中的重试。

默认诊断记录输入组成、工具名、文件路径、耗时、结果长度和完成状态；详细追踪默认关闭，开启后另存工具入参与回执。诊断不注入上下文。模型轮数按 usage 中唯一 generationId 计，HTTP 尝试数包含重试；缺失计量显示未知，计量与本地估算均不表示实际账单。

每场 dream 结束后清理本包新增资料：已确认材料保留 30 天，详细追踪保留 7 天。未确认材料不自动删除；现有 runs 和 Memory 笔记不参与此清理。配置默认值的变化不重写部署 config.json。
