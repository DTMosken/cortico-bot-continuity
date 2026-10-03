<!-- Owner: index.ts, persona/appraisal.ts, persona/config.ts, persona/character-state.ts, persona/laya-python.ts, persona/index.ts, persona/tools.ts, console/config.ts, console/cognition.ts, console/cognition-preview.ts, console/subagents.ts, persona/subagents/index.ts, persona/subagents/config.ts, persona/subagents/store.ts, persona/subagents/prompts.ts, persona/SUBAGENTS.md, persona/SUBAGENT_WORKER.md, persona/cognition.ts, persona/subconscious/index.ts, persona/subconscious/prompts.ts, persona/subconscious/materials.ts, python/laya_multilingual_worker.py -->

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

要求 Node.js 22 或更新版本，以及 Cortico Bot 扩展 API 6。

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

## 子代理

在 Persona 的“子代理”页配置并行上限、轮数、摘要长度及工具权限。World 开关只暂停或恢复子代理对该组工具的权限，保留逐工具选择；World 自身的启用状态和主线可见性由原配置控制。首次发现时，可委派的只读工具默认开启；后续发现的新工具默认关闭。

Memory 始终只读，对外发送、主线调度和 `qq_view_image` 保留给主 agent。其它 World 工具可以逐项授权；主 agent 在每项任务中再选择一个子集。权限在接受任务和每次调用时检查，关闭权限、隐藏或卸载 World 后禁止新的相关调用。已有在途操作不强制取消。

默认同时运行 4 项任务，满额时拒绝新任务，不排队。每个 worker 默认第 8 轮提示收尾，第 16 轮硬结束。摘要默认最多 1000 字符；完整结果默认每页 2000 字符，可按 `nextOffset` 继续读取。保存配置立即更新工具权限；新 worker 使用新额度，运行中的 worker 保持启动时的轮数额度。主线说明保持快照，更新后手动“重载系统前缀”。

主线工具：

- `subagent_spawn`：提供 `task`、文本数组 `materials` 和工具名数组 `tools`，立即返回任务 ID。`tools` 可为空。
- `subagent_list`：分页查看状态与摘要，支持 `status`、`offset`、`limit`。
- `subagent_get`：按 `taskId`、`offsetChars`、`maxChars` 读取结果；`maxChars` 不超过配置页长。

例如委派一项只读核查：

```json
{
  "task": "核对这份笔记中的事实，返回来源和待确认事项；如需修改，给出文字建议。",
  "materials": ["请读取 note/research.md"],
  "tools": ["read_file", "grep_files"]
}
```

worker 的上下文包含 ORIENTATION、当前宪法、`SUBAGENT_WORKER.md` 和所选工具所属 World 的环境说明，随后加入任务和选定材料。主线历史、MEMORY 0–4、认知帧及 STATE 不自动复制；相关内容可由主 agent 选入任务材料，或由 worker 通过获准的工具按需读取。worker 只能执行一项任务，用 `subagent_finish(status, summary, result)` 确认 complete、partial 或 failed；自然结束或达到轮数上限而未确认时，状态为 unconfirmed，保留最后的文本结果。Memory 编辑或删除建议写在 result 中，由主 agent 重新读取文件后判断和执行。

任务与结果保存在部署 dataDir 的 `continuity/subagents/`，可跨主线上下文交接查询。进程重启后，未结束记录改为 interrupted，已产出结果保留，不自动重跑。停机禁止 worker 发起新的工具操作；首版不提供强制取消工具。

“系统提示词”页分别编辑 `SUBAGENTS.md`（主线规范）和 `SUBAGENT_WORKER.md`（worker 规范），占位符由页面声明。新 worker 读取当前执行模板。主线通过 PREFIX 中的 `{{persona.subagents}}` 引入委派规范，worker 模板只进入 worker 的系统提示词。已有部署若覆盖了 PREFIX.md，需在 `{{persona.toolUsage}}` 后补入 `{{persona.subagents}}`，保存后手动重载系统前缀。

## 即时评估

即时评估只影响本轮回复的主动性、话题延续和玩笑度。评分本身不写入个人档案；插件会在 `state/appraisal-history.json` 中保存各会话最近 20 条、24 小时内收到的消息，以及 QQ 工具报告发送成功的回复。群聊整批只评估一次；输入明确区分当前消息与历史，并按本地估算将完整评分请求限制在 1000 token 内。启用 `debugLog` 才记录有限评分。
Jev 获得脱敏后的当前及近期历史文本；未开启 `appraisal.jev.allowRemoteText` 时不会调用远端。
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

### Jev

设置 `provider: "jev"` 后，仍需显式启用 `jev.allowRemoteText`。在 Persona 的“认知帧”页选择“Jev 来源”，然后点击旁边的“打开密钥文件”按钮，填写部署 `.env` 中的 `CORTICO_JEV_TYPESAFE_API_KEY`、`CORTICO_JEV_OPENROUTER_API_KEY` 或 `CORTICO_JEV_API_KEY`。自定义来源才显示服务地址。旧部署中的 `CORTICO_JEV_API_KEY` 仍可用于 TypeSafe。只有来源密钥存在才会发送脱敏后的当前消息及同会话近期历史；请求按配置超时且不重试，失败时将语义评分标为不可用。“即时评估来源”下的“测试连接”使用固定测试文本，只有所选模型返回有效评估才报告成功。

```json
{
  "appraisal": {
    "provider": "jev",
    "jev": {
      "allowRemoteText": true,
      "source": "typesafe",
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
