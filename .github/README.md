# `.github/workflows/release.yml`

工作流发布本仓库的 npm 包。`workflow_dispatch` 提供 patch、minor、major 三种版本增量。

## 检查环境

工作流在 GitHub 托管的 Ubuntu runner 上使用 Node 24 和 `package.json` 声明的 pnpm 版本。Cortico 固定在 0.1.7 的提交 `9ad634a298d40cee6ba8b68162ea9f49dd220bab`，用于类型、控制台 UI、测试夹具与扩展检查。

两个仓库按以下目录关系检出；本地运行相同检查也使用这个关系：

```text
<父目录>/
  Cortico/
  <扩展仓库>/
```

两个目录各自执行 `pnpm install --frozen-lockfile`。本地开发直接使用两个仓库的实际目录。

## 发布

在 GitHub 的 Actions 页面选择 Release，选定分支与版本增量后点击 Run workflow。工作流更新版本与源码地址，执行测试、类型检查、console 构建和扩展检查，审计文件并生成 npm tarball。检查通过后，只提交 `package.json`，创建 `v<版本>` 标签，并将提交和标签一起推送到选定分支。

发布使用 npm Trusted Publishing。npm 包的 Trusted Publisher 设置须填写本仓库的 GitHub 用户或组织、仓库名以及文件名 `release.yml`，允许 `npm publish`，Environment 留空。工作流未使用 npm 发布 Token。

仓库规则须允许 GitHub Actions 向选定分支提交版本变更与创建标签。推送成功后，工作流发布已生成的 tarball；发布成功后核对指定版本和 `latest`。若发布步骤失败，已推送的版本提交和标签仍然存在；修复原因后可从该标签检出并发布该版本，重新运行 Release 会再增加版本。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[GitHub 手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。
