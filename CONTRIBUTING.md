<!-- Owner: package.json, tsconfig.json, tsconfig.web.json, vitest.config.ts, .github/workflows/ci.yml, .github/workflows/release.yml -->

# 贡献指南

本仓库维护 Cortico 的 Bot 扩展，包括 Persona、Memory 状态、后台子代理和扩展控制台。使用方法见 [README](README.md)，社区交流遵循 [行为准则](CODE_OF_CONDUCT.md)。

## Issue

提交前搜索已有 Issue。一个 Issue 描述一个问题或一项需求，使用缺陷报告或功能请求表单。

缺陷报告需要版本、实际行为、预期行为和复现步骤。日志、配置和截图只保留复现必需的信息，移除令牌、凭据、私人对话和个人标识。

功能请求说明使用场景、预期行为和已有办法的不足。涉及 Core 或某个 World 的能力时，说明与本扩展的关系，并在对应仓库讨论其负责的改动。

## 开发环境

CI 使用 Node.js 24，开发时建议使用相同版本。pnpm 版本由 `package.json` 的 `packageManager` 指定。

测试和类型检查引用相邻的 Cortico 源码，目录关系为：

```text
<父目录>/
  Cortico/
  cortico-bot-continuity/
```

Cortico 的检查基线取自 `.github/workflows/release.yml` 的 `CORTICO_REF`。以下 PowerShell 命令在同一父目录检出两个仓库，并安装各自的锁定依赖：

```powershell
git clone https://github.com/Pal-AI-Lab/Cortico.git Cortico
git clone https://github.com/DTMosken/cortico-bot-continuity.git cortico-bot-continuity
Set-Location cortico-bot-continuity
$corticoRef = (Select-String -Path .github/workflows/release.yml -Pattern '^  CORTICO_REF: ([a-f0-9]{40})\s*$').Matches.Groups[1].Value
git -C ../Cortico checkout $corticoRef
corepack pnpm --dir ../Cortico install --frozen-lockfile
corepack pnpm install --frozen-lockfile
```

已经检出的仓库可直接按上述目录关系使用；其他系统按相同的 `CORTICO_REF` 检出 Cortico。

## 修改与验证

Persona 负责提供上下文文本和管理 Memory，平台行为由对应 World 负责。配置项在所属组件的配置组中声明，由控制台按 schema 渲染。

变更行为时补充能复现问题或验证契约的测试。测试使用临时目录和模拟模型响应，运行时不访问真实服务，也不启动真实 bot。

在扩展目录执行：

```powershell
corepack pnpm test
corepack pnpm run typecheck
corepack pnpm run typecheck:web
git diff --check
```

修改扩展控制台时，还需执行 `corepack pnpm run build:console`。在隔离的检出目录构建，避免覆盖运行中的 bot 正在使用的资源。

扩展契约检查从相邻的 Cortico 目录执行：

```powershell
corepack pnpm --dir ../Cortico check:extension ../cortico-bot-continuity
```

CI 的 `Validate` 还执行发布文件审计和打包内容检查，完整步骤见 [ci.yml](.github/workflows/ci.yml)。

## Pull Request

从最新 `main` 创建分支，一个 PR 处理一个主题。说明变更解决的问题、可见行为、验证结果，以及兼容性或迁移要求；文档和示例与行为一同更新。

提交信息使用 Conventional Commits，例如 `fix(persona): 修正状态恢复` 或 `docs: 添加贡献规范`。类型和作用域使用小写英文，完整主题不超过 72 个字符。

通过 PR 合入 `main`，提交前运行上述测试和类型检查；合并条件以 GitHub 当前保护规则为准。使用 AI 辅助时，提交者仍需核对行为和验证结果。

## 版本与发布

版本更新和 npm 发布由维护者通过 Release 工作流操作。普通代码 PR 无需修改版本号。流程见 [发布说明](.github/release.md)；提交代码或合并 PR 不会自动发布 npm 包。
