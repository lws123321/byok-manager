# 发布 / Release

当前源码使用本地占位 Publisher `asong-local`。公开扩展名称为 `byok-manager`，与旧企业版的扩展 ID 不同；模型配置仍由 VS Code 当前 Profile 维护，但插件备份目录不会自动迁移。不要同时启用两个版本来编辑同一配置文件。

## Git 仓库

在 GitHub 或其他 Git 服务上创建空仓库（先不要生成 README）。解压源码，在 `byok-manager` 文件夹打开 PowerShell：

```powershell
git init -b main
git add .
git commit -m "feat: initial public BYOK Manager release"
git remote add origin https://github.com/YOUR_USERNAME/byok-manager.git
git push -u origin main
```

将 URL 换为自己的仓库地址；使用本机 Git Credential Manager 或 SSH 完成鉴权。不要把 PAT 写在 URL、源码或脚本里。若仓库已有提交，应先 clone 并合并源码，禁止盲目 force push。

## Marketplace

1. 在 https://marketplace.visualstudio.com/manage 注册自己的 Publisher，核对名称与 ID。
2. 先使用测试 Profile 实测密钥录入、保存、恢复、免登录会话及中英文 UI。确认许可证和品牌、无内部信息。
3. 安装官方打包工具，运行测试并生成 Marketplace 候选包：

```powershell
npm test
npm run check
npm install --no-save --package-lock=false @vscode/vsce
$env:BYOK_PUBLISHER = 'YOUR_PUBLISHER_ID'
# Optional: after the public repository exists
$env:BYOK_REPOSITORY = 'https://github.com/YOUR_USERNAME/byok-manager'
npm run package:marketplace
```

脚本创建临时发布目录，使用真实 Publisher 生成 manifest，并调用官方 vsce，不改写本地源码。生成 `dist/<publisher>.byok-manager-0.5.0.vsix`。发布前请检查 `vsce` 输出并在本地安装最终包验证。

4. 在 Marketplace 管理页面上传候选 VSIX。推荐首次手动发布，避免在脚本中管理 PAT。也提供 `npm run publish:marketplace`，必须显式设置 `BYOK_CONFIRM_PUBLISH=yes` 并通过官方 vsce 支持的认证方式完成授权；没有凭据内置。

官方文档：https://code.visualstudio.com/api/working-with-extensions/publishing-extension

本地离线 `npm run package` 与官方 Marketplace 打包流程不同：本地 VSIX 未签名，不能当作已通过 Marketplace 检查的发布包。官方打包及上传在本次环境中未验证。
