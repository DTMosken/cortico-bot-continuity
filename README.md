<!-- Owner: index.ts, persona/character-state.ts, persona/subconscious/prompts.ts -->

# cortico-bot-continuity

`cortico-bot-continuity` 是一个面向 Cortico 的 Bot 扩展。它在 Persona 的 Memory 中保存
跨会话状态，并为每次外部事件生成认知帧，帮助回复延续近期互动状态。

## 功能

- 继承分层 Memory、Dream、作息、QQ 草稿确认与控制台能力。
- 同一来源下，同一 `senderKey` 的群聊和私聊共享短期互动热度；不同发送者各自独立。
- 全局精力只随全局空闲时间在 `0.55` 到 `0.65` 之间变化。
- 认知帧提供主动性、话题延续、温度、玩笑、自我披露和克制倾向，并要求这些倾向实际影响下一次回复。
- Dream 只能把适用于所有人的持续约束写入 `state/STATE.md`；个人信息保存在 `people/`。

状态只由事件时间、数量、来源和发送者标识更新，不会从消息文本推断信任、冒犯或情绪。

## 安装

要求 Node.js 22 或更新版本，以及 Cortico Bot 扩展 API 5。

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

## Memory 与状态迁移

Persona 的运行状态保存在部署的 `memory/state/` 中：

- `runtime.json` 保存版本化的全局精力、按发送者区分的互动热度、事件 cursor 和可复现 seed，采用原子写入。
- `STATE.md` 是 Dream 维护的全局语义状态；主 Persona 通过认知帧读取。
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
