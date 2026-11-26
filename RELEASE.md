# 发行版本与打包 / Edition builds

两个扩展共享根 `package.json` 的版本号、`src/` 业务逻辑、管理界面、语言包与原生 Walkthrough。发行差异属于**构建输入**，不是用户设置：扩展运行时不能切换发行版本。不要为另一个版本复制整个 `src/` 或建立长期分支。

## Public

Public 使用 `editions/public.json`，正式扩展 ID 为 `asong-dev.byok-manager`。不预置接口和模型，不自动指定辅助模型。使用 Node.js 22+，在 Git 工作区根目录执行：

```sh
npm test
npm run check
npm run build:public
npm run package:public
```

产物位于 `dist/public/` 和 `dist/enterprise/`；`npm run package` 另外生成按白名单收集的公开源码 ZIP（含示例模板，不含私有配置）。`build:*` 用于验证隔离构建；需要安装文件时使用 `package:*`。构建不会编辑项目根 manifest 或用户的 VS Code 配置。

## Enterprise（私有构建输入）

以 `editions/enterprise.example.json` 为字段说明，而不是可发布的企业配置。模板只含虚构的身份、网关、模型与设置；不要把它当作以前版本的替代品。将**经旧版核对的完整配置**放在被忽略的 `editions/enterprise.local/config.json`，也可通过 `BYOK_ENTERPRISE_CONFIG` 指向单独私有检出的配置文件。不要放进公开文档、测试快照或 Git index。

- `publisher` 和 `name` 组成扩展 ID。升级必须沿用原内部版的 ID，不能只保留显示名称。`displayName` 是用户可见名称；`aliases` 将旧命令映射到共享实现。
- `preset` 保存模型组和模型字段。模型 ID、URL、协议、上下文、输出限制、能力和推理档位应逐项从已核验版本移植。**不要加入 API Key、密钥引用或授权请求头。**
- `settings` 描述推荐设置及值。模型选择器可引用所选模型的名称或 ID。`auxiliaryModel` 只指定默认选择；它不是凭据，也不应在扩展启动时写入设置。
- `features.presetButton` 控制是否在构建时生成加载预设的入口。`locales.en`、`locales.zh-cn` 提供按钮和教程差异；通用维护、备份、密钥和故障排查内容继续共用。
- 使用旧版的命令、备份样本与设置清单核验升级。同一扩展 ID 使 VS Code 继续提供同一个扩展存储目录；不要把 Public 和 Enterprise 的备份目录合并。API Key 始终由用户通过原生凭据录入流程提供，安装和加载预设都不等于确认保存。

```sh
npm run build:enterprise
npm run package:enterprise
npm run package:all
```

Public 的七项推荐设置按独立清单核对键、值和模型选择器类型。Enterprise 的模型、辅助模型、八项设置和旧命令映射按已经核实的 0.4.2 基线摘要校验，单改私有 JSON 不能生成行为不同的升级包；有意改变兼容约定时，先单独评审，再更新基线与测试。

缺少或不符合约束的私有配置应导致命令失败。不要在失败后发送 `dist/` 中的旧包；以本次命令的退出状态和对应文件为准。企业包仅通过内部渠道分发，**不要上传到公共托管或 Marketplace**。

## Public Marketplace 候选包

不要在仓库根目录直接运行 `vsce package` 或 `vsce publish`：根 manifest 的预打包步骤会拒绝执行，根 `.vscodeignore` 默认排除源码和所有私有输入。正式流程只从独立的白名单暂存目录打包。

官方 `vsce` 仅用作维护者的打包工具，不是扩展运行时依赖。如本地尚未安装，可执行 `npm install --no-save --package-lock=false @vscode/vsce`。运行 `npm run package:marketplace` 生成候选包；若流程要求指定仓库，`BYOK_REPOSITORY` 应使用无凭据的公开 HTTPS 仓库地址。发布时不要切换 Publisher 或交给脚本任意 VSIX 文件。`npm run publish:marketplace` 是有副作用的独立操作，只允许针对通过检查的 Public 候选包并需显式授权；打包不等于发布。

Public README 的相对 PNG 路径供 GitHub 渲染。上传前确保公开仓库对应版本已有这些图片；`vsce` 会为 Marketplace 转换链接。VSIX 自带图片供内置教程离线使用。

## 检查边界

在可信的 Git 工作区构建。文件白名单决定哪些运行文件能进入临时目录；Git index、公开工作树和最终归档检查负责发现误跟踪的私有文件、已知凭据及私有标记。`.gitignore` **不能**使已跟踪的内容变安全，关键字检查也不是对任意未知密钥、图像内容或整个历史的证明。打包失败先排除来源，不要跳过检查。若私密数据已被提交或传播，需要另外撤销权限、轮换凭据并处理历史版本。验证方法见 `TESTING.md`。
