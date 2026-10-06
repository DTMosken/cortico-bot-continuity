# `.github/workflows/release.yml`, `.github/workflows/ci.yml`

## CI

推送分支、向 `main` 提交 PR 或手动运行 CI 时，`Validate` 检查执行测试、Node 与 console 类型检查、console 构建、扩展检查、发布文件审计和打包内容检查。CI 只有仓库读取权限。

`main` 要求至少一人批准 PR、所有讨论已解决、`Validate` 通过，且分支与 `main` 同步。新提交使已有批准失效；规则适用于管理员。`v*` 标签不能更新或删除。

## 检查环境

工作流在 GitHub 托管的 Ubuntu runner 上使用 Node 24 和 `package.json` 声明的 pnpm 版本。CI 从 `release.yml` 读取 `CORTICO_REF`，两者使用同一个 Cortico 固定提交，用于类型、控制台 UI、测试夹具与扩展检查。

两个仓库按以下目录关系检出；本地运行相同检查也使用这个关系：

```text
<父目录>/
  Cortico/
  <扩展仓库>/
```

两个目录各自执行 `pnpm install --frozen-lockfile`。

## 准备版本

在 GitHub Actions 页面运行 Release，选择 `main`，将 `release_type` 设为 `patch`、`minor` 或 `major`。工作流更新版本与源码地址，完成测试、类型检查、构建、扩展检查、审计与打包，然后将 `package.json` 提交到 `release/v<版本>` 分支并创建版本 PR。

工作流为版本分支手动触发 CI。通过检查及审批后合并 PR。准备版本不会创建标签或发布 npm 包。

## 发布

版本 PR 合并后，在 `main` 再运行 Release，将 `release_type` 设为 `publish`。工作流验证已提交的版本，生成 tarball，创建并推送 `v<版本>` 标签，再发布到 npm 并核对指定版本和 `latest`。

发布使用 npm Trusted Publishing。npm 包的 Trusted Publisher 设置须填写 `DTMosken`、`cortico-bot-continuity` 和文件名 `release.yml`，允许 `npm publish`，Environment 留空。

Actions 默认权限为读取；仓库允许 Actions 创建 PR。Release 单独申请提交版本分支、创建 PR、触发 CI、创建标签与取得 npm 发布身份所需的权限。

若 npm 发布失败，已推送的标签仍然存在。修复原因后需检出该标签发布相同版本；再次选择 `publish` 会因标签已存在而停止。已发布版本及 `v*` 标签保持原内容。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[GitHub 手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。
