# Testing and known limitations / 测试与边界

- Linux, Node.js 22.16.0: `npm test` (113 passed, 0 failed) and `npm run check`.
- Core and simulated-host coverage: JSONC parsing, current-profile discovery, model validation, duplicate handling, import sanitization, native command contract, backup and restore, concurrent modifications, settings application and localization. Release-manifest validation also tested.
- Chromium + Playwright with mocked VS Code messages: English and Simplified Chinese; empty initial state, model list, search, edit, copy, delete, add, append JSON, auxiliary selector and save message. Widths 1200/850/720/400 px showed no horizontal overflow. No page errors. The test inlined resources and omitted CSP to work in the browser harness; the real package retains CSP.
- Screenshots contain synthetic example models only.
- 未在真实 Windows VS Code 宿主验证安装、内部密钥命令、免登录、真实接口调用或组织策略。Official Marketplace `vsce` packaging and upload have not been executed in this environment. Do not treat the local unsigned VSIX as a Marketplace-approved package.

Before release, test in a separate VS Code Desktop profile with a dedicated test key: verify configuration, absence of the new plaintext key in model JSON, model selection, actual chat, key reuse, backup/restore and both UI locales. Verify final official VSIX and review publisher/registry requirements.
