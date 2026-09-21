# 发布到 npm

先更新 `package.json` 的版本，重建控制台产物并完成验证：

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm typecheck:web
corepack pnpm build:console
npm pack --dry-run --json
git diff --check
git add <本次变更的确切路径>
git commit -m "fix(persona): <说明>"
```

`.local.env` 保持未跟踪，写入有发布权限并启用 bypass 2FA 的 npm granular token：

```text
NPM_TOKEN=<token>
```

`NPM_TOKEN` 不会自动覆盖用户级 `.npmrc` 的登录凭据。发布时生成临时配置，显式让 npm 使用该 token，并在命令结束后删除它：

```powershell
$tokenLine = Get-Content .local.env | Where-Object { $_ -match '^\s*NPM_TOKEN\s*=' } | Select-Object -First 1
$token = ($tokenLine -replace '^\s*NPM_TOKEN\s*=\s*', '').Trim().Trim('"').Trim("'")
$tempNpmrc = Join-Path ([IO.Path]::GetTempPath()) ('cortico-publish-' + [guid]::NewGuid().ToString('N') + '.npmrc')
[IO.File]::WriteAllText($tempNpmrc, "//registry.npmjs.org/:_authToken=$token`n", [Text.UTF8Encoding]::new($false))
try { npm publish --userconfig $tempNpmrc } finally { if (Test-Path $tempNpmrc) { [IO.File]::Delete($tempNpmrc) } }
```

发布命令成功后，npm registry 可能仍在处理。等到下面两条都显示新版本，发布才完成：

```powershell
npm view cortico-bot-continuity@<版本> version
npm view cortico-bot-continuity dist-tags.latest
```
