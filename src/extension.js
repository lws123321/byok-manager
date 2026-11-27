'use strict';
const { tr, setLocale, isChinese } = require('./i18n');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseDocument, parseGroups } = require('./jsonc');
const modelDiscovery = require('./discovery');
const core = require('./core');
const checkoutEdition = require('../editions/public.json');
const blankGroup = () => ({ name: 'custom', vendor: core.VENDOR, apiType: 'chat-completions', models: [] });
const isCustomGroup = group => group.vendor === core.VENDOR && !group.name.startsWith(core.TEMP_PREFIX);
const modelCount = group => Array.isArray(group.models) ? group.models.length : 0;
const OPEN_JSON = 'workbench.action.openLanguageModelsJson';
const ADD_GROUP = 'lm.addLanguageModelsProviderGroup';
const MANAGE = 'workbench.action.chat.manage';
function assertWorkspaceAllowed({ desktop, trusted, aiDisabled }) {
  if (!desktop) throw new Error(tr("此版本仅支持 VS Code 桌面版，不支持 vscode.dev。", "Only VS Code Desktop is supported; vscode.dev is not supported."));
  if (!trusted) throw new Error(tr("请在可信工作区或新的本地空窗口中使用。", "Use a trusted workspace or a new local empty window."));
  if (aiDisabled) throw new Error(tr("当前关闭了 AI 功能（chat.disableAIFeatures）。请先检查设置或组织策略，工具不会强行更改。", "AI features are disabled (chat.disableAIFeatures). Check settings or organization policy; this tool will not override them."));
}
function invalidDiscoveryKey(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f\u2028\u2029]/.test(value) || value.includes('${')) {
    return tr('请输入实际 API Key，不要使用变量引用、换行或控制字符。', 'Enter an actual API key without variable references, line breaks, or control characters.');
  }
}
function discoveryDraft(text) {
  const root = parseDocument(text);
  if (!Array.isArray(root.value)) throw new Error(tr('当前模型必须是数组。', 'Current models must be an array.'));
  if (root.value.length >= 300) throw new Error(tr('草稿最多包含 300 个模型；请先移除不需要的模型。', 'A draft can contain at most 300 models. Remove models before adding more.'));
  const ids = new Set();
  for (const model of root.value) {
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    if (!id || /[\x00-\x1f\x7f]/.test(model.id) || ids.has(id)) throw new Error(tr('请先修复草稿中无效或重复的模型 ID。', 'Fix invalid or duplicate model IDs in the draft first.'));
    ids.add(id);
  }
  return { root, ids };
}
function appendDraftModels(text, root, models) {
  const last = root.children.at(-1);
  // Insert before the original trailing trivia (including any comma and comments).
  const offset = last?.end ?? root.end - 1, eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = models.map(m => '  ' + JSON.stringify(m, null, 2).replaceAll('\n', eol + '  ')).join(',' + eol);
  return text.slice(0, offset) + (last ? ',' : '') + eol + body + (last ? '' : eol) + text.slice(offset);
}
class ByokTool {
  constructor(vscode, context, edition = checkoutEdition, discovery = modelDiscovery) {
    this.discovery = discovery;
    this.edition = edition;
    setLocale(vscode.env.language);
    this.v = vscode; this.context = context; this.panel = undefined;
    this.configUri = undefined; this.pendingKey = undefined; this.busy = false;
    this.template = blankGroup();
    this.baseline = undefined;
  }
  async environment() {
    const commands = new Set(await this.v.commands.getCommands(false));
    const providers = [];
    for (const ext of this.v.extensions.all) {
      if (!['github.copilot', 'github.copilot-chat'].includes(ext.id.toLowerCase())) continue;
      const contributions = ext.packageJSON?.contributes?.languageModelChatProviders;
      for (const entry of Array.isArray(contributions) ? contributions : contributions ? [contributions] : []) {
        if (entry.vendor === core.VENDOR) providers.push({ ext, entry });
      }
    }
    const provider = providers.find(p => p.entry.configuration?.properties?.apiKey?.secret === true);
    const config = this.v.workspace.getConfiguration();
    return {
      version: this.v.version,
      openJson: commands.has(OPEN_JSON), addGroup: commands.has(ADD_GROUP),
      manage: commands.has(MANAGE), provider: !!provider,
      providerExtension: provider ? provider.ext.id + ' ' + provider.ext.packageJSON.version : tr("未发现可用的官方 Custom Endpoint 配置声明", "No supported official Custom Endpoint configuration was found."),
      aiDisabled: config.get('chat.disableAIFeatures') === true,
      agentHostSupported: config.inspect('chat.agentHost.byokModels.enabled') !== undefined,
      utilitySupported: config.inspect('chat.byokUtilityModelDefault') !== undefined,
      statelessSupported: !!provider?.entry.configuration?.properties?.models?.items?.properties?.statefulResponses,
      trusted: this.v.workspace.isTrusted,
      desktop: this.v.env.uiKind === this.v.UIKind.Desktop
    };
  }
  async ensureCompatible(needsSecret = false) {
    const env = await this.environment();
    assertWorkspaceAllowed(env);
    if (!env.openJson) throw new Error(tr("当前版本没有原生模型配置入口。请更新 VS Code 并启用官方 Copilot / Chat 功能。", "The native model configuration entry point is unavailable. Update VS Code and enable official Copilot / Chat features."));
    if (!env.provider) throw new Error(tr("未找到已启用的官方 Custom Endpoint 密钥配置声明。请启用或更新官方 GitHub Copilot 扩展。", "No enabled official Custom Endpoint secret configuration found. Enable or update the official GitHub Copilot extension."));
    if (needsSecret && !env.addGroup) throw new Error(tr("当前版本没有经过核对的原生密钥写入命令。已停止；请在原生模型管理中录入 Key 后再复用。", "The native secret command is unavailable. Enter the key in native model management, then reuse it here."));
    return env;
  }
  async resolveConfig() {
    if (this.configUri) return this.configUri;
    const commands = await this.v.commands.getCommands(false);
    if (!commands.includes(OPEN_JSON)) throw new Error(tr("找不到“Open Language Models (JSON)”命令，请先启用 Chat 功能或更新 VS Code。", "The Open Language Models (JSON) command is unavailable. Enable Chat or update VS Code."));
    await this.v.commands.executeCommand(OPEN_JSON);
    const document = this.v.window.activeTextEditor?.document;
    if (!document || path.posix.basename(document.uri.path).toLowerCase() !== 'chatlanguagemodels.json') {
      throw new Error(tr("没有取得当前 Profile 的模型配置文件。请关闭弹窗，在主编辑器中重试；工具不会猜测路径。", "Could not locate the current profile model file. Close dialogs and retry from the main editor. The tool does not guess paths."));
    }
    if (!['file', 'vscode-userdata'].includes(document.uri.scheme)) {
      throw new Error(tr("当前配置 URI 类型未在此版本工具中支持，已停止。请在本地桌面窗口操作。", "This configuration URI scheme is unsupported. Use a local desktop window."));
    }
    this.configUri = document.uri;
    return document.uri;
  }
  async readConfig() {
    const uri = await this.resolveConfig();
    const doc = await this.v.workspace.openTextDocument(uri);
    if (doc.isDirty) throw new Error(tr("模型配置有未保存的修改。请先保存或撤销修改，再使用助手。", "The model file has unsaved changes. Save or discard them before continuing."));
    const text = Buffer.from(await this.v.workspace.fs.readFile(uri)).toString('utf8').replace(/^\uFEFF/, '');
    if (text !== doc.getText().replace(/^\uFEFF/, '')) throw new Error(tr("配置缓冲区与磁盘不同步，请重新打开配置文件后重试。", "The editor and disk are out of sync. Reopen the configuration file and retry."));
    parseGroups(text);
    return { text, uri, doc };
  }
  async writeConfig(expected, next) {
    const current = await this.readConfig();
    if (current.text !== expected) throw new Error(tr("配置已被其他窗口修改，本次写入已停止。请重新读取。", "The configuration was modified in another window. Reload before writing."));
    const edit = new this.v.WorkspaceEdit();
    edit.replace(current.uri, new this.v.Range(current.doc.positionAt(0), current.doc.positionAt(current.doc.getText().length)), next);
    if (!await this.v.workspace.applyEdit(edit)) throw new Error(tr("VS Code 拒绝应用配置修改。", "VS Code rejected the configuration edit."));
    if (!await current.doc.save()) throw new Error(tr("配置未能保存，可能只读或磁盘不可写。请查看当前文件和备份。", "Could not save the configuration. Check file permissions and the backup."));
  }
  async post(message) { return this.panel?.webview.postMessage(message); }
  async notice(text, kind = 'info') { await this.post({ type: 'notice', text, kind }); }
  async show() {
    if (this.panel) { this.panel.reveal(); return; }
    this.panel = this.v.window.createWebviewPanel('byokManager', this.edition.displayName, this.v.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [this.v.Uri.joinPath(this.context.extensionUri, 'media')]
    });
    const panel = this.panel;
    const messages = panel.webview.onDidReceiveMessage(message => this.handle(message, panel));
    panel.onDidDispose(() => { messages.dispose(); this.pendingKey = undefined; this.panel = undefined; this.baseline = undefined; });
    const html = await this.html(panel.webview);
    if (this.panel === panel) panel.webview.html = html;
  }
  async html(webview) {
    const nonce = crypto.randomBytes(24).toString('base64');
    const template = await fs.readFile(path.join(this.context.extensionPath, 'media', isChinese() ? 'index.zh-cn.html' : 'index.html'), 'utf8');
    const escapeText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const settingsJson = JSON.stringify(Object.fromEntries(this.edition.settings.filter(s => !s.model).map(s => [s.key, s.value])), null, 2);
    return template.replaceAll('{{EDITION_DISPLAY_NAME}}', () => escapeText(this.edition.displayName))
      .replaceAll('{{RECOMMENDED_SETTINGS}}', () => escapeText(settingsJson)).replaceAll('{{CSP_SOURCE}}', webview.cspSource).replaceAll('{{NONCE}}', nonce)
      .replaceAll('{{STYLE_URI}}', webview.asWebviewUri(this.v.Uri.joinPath(this.context.extensionUri, 'media', 'style.css')).toString())
      .replaceAll('{{SCRIPT_URI}}', webview.asWebviewUri(this.v.Uri.joinPath(this.context.extensionUri, 'media', 'app.js')).toString());
  }
  async refresh(selection, draftKind, { explicitReload = false, expectedPanel } = {}) {
    const env = await this.environment();
    if (expectedPanel && this.panel !== expectedPanel) return;
    let groups = []; let error;
    try { groups = parseGroups((await this.readConfig()).text).value; }
    catch (e) {
      if (explicitReload || draftKind === 'preset') throw e;
      error = core.safeError(e, [this.pendingKey]);
    }
    if (expectedPanel && this.panel !== expectedPanel) return;
    const custom = groups.filter(isCustomGroup);
    const explicitPreset = draftKind === 'preset';
    const chosen = explicitPreset ? custom.find(g => g.name === this.edition.preset.name)
      : selection === null ? undefined : selection === undefined ? custom.find(g => g.name === this.edition.preset?.name) || custom[0]
      : custom.find(g => g.name === selection);
    if (explicitReload && selection !== undefined && !chosen) throw new Error(tr('模型组已不存在。可选择其他模型组或新建。', 'The model group no longer exists. Select another group or create a new one.'));
    const usePreset = explicitPreset || (!error && !chosen && selection === undefined && !!this.edition.preset);
    let template = this.template, baseline = this.baseline;
    if (usePreset || chosen || selection !== null) {
      template = usePreset ? core.sanitizePreset(this.edition.preset) : chosen ? core.publicGroup(chosen) : blankGroup();
      baseline = chosen ? { name: chosen.name, group: core.clone(chosen) } : undefined;
    }
    const modelUrls = [...new Set((template.models || []).map(m => m.url).filter(Boolean))];
    const panel = this.panel;
    const kind = draftKind || (usePreset ? 'preset' : chosen ? 'existing' : 'new');
    const delivered = await this.post({ type: 'state', env, draftKind: kind,
      groups: custom.map(g => ({ name: g.name, count: modelCount(g), hasKey: core.isSecretRef(g.apiKey) })),
      draft: { name: template.name || 'custom', apiType: template.apiType || 'chat-completions',
        defaultUrl: usePreset && template.url ? template.url : modelUrls.length === 1 ? modelUrls[0] : '',
        auxiliaryModel: usePreset && template.models.some(m => m.id === this.edition.auxiliaryModel) ? this.edition.auxiliaryModel : '',
        modelsText: JSON.stringify(template.models || [], null, 2) },
      selected: baseline?.name || '', configPath: this.configUri?.toString(true) || tr("尚未定位", "Not located"),
      hasPendingKey: !explicitReload && !!this.pendingKey, error
    });
    if (delivered === false || panel !== this.panel) return;
    this.template = template; this.baseline = baseline; this.displayedGroup = kind === 'existing' ? chosen?.name : undefined;
    if (explicitReload) this.pendingKey = undefined;
    if (panel) panel.reveal(undefined, true);
  }
  async handle(message, sourcePanel) {
    if (!message || typeof message.type !== 'string') return;
    const panel = this.panel;
    if (sourcePanel && sourcePanel !== panel) return;
    if (message.type === 'switchGroup' && (!sourcePanel?.active || typeof message.dirty !== 'boolean')) {
      if (sourcePanel && !this.busy) await sourcePanel.webview.postMessage({ type: 'busy', value: false });
      return;
    }
    if (this.busy) {
      if (message.type === 'ready' && panel) this.waitingPanel = panel;
      return;
    }
    this.busy = true;
    try {
      const delivered = await this.post({ type: 'busy', value: true, operation: message.type });
      if (delivered === false || this.panel !== panel) return;
      switch (message.type) {
        case 'ready': await this.refresh(); break;
        case 'refresh': await this.refresh(message.name ?? undefined, undefined, { explicitReload: true }); break;
        case 'switchGroup': await this.switchGroup(message.dirty, panel); break;
        case 'editionPreset': {
          if (!this.edition.features.presetButton || !this.edition.preset) break;
          const load = this.edition.locales[isChinese() ? 'zh-cn' : 'en']['edition.loadPreset'] || tr('加载预设', 'Load Preset');
          const answer = await this.v.window.showWarningMessage(tr('替换当前草稿？', 'Replace the current draft?'), {
            modal: true, detail: tr('加载预设会替换尚未保存的表单内容。暂存的 API Key 将保留。本机配置不会更改。', 'Loading the preset replaces unsaved form edits. The pending API key will be kept. Local configuration will not change.')
          }, load);
          if (answer === load) await this.refresh(null, 'preset');
          break;
        }
        case 'new': {
          const answer = await this.v.window.showWarningMessage(tr("新建模型组？", "Create a model group?"), { modal: true, detail: tr("当前未保存的草稿与暂存密钥将被清除，不会修改本机配置。", "Unsaved changes and the pending key will be discarded. No local configuration will be changed.") }, tr("新建", "New"));
          if (!answer) break;
          this.pendingKey = undefined; this.baseline = undefined;
          this.template = blankGroup();
          await this.refresh(null); break;
        }
        case 'setKey': await this.setKey(); break;
        case 'clearKey': this.pendingKey = undefined; await this.post({ type: 'key', pending: false }); break;
        case 'import': await this.importFile(); break;
        case 'export': await this.exportFile(message.form); break;
        case 'format': {
          const models = parseDocument(message.modelsText).value;
          if (!Array.isArray(models)) throw new Error(tr("模型配置必须是数组。", "Model configuration must be an array."));
          await this.post({ type: 'models', text: JSON.stringify(models, null, 2) }); break;
        }
        case 'discoverModels': if (panel) await this.discoverModels(message.form, panel); break;
        case 'addModels': await this.addModels(message); break;
        case 'mergeModels': {
          const result = core.mergeModels(message.form, message.incomingText, message.replace === true);
          await this.post({ type: 'merged', text: JSON.stringify(result.models, null, 2) });
          await this.notice(`${tr("已追加 ", "Added ")}${result.added}${tr("、更新 ", ", updated ")}${result.updated}${tr("、跳过 ", ", skipped ")}${result.skipped}${tr(" 个模型。尚未写入配置；导入已移除密钥和请求头。", " models. Changes are not saved; imported credentials and headers were removed.")}`);
          break;
        }
        case 'validate': {
          const { group, warnings } = core.buildGroup(message.form, this.template);
          await this.notice(`${group.models.length}${tr(" 个模型的格式与字段校验通过。未验证 API Key、模型能力或网络连通性。", " models passed format and field validation. API key, model capabilities and connectivity were not verified.")}` + (warnings.length ? '\n' + warnings.join('\n') : ''), warnings.length ? 'warning' : 'success'); break;
        }
        case 'apply': await this.apply(message.form); break;
        case 'restore': await this.restore(); break;
        case 'diagnose': await this.diagnose(); break;
        case 'manage': await this.v.commands.executeCommand(MANAGE); break;
        case 'openJson': await this.v.commands.executeCommand(OPEN_JSON); break;
        case 'reload': {
          const answer = await this.v.window.showWarningMessage(tr("重载会清除尚未写入的 API Key 和表单草稿。", "Reloading discards the pending API key and unsaved changes."), { modal: true }, tr("重载窗口", "Reload Window"));
          if (answer) { this.pendingKey = undefined; await this.v.commands.executeCommand('workbench.action.reloadWindow'); } break;
        }
      }
    } catch (e) {
      if (panel !== this.panel) return;
      const message = core.safeError(e, [this.pendingKey]);
      await this.notice(message, 'error');
      if (panel === this.panel) void this.v.window.showErrorMessage('BYOK：' + message);
    } finally {
      this.busy = false;
      const waiting = this.waitingPanel; this.waitingPanel = undefined;
      if (waiting && waiting !== panel && waiting === this.panel) await this.handle({type:'ready'});
      else if (panel === this.panel) await this.post({ type: 'busy', value: false });
    }
  }
  async switchGroup(dirty, panel) {
    const groups = parseGroups((await this.readConfig()).text).value.filter(isCustomGroup);
    if (panel !== this.panel) return;
    const currentName = this.displayedGroup;
    const items = groups.map(group => {
      const count = modelCount(group);
      return { label: group.name, description: `${count}${tr(' 个模型', count === 1 ? ' model' : ' models')}` +
        (group.name === currentName ? tr(' · 当前', ' · Current') : '') };
    });
    if (!items.length) {
      await this.notice(tr('当前 Profile 中没有可切换的 Custom Endpoint 模型组。', 'This profile has no Custom Endpoint groups to switch to.'));
      return;
    }
    const prompts = this.v.CancellationTokenSource ? new this.v.CancellationTokenSource() : undefined;
    const disposed = prompts && panel.onDidDispose(() => prompts.cancel());
    let picked;
    try {
      picked = await this.v.window.showQuickPick(items, { canPickMany: false,
        title: tr('切换模型组', 'Switch Model Group'), placeHolder: tr('输入名称搜索模型组', 'Type a group name to search') }, prompts?.token);
    } finally { disposed?.dispose(); prompts?.dispose(); }
    if (panel !== this.panel || !picked || picked.label === currentName) return;
    if (dirty || this.pendingKey) {
      const action = tr('切换', 'Switch');
      const answer = await this.v.window.showWarningMessage(tr('切换模型组并放弃未保存的更改？', 'Switch groups and discard unsaved changes?'), {
        modal: true, detail: tr('当前草稿和暂存的 API Key 将被替换，不会修改本机配置。', 'Switching replaces this draft and discards its pending API key. Local configuration will not change.')
      }, action);
      if (panel !== this.panel || answer !== action) return;
    }
    await this.refresh(picked.label, undefined, { explicitReload: true, expectedPanel: panel });
  }
  async setKey() {
    const panel = this.panel;
    await this.ensureCompatible(true);
    if (this.panel !== panel) return;
    const value = await this.v.window.showInputBox({
      title: tr("BYOK · 录入 API Key", "BYOK · Enter API Key"), password: true, ignoreFocusOut: true,
      prompt: tr("只在内存中暂存；点击“备份并写入”后交给 VS Code 原生密钥服务。不要输入 ${input:...} 引用。", "Held in memory until Save with Backup transfers it to VS Code secret storage. Do not enter a ${input:...} reference."),
      validateInput: value => !value.trim() ? tr("API Key 不能为空。", "API key cannot be empty.") : /[\r\n]/.test(value.trim()) ? tr("API Key 不能包含换行。", "API key cannot contain line breaks.") : value.trim().startsWith('${') ? tr("请填写真实密钥，不是变量引用。", "Enter the actual API key, not a variable reference.") : undefined
    });
    if (value === undefined || this.panel !== panel) return;
    this.pendingKey = value.trim(); await this.post({ type: 'key', pending: true });
    await this.notice(tr("API Key 已暂存于本窗口内存，尚未写入。关闭助手或切换模型组会清除。", "API key is held in memory and is not saved. Closing this editor or switching groups clears it."));
  }
  async importFile() {
    const uris = await this.v.window.showOpenDialog({ canSelectMany: false, filters: { 'JSON / JSONC': ['json', 'jsonc'] }, title: tr("导入 Custom Endpoint 配置（跳过密钥与请求头）", "Import Custom Endpoint configuration (excluding keys and headers)") });
    if (!uris?.length) return;
    const candidates = core.importCandidates(Buffer.from(await this.v.workspace.fs.readFile(uris[0])).toString('utf8'));
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const selected = await this.v.window.showQuickPick(candidates.map((g, i) => ({ label: String(g.name || tr("未命名", "Unnamed")), description: `${g.models.length}${tr(" 个模型", " models")}`, index: i })), { title: tr("选择要导入的模型组", "Select a model group to import") });
      if (!selected) return; chosen = candidates[selected.index];
    }
    this.template = chosen; this.baseline = undefined; this.pendingKey = undefined;
    await this.refresh(null, 'import');
    await this.notice(tr("已载入预设，尚未写入。导入已移除 API Key、密钥引用及全部 requestHeaders；同机同名组可在写入时复用已有 Key。", "Preset loaded, not saved. API keys, references and requestHeaders were removed. An existing key for the same group can be reused when saving."), 'warning');
  }
  async exportFile(form) {
    const { group } = core.buildGroup(form, this.template);
    const filename = group.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '.byok.json';
    const uri = await this.v.window.showSaveDialog({ defaultUri: this.v.Uri.file(path.join(require('node:os').homedir(), filename)), filters: { JSON: ['json'] }, title: tr("导出预设（不含密钥和请求头）", "Export preset (excluding keys and headers)") });
    if (!uri) return;
    await this.v.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(core.sanitizePreset(group), null, 2) + '\n', 'utf8'));
    await this.notice(tr("预设已导出。API Key、密钥引用与全部 requestHeaders 均未包含；其他自定义业务字段请在分享前自行检查。", "Preset exported without API keys, secret references or requestHeaders. Review other custom fields before sharing."), 'success');
  }
  async discoverModels(form, panel) {
    const assertAllowed = () => assertWorkspaceAllowed({ trusted: this.v.workspace.isTrusted,
      desktop: this.v.env.uiKind === this.v.UIKind.Desktop, aiDisabled: this.v.workspace.getConfiguration().get('chat.disableAIFeatures') === true });
    assertAllowed();
    if (!['chat-completions', 'responses'].includes(form?.apiType)) throw new Error(tr('模型发现仅支持 Chat Completions 和 Responses。', 'Model discovery supports Chat Completions and Responses only.'));
    if (typeof form.noAuth !== 'boolean') throw new Error(tr('请选择是否使用 API Key。', 'Choose whether to use an API key.'));
    const { root, ids } = discoveryDraft(form.modelsText);
    const discovery = this.discovery;
    const url = discovery.modelsUrl(form.defaultUrl);
    let key = form.noAuth ? undefined : this.pendingKey;
    const action = tr('发送请求', 'Send Request');
    const credential = form.noAuth ? tr('不发送 API Key 或 Authorization 请求头。', 'No API key or Authorization header will be sent.')
      : key !== undefined ? tr('将使用暂存的 API Key 发送 Authorization: Bearer 请求头。', 'The pending API key will be sent in an Authorization: Bearer header.')
      : tr('将通过密码框询问一次性 API Key，并通过 Authorization: Bearer 请求头发送。不会保存密钥或读取密钥库。', 'You will be prompted for a one-time API key to send in an Authorization: Bearer header. It will not be saved; stored keys are not read.');
    const controller = new AbortController();
    const prompts = this.v.CancellationTokenSource ? new this.v.CancellationTokenSource() : undefined;
    const disposed = panel.onDidDispose(() => { controller.abort(); prompts?.cancel(); });
    const current = () => this.panel === panel && !controller.signal.aborted;
    try {
      const confirm = await this.v.window.showWarningMessage(tr('从此地址发现模型？', 'Discover models at this address?'), {
        modal: true, detail: `GET ${url}\n\n${credential}`
      }, action);
      if (!current() || confirm !== action) return;
      if (!form.noAuth) {
        if (key === undefined) {
          key = await this.v.window.showInputBox({ title: tr('模型发现 · 一次性 API Key', 'Model discovery · One-time API key'),
            prompt: `GET ${url}`, password: true, ignoreFocusOut: true, validateInput: invalidDiscoveryKey }, prompts?.token);
          if (!current() || key === undefined) return;
        }
        const problem = invalidDiscoveryKey(key);
        if (problem) throw new Error(problem);
        key = key.trim();
      }
      assertAllowed();
      let models;
      try { models = await discovery.fetchModels(url, key, { signal: controller.signal }); }
      catch (error) {
        if (!current()) return;
        if (error instanceof modelDiscovery.DiscoveryError) throw new Error(core.safeError(error, [key]));
        throw new Error(tr('无法获取模型列表。请检查地址、认证方式和网络连接。草稿未更改。', 'Could not fetch the model list. Check the address, authentication and connection. The draft was not changed.'));
      }
      if (!current()) return;
      const choices = [], candidates = new Map();
      for (const model of models) {
        // Never present a server-reflected credential, even inside a valid ID or name.
        if (ids.has(model.id) || candidates.has(model.id) || (key && Object.values(model).some(v => typeof v === 'string' && v.includes(key)))) continue;
        candidates.set(model.id, model);
        choices.push({ label: model.id, description: model.name === model.id ? undefined : model.name });
      }
      if (!choices.length) { await this.notice(tr('未找到可追加的新模型。草稿未更改。', 'No new models to append. The draft was not changed.')); return; }
      const selection = await this.v.window.showQuickPick(choices, { canPickMany: true, title: tr('选择要追加到草稿的模型', 'Select models to append to the draft') }, prompts?.token);
      if (!current() || !selection?.length) return;
      assertAllowed();
      const selected = selection.map(item => candidates.get(item.label));
      if (root.value.length + selected.length > 300) throw new Error(tr('追加后将超过 300 个模型。请减少选择；草稿未更改。', 'The result would exceed 300 models. Select fewer models; the draft was not changed.'));
      const delivered = await this.post({ type: 'models', text: appendDraftModels(form.modelsText, root, selected) });
      if (delivered !== false && current()) await this.notice(tr('所选模型已追加到草稿，尚未保存。请根据供应商文档核对或补填 contextWindow 或 maxInputTokens、maxOutputTokens，以及 toolCalling 和 vision。未返回的参数不会被猜测。', 'Selected models were added to the draft, not saved. Check the provider documentation and fill in missing contextWindow or maxInputTokens, maxOutputTokens, toolCalling, and vision. Unreported values were not guessed.'));
    } finally { disposed.dispose(); prompts?.dispose(); }
  }
  async addModels(message) {
    const models = parseDocument(message.modelsText).value;
    if (!Array.isArray(models)) throw new Error(tr("请先修复模型数组。", "Fix the model array first."));
    const ids = String(message.ids || '').split(/[\n,，;；]+/).map(s => s.trim()).filter(Boolean);
    if (!ids.length) throw new Error(tr("请填写至少一个真实模型 ID。", "Enter at least one actual model ID."));
    const contextWindow = Number(message.contextWindow), maxOutputTokens = Number(message.maxOutputTokens);
    if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || contextWindow <= maxOutputTokens) throw new Error(tr("请填写合理的上下文和输出上限，且上下文必须大于输出。", "Enter valid context and output limits. Context must exceed output."));
    const seen = new Set(models.map(m => m.id)); let added = 0;
    for (const id of ids) if (!seen.has(id)) {
      models.push({ id, name: id, contextWindow, maxOutputTokens, toolCalling: message.toolCalling === true, vision: message.vision === true }); seen.add(id); added++;
    }
    await this.post({ type: 'models', text: JSON.stringify(models, null, 2) });
    await this.notice(`${tr("新增 ", "Added ")}${added}${tr(" 个模型，重复 ID 已跳过。上限和能力来自你的输入，并非自动检测。地址将在写入时用公共地址补全。", " models; duplicate IDs skipped. Limits and capabilities are user-supplied, not detected. Missing URLs use the default on save.")}`);
  }
  async backup(snapshot, settings, reason = 'apply') {
    const name = new Date().toISOString().replace(/[:.]/g, '-') + '_' + crypto.randomBytes(4).toString('hex');
    const folder = this.v.Uri.joinPath(this.context.globalStorageUri, 'backups', name);
    await this.v.workspace.fs.createDirectory(folder);
    const meta = { format: 1, created: new Date().toISOString(), reason, configUri: snapshot.uri.toString(),
      beforeHash: core.digest(snapshot.text), settingsBefore: settings, settingsApplied: [], status: 'prepared' };
    await this.v.workspace.fs.writeFile(this.v.Uri.joinPath(folder, 'config.jsonc'), Buffer.from(snapshot.text, 'utf8'));
    await this.v.workspace.fs.writeFile(this.v.Uri.joinPath(folder, 'meta.json'), Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
    if (folder.scheme === 'file' && process.platform !== 'win32') {
      await fs.chmod(folder.fsPath, 0o700);
      await fs.chmod(path.join(folder.fsPath, 'config.jsonc'), 0o600);
      await fs.chmod(path.join(folder.fsPath, 'meta.json'), 0o600);
    }
    return { folder, meta };
  }
  async saveMeta(backup) {
    await this.v.workspace.fs.writeFile(this.v.Uri.joinPath(backup.folder, 'meta.json'), Buffer.from(JSON.stringify(backup.meta, null, 2), 'utf8'));
  }
  lockPaths() {
    const storage = this.context.globalStorageUri;
    const parent = path.dirname(storage.fsPath);
    if (!['file', 'vscode-userdata'].includes(storage.scheme) || !path.isAbsolute(storage.fsPath) || path.basename(parent).toLowerCase() !== 'globalstorage') {
      throw new Error(tr('无法确认本机 Profile 的 globalStorage 目录，已停止写入。', 'Could not verify the local profile globalStorage directory. No write was attempted.'));
    }
    const name = 'write-' + core.digest(this.configUri.toString()).slice(0, 20) + '.lock';
    return { shared: path.join(parent, '.byok-' + name), legacy: path.join(storage.fsPath, name) };
  }
  async withLock(operation) {
    const { shared, legacy } = this.lockPaths();
    await this.v.workspace.fs.createDirectory(this.context.globalStorageUri);
    // Different editions share the outer lock; older releases only know the inner one.
    return this.withFileLock(shared, () => this.withFileLock(legacy, operation));
  }
  async withFileLock(lockPath, operation) {
    let handle;
    try { handle = await fs.open(lockPath, 'wx', 0o600); }
    catch (e) {
      if (e.code === 'EEXIST') throw new Error(tr('另一个窗口正在写入，或上次异常退出留下了锁。请确认所有窗口均未写入后，再删除此锁文件并重试：', 'Another window is writing, or a stale lock remains. Confirm no window is writing before removing this lock file and retrying: ') + lockPath);
      throw e;
    }
    try { await handle.writeFile(String(process.pid)); return await operation(); }
    finally {
      try { await handle.close(); } finally { await fs.unlink(lockPath); }
    }
  }
  async apply(form) {
    const env = await this.ensureCompatible(!!this.pendingKey);
    const { group, warnings } = core.buildGroup(form, this.template);
    if (form.stateless && !env.statelessSupported) warnings.push(tr("当前扩展未声明 statefulResponses，关闭状态续接可能不会生效；请更新后核验。", "The provider does not declare statefulResponses. Disabling stateful requests may have no effect; update and verify."));
    const snapshot = await this.readConfig();
    const existing = parseGroups(snapshot.text).value.find(g => g.vendor === group.vendor && g.name === group.name);
    if (this.baseline && group.name === this.baseline.name && !core.equal(existing, this.baseline.group)) throw new Error(tr("当前模型组已被修改，请先点击“重新读取”，避免覆盖新配置。", "This model group has changed. Reload first to avoid overwriting newer changes."));
    const key = form.noAuth ? undefined : this.pendingKey;
    const reuse = existing?.apiKey;
    if (!key && !form.noAuth && !core.isSecretRef(reuse)) throw new Error(tr("请先录入 API Key。本机同名组没有可复用的有效密钥引用。", "Enter an API key first. No reusable local secret reference exists for this group."));
    // Preserve existing non-model options on preset import. Explicit edits in the
    // imported template take precedence; other provider groups are never merged.
    const merged = { ...(existing ? core.publicGroup(existing) : {}), ...group };
    delete merged.url;
    const config = this.v.workspace.getConfiguration();
    const settings = [];
    const selectedModel = merged.models.find(m => m.id === form.auxiliaryModel);
    const fixedDefault = this.edition.preset?.models.find(m => m.id === this.edition.auxiliaryModel);
    const fixedCandidates = fixedDefault ? [...parseGroups(snapshot.text).value.filter(g => g.vendor === core.VENDOR && !g.name.startsWith(core.TEMP_PREFIX) && g.name !== group.name), merged]
      .flatMap(g => Array.isArray(g.models) ? g.models : []).filter(m => m?.id === fixedDefault.id) : [];
    for (const item of this.edition.settings) {
      const preset = form.applyRecommendedSettings === true;
      const legacy = item.formKey && form[item.formKey] === true;
      if (!preset && !legacy) continue;
      const inspected = config.inspect(item.key);
      if (!inspected) { warnings.push(`${tr("此版本未注册 ", "Setting not registered in this version: ")}${item.key}${tr("，已跳过。", "; skipped.")}`); continue; }
      let desired = item.value;
      if (item.model && Object.hasOwn(item, 'value')) {
        // Legacy fixed selectors match the resulting profile, including other provider groups of this vendor.
        if (!fixedCandidates.some(m => item.model === 'id' || m.name === fixedDefault.name)) {
          warnings.push(`${item.key}${tr('：未找到预设指定的辅助模型，已跳过。', ': preset auxiliary model not found; skipped.')}`); continue;
        }
      } else if (item.model) {
        if (!selectedModel) continue;
        desired = item.model === 'id' ? `customendpoint/${selectedModel.id}` : `${selectedModel.name} (customendpoint)`;
      }
      const previousValue = inspected.globalValue;
      if (core.equal(previousValue, desired)) continue;
      if (preset && previousValue !== undefined && form.overwriteRecommendedSettings !== true) {
        warnings.push(`${item.key}${tr(" 已有用户设置，已保留。", " already has a user setting; preserved.")}`); continue;
      }
      settings.push({ key: item.key, hadValue: previousValue !== undefined, previousValue, desired });
    }
    const destinations = [...new Set(group.models.map(m => m.url))];
    const detail = [
      `${tr("目标：", "Target: ")}${snapshot.uri.toString(true)}`,
      `${existing ? tr("更新已有", "Update existing ") : tr("新增", "Create ")}${tr("模型组：", "model group: ")}${group.name}（${group.models.length}${tr(" 个模型）", " models)")}`,
      existing ? tr("此次写入会替换该组的模型列表；其他模型组保持不变。", "This replaces the model list in this group only. Other groups are unchanged.") : '',
      `${tr("凭据：", "Credentials: ")}${form.noAuth ? tr("不设置 API Key（无认证接口）", "No API key (unauthenticated endpoint)") : key ? tr("保存新录入的 API Key", "Save the newly entered API key") : tr("复用本机同名组的密钥引用（尚未验证有效性）", "Reuse the local secret reference for this group (not verified)")}`,
      tr("模型请求将由 VS Code 发送到：\n", "VS Code will send model requests to:\n") + destinations.join('\n'),
      settings.length ? tr("用户设置：\n", "User settings:\n") + settings.map(s => `${s.hadValue ? tr("[覆盖已有值] ", "[Replace existing] ") : tr("[新增] ", "[Add] ")}${s.key} = ${JSON.stringify(s.desired)}`).join('\n') : '',
      warnings.length ? tr("注意：\n", "Notes:\n") + warnings.join('\n') : '',
      tr("本工具不会测试接口、登录 GitHub、修改 VS Code 源文件或自动批准 Agent 工具。", "This tool does not test endpoints, sign in to GitHub, modify VS Code source files, or auto-approve agent tools.")
    ].filter(Boolean).join('\n\n');
    const answer = await this.v.window.showWarningMessage(tr("确认备份并写入 BYOK 配置？", "Save BYOK configuration with backup?"), { modal: true, detail }, tr("备份并写入", "Save with Backup"));
    if (answer !== tr("备份并写入", "Save with Backup")) return;
    const backup = await this.withLock(async () => {
      const now = await this.readConfig();
      if (now.text !== snapshot.text) throw new Error(tr("确认期间配置已变化，请重新读取。", "Configuration changed during confirmation. Reload and retry."));
      const backup = await this.backup(now, settings);
      try {
        const result = await core.commitGroup({
          read: () => this.readConfig(), write: (expected, next) => this.writeConfig(expected, next),
          addGroup: payload => this.v.commands.executeCommand(ADD_GROUP, payload)
        }, merged, { apiKey: key, reuseReference: reuse, noAuth: form.noAuth === true });
        this.pendingKey = undefined;
        backup.meta.status = 'models-written'; backup.meta.afterHash = core.digest(result.text);
        for (const setting of settings) {
          try {
            const latest = this.v.workspace.getConfiguration().inspect(setting.key);
            if (!latest || !core.equal(latest.globalValue, setting.previousValue)) {
              warnings.push(`${setting.key}${tr(" 在确认后发生变化，已保留最新设置。", " changed during confirmation; latest value preserved.")}`); continue;
            }
            await this.v.workspace.getConfiguration().update(setting.key, setting.desired, this.v.ConfigurationTarget.Global);
            backup.meta.settingsApplied.push({ key: setting.key, value: setting.desired });
          } catch { warnings.push(`${setting.key}${tr(" 未能写入，可能受组织策略或设置权限限制。模型配置已保存。", " could not be written, possibly due to policy or permissions. Models were saved.")}`); }
        }
        backup.meta.status = 'complete';
        await this.saveMeta(backup).catch(() => warnings.push(tr("备份原文件已保存，但结果元数据更新失败。", "The original file was backed up, but updating backup metadata failed.")));
      } catch (error) {
        backup.meta.status = 'failed'; await this.saveMeta(backup).catch(() => {});
        throw new Error(core.safeError(error, [key]) + tr("\n备份：", "\nBackup: ") + backup.folder.toString(true));
      }
      return backup;
    });
    // Progress describes the disk write, independent of whether the panel is still open.
    await this.v.commands.executeCommand('setContext', 'byokManager.configurationSaved', true).then(undefined, () => {});
    await this.refresh(group.name).catch(() => warnings.push(tr('已保存，但管理器未能刷新，请重新读取。', 'Saved, but the editor could not refresh. Reload the group.')));
    await this.notice(`${tr("已保存 ", "Saved ")}${group.models.length}${tr(" 个模型，写入 ", " models and wrote ")}${backup.meta.settingsApplied.length}${tr(" 项用户设置。备份：", " user settings. Backup: ")}${backup.folder.toString(true)}${tr("\n请在 Chat 中选择该组的具体模型，不要选择 Auto。尚未验证实际对话。", "\nSelect a specific model from this group in Chat, not Auto. Chat has not been tested.")}` + (warnings.length ? '\n' + warnings.join('\n') : ''), warnings.length ? 'warning' : 'success');
  }
  async restore() {
    const current = await this.readConfig();
    const root = this.v.Uri.joinPath(this.context.globalStorageUri, 'backups');
    let entries;
    try { entries = await this.v.workspace.fs.readDirectory(root); } catch { throw new Error(tr("此 Profile 尚无工具备份。", "No backups exist for this profile.")); }
    const choices = [];
    for (const [name, type] of entries) if (type & this.v.FileType.Directory) {
      try {
        const folder = this.v.Uri.joinPath(root, name);
        const meta = JSON.parse(Buffer.from(await this.v.workspace.fs.readFile(this.v.Uri.joinPath(folder, 'meta.json'))).toString('utf8'));
        if (meta.format === 1 && meta.configUri === current.uri.toString()) choices.push({ label: meta.created, description: `${meta.reason} · ${meta.status}`, folder, meta });
      } catch { /* Ignore incomplete/unrelated backup folders. */ }
    }
    choices.sort((a, b) => b.label.localeCompare(a.label));
    if (!choices.length) throw new Error(tr("没有匹配当前 Profile 配置文件的备份。", "No backups match this profile's configuration file."));
    const choice = await this.v.window.showQuickPick(choices, { title: tr("选择要恢复的完整模型配置备份", "Select a full model configuration backup to restore") });
    if (!choice) return;
    const text = Buffer.from(await this.v.workspace.fs.readFile(this.v.Uri.joinPath(choice.folder, 'config.jsonc'))).toString('utf8');
    parseGroups(text);
    if (core.digest(text) !== choice.meta.beforeHash) throw new Error(tr("备份内容的 SHA-256 与记录不符，停止恢复。", "Backup SHA-256 does not match. Restore stopped."));
    const answer = await this.v.window.showWarningMessage(tr("恢复会替换当前 Profile 的整个模型配置文件，包含所有供应商。", "Restoring replaces the entire model configuration for this profile, including all providers."), {
      modal: true, detail: tr("恢复前还会备份当前配置。不会删除或还原密钥库；若原密钥已被 VS Code 删除，需要重新录入。仅恢复仍等于本工具写入值的相关用户设置，不覆盖你后来手动修改的设置。", "The current file will be backed up first. Secret storage is not restored or deleted; re-enter keys if VS Code removed them. Only settings still equal to the values written by this tool are restored.")
    }, tr("备份当前配置并恢复", "Back Up Current Configuration and Restore"));
    if (!answer) return;
    await this.withLock(async () => {
      const now = await this.readConfig();
      if (now.text !== current.text) throw new Error(tr("选择备份期间配置发生变化，请重试。", "Configuration changed while selecting a backup. Retry."));
      await this.backup(now, [], 'before-restore');
      await this.writeConfig(now.text, text);
      const warnings = []; const config = this.v.workspace.getConfiguration();
      for (const applied of choice.meta.settingsApplied || []) {
        if (!this.edition.settings.some(s => s.key === applied.key)) continue;
        const previous = (choice.meta.settingsBefore || []).find(s => s.key === applied.key);
        const inspected = config.inspect(applied.key);
        if (!previous || !inspected || !core.equal(inspected.globalValue, applied.value)) continue;
        try { await config.update(applied.key, previous.hadValue ? previous.previousValue : undefined, this.v.ConfigurationTarget.Global); }
        catch { warnings.push(`${applied.key}${tr(" 未能恢复，请手动检查。", " could not be restored; check manually.")}`); }
      }
      this.pendingKey = undefined; await this.refresh();
      const result = tr("模型配置备份已恢复。", "Model configuration restored.") + (warnings.length ? '\n' + warnings.join('\n') : '');
      if (this.panel) await this.notice(result, warnings.length ? 'warning' : 'success');
      else if (warnings.length) void this.v.window.showWarningMessage(result);
      else void this.v.window.showInformationMessage(result);
    });
  }
  async diagnose() {
    const env = await this.environment();
    const version = require('../package.json').version;
    let paths, lockStatus;
    try { await this.resolveConfig(); paths = this.lockPaths(); }
    catch (e) { lockStatus = core.safeError(e, [this.pendingKey]); }
    const lines = [`${this.edition.displayName} ${version} · ${tr("本机兼容性诊断", "Compatibility Diagnostics")}`, new Date().toISOString(), '',
      ...Object.entries(env).map(([k, v]) => `${k}: ${v}`), '',
      tr("当前配置：", "Current configuration: ") + (this.configUri?.toString(true) || tr("尚未定位", "Not located")),
      tr("本扩展存储目录：", "Extension storage directory: ") + this.context.globalStorageUri.toString(true),
      tr("Profile 共享锁：", "Shared profile lock: ") + (paths?.shared || lockStatus),
      tr("本扩展兼容锁：", "Legacy extension lock: ") + (paths?.legacy || lockStatus), '',
      tr("此诊断不包含 API Key，不发起网络请求，也不代表模型实际可调用。", "Diagnostics contain no API key, make no network requests, and do not verify model availability."),
      tr("密钥写入依赖内部命令 lm.addLanguageModelsProviderGroup；不是稳定的公开扩展 API。", "Secret entry uses the internal lm.addLanguageModelsProviderGroup command, not a stable public extension API."),
      tr("免 GitHub 登录取决于 VS Code、所选 Harness、BYOK 支持及组织策略。", "GitHub sign-in requirements depend on VS Code, the selected harness, BYOK support and organization policies."),
      tr("工具不会绕过登录验证、组织策略、订阅或授权。", "This tool does not bypass sign-in, organization policy, subscriptions or authorization.")];
    const doc = await this.v.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' });
    await this.v.window.showTextDocument(doc, { preview: true });
  }
}
function actionProvider(vscode) {
  const labels = isChinese() ? require('../package.nls.zh-cn.json') : require('../package.nls.json');
  const items = [['open', 'settings-gear'], ['openGuide', 'book'], ['diagnose', 'checklist'], ['restore', 'history']].map(([action, icon]) => {
    const label = labels['command.' + action];
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = 'byokManager.' + action;
    item.command = { command: item.id, title: label };
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  });
  return { getTreeItem: item => item, getChildren: parent => parent ? [] : items };
}
function activate(context, vscode = require('vscode'), edition = checkoutEdition) {
  const tool = new ByokTool(vscode, context, edition);
  const run = fn => async () => {
    if (tool.busy) { await vscode.window.showInformationMessage(tr("BYOK 助手正在处理当前操作，请勿重复执行。", "BYOK Manager is busy. Do not repeat the operation.")); return; }
    try { await fn(); } catch (e) { await vscode.window.showErrorMessage('BYOK：' + core.safeError(e, [tool.pendingKey])); }
  };
  const commands = new Map([
    ['byokManager.openGuide', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#userGuide`)],
    ['byokManager.open', run(() => tool.show())],
    ['byokManager.restore', run(() => tool.handle({ type: 'restore' }))],
    ['byokManager.diagnose', run(() => tool.diagnose())]
  ]);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('byokManager.actions', actionProvider(vscode)),
    ...[...commands].map(([id, handler]) => vscode.commands.registerCommand(id, handler)),
    ...Object.entries(edition.aliases).map(([id, target]) => {
      const handler = commands.get(target);
      if (!handler || commands.has(id)) throw new Error('Invalid edition command alias: ' + id);
      return vscode.commands.registerCommand(id, handler);
    }),
    { dispose: () => { tool.pendingKey = undefined; tool.panel?.dispose(); } }
  );
}
module.exports = { activate, ByokTool };
