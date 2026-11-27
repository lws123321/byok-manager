'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { activate, ByokTool } = require('../src/extension');
const pkg = require('../package.json');
const { parseDocument, parseGroups } = require('../src/jsonc');
const core = require('../src/core');

const OPEN = 'workbench.action.openLanguageModelsJson';
const ADD = 'lm.addLanguageModelsProviderGroup';
const HOST = 'chat.agentHost.byokModels.enabled';
const UTILITY = 'chat.byokUtilityModelDefault';
const RECOMMENDED = {
  'chat.requestQueuing.defaultAction': 'queue',
  'chat.planAgent.defaultModel': 'Test model (customendpoint)',
  'inlineChat.defaultModel': 'Test model (customendpoint)',
  'chat.utilityModel': 'customendpoint/example-model-for-tests',
  'chat.utilitySmallModel': 'customendpoint/example-model-for-tests',
  [UTILITY]: 'mainAgent', [HOST]: true
};
const sampleModel = () => ({ id: 'example-model-for-tests', name: 'Test model', url: 'https://gateway.example/v1', contextWindow: 8192, maxOutputTokens: 2048, toolCalling: true, vision: false });
const form = overrides => ({ name: 'custom', apiType: 'responses', defaultUrl: 'https://gateway.example/v1', modelsText: JSON.stringify([sampleModel()]), ...overrides });
class Uri {
  constructor(p) { this.fsPath = path.resolve(p); this.path = this.fsPath.replaceAll('\\', '/'); this.scheme = 'file'; }
  static file(p) { return new Uri(p); }
  static joinPath(uri, ...parts) { return new Uri(path.join(uri.fsPath, ...parts)); }
  toString() { return pathToFileURL(this.fsPath).href; }
}
async function harness(t, initial = '[]', edition) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-manager-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const uri = Uri.file(path.join(dir, 'profile-special', 'chatLanguageModels.json'));
  await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, initial);
  const state = { text: initial, dirty: false, posts: [], commands: [], dialogs: [], settings: new Map(), secrets: new Map(), cancel: false, failingSetting: null };
  const doc = { uri, get isDirty() { return state.dirty; }, getText: () => state.text, positionAt: x => x,
    async save() { await fs.writeFile(uri.fsPath, state.text); state.dirty = false; return true; } };
  const v = {
    version: 'test-host', UIKind: { Desktop: 1 }, env: { uiKind: 1, language: 'zh-cn' }, ConfigurationTarget: { Global: 1 }, FileType: { Directory: 2 }, Uri,
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    WorkspaceEdit: class { replace(target, range, text) { this.target = target; this.text = text; } },
    extensions: { all: [{ id: 'GitHub.copilot', packageJSON: { version: 'test', contributes: { languageModelChatProviders: [{ vendor: 'customendpoint', configuration: { properties: { apiKey: { secret: true }, models: { items: { properties: { statefulResponses: {} } } } } } }] } } }] },
    commands: {
      async getCommands() { return [OPEN, ADD, 'workbench.action.chat.manage']; },
      async executeCommand(name, payload, ...args) {
        state.commands.push({ name, payload, args });
        if (name === OPEN) { v.window.activeTextEditor = { document: doc }; return; }
        if (name === ADD) {
          const groups = parseGroups(state.text).value;
          const ref = '${input:chat.lm.secret.test-' + (state.secrets.size + 1) + '}';
          state.secrets.set(ref, payload.apiKey);
          groups.push({ ...payload, apiKey: ref });
          state.text = JSON.stringify(groups, null, 2); await fs.writeFile(uri.fsPath, state.text);
        }
      }
    },
    workspace: {
      isTrusted: true,
      getConfiguration() { return {
        get: key => state.settings.get(key),
        inspect: key => [...Object.keys(RECOMMENDED), 'chat.disableAIFeatures'].includes(key) && key !== state.unsupportedSetting ? { globalValue: state.settings.get(key) } : undefined,
        async update(key, value) { if (key === state.failingSetting) throw new Error('Policy denied'); if (value === undefined) state.settings.delete(key); else state.settings.set(key, value); }
      }; },
      async openTextDocument(input) { return input.content !== undefined ? { getText: () => input.content } : doc; },
      async applyEdit(edit) { assert.equal(edit.target.toString(), uri.toString()); state.text = edit.text; state.dirty = true; return true; },
      fs: {
        readFile: target => fs.readFile(target.fsPath), writeFile: (target, bytes) => fs.writeFile(target.fsPath, bytes),
        createDirectory: target => fs.mkdir(target.fsPath, { recursive: true }),
        async readDirectory(target) { return (await fs.readdir(target.fsPath, { withFileTypes: true })).map(d => [d.name, d.isDirectory() ? 2 : 1]); }
      }
    },
    window: {
      async showWarningMessage(message, options, action) { state.dialogs.push({ message, options, action }); if (state.beforeConfirm) await state.beforeConfirm(); return state.cancel ? undefined : action; },
      async showQuickPick(choices) { return state.pick ? state.pick(choices) : choices[0]; },
      async showInputBox(options) { state.inputOptions = options; return state.inputValue; },
      async showErrorMessage(message) { state.lastError = message; },
      async showTextDocument(document) { state.diagnostic = document.getText(); }
    }
  };
  const context = { globalStorageUri: Uri.file(path.join(dir, 'globalStorage', `${pkg.publisher}.${pkg.name}`)), extensionUri: Uri.file(path.resolve('.')), extensionPath: path.resolve('.'), subscriptions: [] };
  const tool = new ByokTool(v, context, edition);
  tool.panel = { webview: { async postMessage(m) { state.posts.push(m); return true; } }, reveal() {} };
  async function backups() {
    const root = path.join(context.globalStorageUri.fsPath, 'backups');
    const names = await fs.readdir(root).catch(() => []);
    return Promise.all(names.map(async name => ({ name, text: await fs.readFile(path.join(root, name, 'config.jsonc'), 'utf8'), meta: JSON.parse(await fs.readFile(path.join(root, name, 'meta.json'), 'utf8')), folder: path.join(root, name) })));
  }
  async function external(text) { state.text = text; await fs.writeFile(uri.fsPath, text); }
  return { tool, v, state, dir, uri, backups, external };
}

function activateSidebar(h, language, edition, activateExtension = activate) {
  const { v, state } = h;
  const commands = new Map(), views = new Map(), panels = [];
  v.env.language = language;
  v.commands.registerCommand = (id, action) => { commands.set(id, action); return { dispose: () => commands.delete(id) }; };
  v.window.registerTreeDataProvider = (id, provider) => { views.set(id, provider); return { dispose: () => views.delete(id) }; };
  v.TreeItem = class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } };
  v.TreeItemCollapsibleState = { None: 0 }; v.ThemeIcon = class { constructor(id) { this.id = id; } };
  v.ViewColumn = { One: 1 };
  v.window.showInformationMessage = message => { state.lastInfo = message; };
  v.window.createWebviewPanel = (id, title) => {
    let onDispose;
    const panel = { id, title, webview: { ...h.tool.panel.webview, asWebviewUri: u => u, cspSource: 'test', onDidReceiveMessage: () => ({ dispose() {} }) },
      reveals: 0, reveal() { this.reveals++; }, onDidDispose(fn) { onDispose = fn; return { dispose() {} }; },
      dispose() { this.disposed = true; onDispose(); } };
    panels.push(panel); return panel;
  };
  const context = h.tool.context;
  context.extension = { id: 'marketplace-test.byok-manager' };
  activateExtension(context, v, edition);
  return { commands, views, panels, dispose: () => context.subscriptions.forEach(s => s.dispose()) };
}
for (const language of ['en', 'zh-cn']) test(`sidebar (${language}): native actions reuse commands and the live panel`, async t => {
  const h = await harness(t); const sidebar = activateSidebar(h, language);
  const [container] = pkg.contributes.viewsContainers.activitybar;
  const provider = sidebar.views.get(pkg.contributes.views[container.id][0].id);
  const roots = await provider.getChildren();
  const items = await Promise.all(roots.map(root => provider.getTreeItem(root)));
  const ids = ['byokManager.open', 'byokManager.diagnose', 'byokManager.restore', 'byokManager.openGuide'];
  const locale = language === 'en' ? require('../package.nls.json') : require('../package.nls.zh-cn.json');
  assert.deepEqual(items.map(item => item.command.command).sort(), ids.slice().sort());
  for (const [index, item] of items.entries()) {
    assert.equal(item.label, locale['command.' + item.command.command.split('.')[1]]);
    assert.deepEqual(await provider.getChildren(roots[index]), []);
  }
  assert.equal(sidebar.panels.length, 0); assert.equal(h.state.commands.length, 0);
  await sidebar.commands.get('byokManager.openGuide')();
  assert.equal(sidebar.panels.length, 0); assert.equal(h.state.dialogs.length, 0);
  assert.deepEqual(h.state.commands.map(c => [c.name, c.payload]), [['workbench.action.openWalkthrough', 'marketplace-test.byok-manager#userGuide']]);
  const open = sidebar.commands.get(ids[0]); await Promise.all([open(), open()]);
  assert.equal(sidebar.panels.length, 1); assert.equal(sidebar.panels[0].reveals, 1);
  assert.match(sidebar.panels[0].webview.html, language === 'en' ? /lang="en"/ : /lang="zh-CN"/);
  sidebar.panels[0].dispose(); await open(); assert.equal(sidebar.panels.length, 2);
  await sidebar.commands.get(ids[1])(); assert.ok(h.state.diagnostic.includes(pkg.version));
  sidebar.dispose(); assert.ok(sidebar.panels[1].disposed); assert.equal(sidebar.views.size, 0); assert.equal(sidebar.commands.size, 0);
});
test('sidebar: restore posts busy state and reports success when no panel exists', async t => {
  const h = await harness(t); await h.tool.apply(form({ noAuth: true }));
  const sidebar = activateSidebar(h, 'en'); const restore = sidebar.commands.get('byokManager.restore');
  await restore(); assert.equal(sidebar.panels.length, 0); assert.match(h.state.lastInfo, /restored/i);
  await sidebar.commands.get('byokManager.open')(); h.state.posts.length = 0;
  h.state.cancel = true; h.state.beforeConfirm = () => assert.equal(h.state.posts.findLast(p => p.type === 'busy')?.value, true);
  await restore(); assert.equal(h.state.lastError, undefined);
  assert.deepEqual(h.state.posts.filter(p => p.type === 'busy').map(p => p.value), [true, false]);
  sidebar.dispose();
});
test('host: current Profile resolved through native command, not guessed paths', async t => {
  const h = await harness(t); const result = await h.tool.readConfig();
  assert.equal(result.uri.toString(), h.uri.toString()); assert.equal(h.state.commands[0].name, OPEN);
});
test('host: new key native save, profile write, durable backup, no plaintext in files or UI', async t => {
  const initial = '[\n // preserve-other-provider\n {"name":"other","vendor":"custom","x":1}\n]';
  const h = await harness(t, initial); h.tool.pendingKey = 'test-private-key-12345';
  await h.tool.apply(form());
  const result = parseGroups(h.state.text).value;
  assert.equal(result.length, 2); assert.match(h.state.text, /preserve-other-provider/);
  assert.equal(result[0].name, 'other'); assert.equal(h.state.secrets.get(result[1].apiKey), 'test-private-key-12345');
  assert.equal(h.tool.pendingKey, undefined); assert.equal(h.state.commands.filter(c => c.name === ADD).length, 1);
  const backups = await h.backups(); assert.equal(backups.length, 1); assert.equal(backups[0].text, initial); assert.equal(backups[0].meta.status, 'complete');
  const combined = h.state.text + JSON.stringify(backups) + JSON.stringify(h.state.posts) + JSON.stringify(h.state.dialogs);
  assert.equal(combined.includes('test-private-key-12345'), false);
});
test('walkthrough: only a confirmed, successful configuration write signals completion', async t => {
  const h = await harness(t);
  const signals = () => h.state.commands.filter(c => c.name === 'setContext');
  h.state.inputValue = 'local-test-key'; await h.tool.setKey();
  await h.tool.handle({ type: 'validate', form: form() });
  h.state.cancel = true; await h.tool.apply(form());
  assert.deepEqual(signals(), []);
  h.state.cancel = false; h.v.workspace.applyEdit = async () => false;
  await assert.rejects(h.tool.apply(form({ noAuth: true })));
  assert.deepEqual(signals(), []);
  const success = await harness(t); success.tool.pendingKey = 'local-test-key';
  await success.tool.apply(form());
  assert.deepEqual(success.state.commands.filter(c => c.name === 'setContext'), [
    { name: 'setContext', payload: 'byokManager.configurationSaved', args: [true] }
  ]);
});
test('walkthrough: a panel refresh failure does not undo a committed backup or progress', async t => {
  const h = await harness(t);
  h.tool.refresh = async () => { throw new Error('Panel closed'); };
  await h.tool.apply(form({ noAuth: true }));
  assert.equal((await h.backups())[0].meta.status, 'complete');
  assert.equal(h.state.commands.filter(c => c.name === 'setContext').length, 1);
  assert.equal(h.state.posts.at(-1).kind, 'warning');
});
test('host: repeated update reuses secret and preserves one provider group', async t => {
  const h = await harness(t); h.tool.pendingKey = 'test-private-key'; await h.tool.apply(form());
  const first = parseGroups(h.state.text).value[0].apiKey;
  await h.tool.apply(form({ modelsText: JSON.stringify([{ ...sampleModel(), name: 'Changed name' }]) }));
  assert.equal(parseGroups(h.state.text).value.length, 1); assert.equal(parseGroups(h.state.text).value[0].apiKey, first);
  assert.equal(h.state.commands.filter(c => c.name === ADD).length, 1); assert.equal((await h.backups()).length, 2);
});
test('host: restore full original document and only tool-changed settings', async t => {
  const initial = '[ // initial\n]'; const h = await harness(t, initial); h.tool.pendingKey = 'test-private-key';
  h.state.settings.set(UTILITY, 'copilot'); await h.tool.apply(form({ enableAgentHost: true, utilityMain: true }));
  assert.equal(h.state.settings.get(HOST), true); assert.equal(h.state.settings.get(UTILITY), 'mainAgent');
  await h.tool.restore(); assert.equal(h.state.text, initial);
  assert.equal(h.state.settings.has(HOST), false); assert.equal(h.state.settings.get(UTILITY), 'copilot');
  assert.equal((await h.backups()).length, 2); assert.equal(h.state.secrets.size, 1);
});
test('host: restore preserves a user setting changed later', async t => {
  const h = await harness(t); h.tool.pendingKey = 'key'; await h.tool.apply(form({ utilityMain: true }));
  h.state.settings.set(UTILITY, 'later-user-choice'); await h.tool.restore();
  assert.equal(h.state.settings.get(UTILITY), 'later-user-choice');
});
test('host: tampered backup hash blocks restore without writes', async t => {
  const h = await harness(t); h.tool.pendingKey = 'key'; await h.tool.apply(form());
  const before = h.state.text; const [backup] = await h.backups();
  await fs.writeFile(path.join(backup.folder, 'config.jsonc'), '[\n]');
  await assert.rejects(h.tool.restore(), /SHA-256/); assert.equal(h.state.text, before);
});
test('host: absent native API or secret schema fails closed before saving', async t => {
  const h = await harness(t); h.tool.pendingKey = 'key';
  h.v.extensions.all = []; await assert.rejects(h.tool.apply(form()), /Custom Endpoint/);
  assert.equal(h.state.text, '[]'); assert.equal((await h.backups()).length, 0);
});
test('host: disabled AI, web host, and untrusted workspace each block writes', async t => {
  const h = await harness(t); h.state.settings.set('chat.disableAIFeatures', true);
  await assert.rejects(h.tool.ensureCompatible(), /关闭了 AI/); h.state.settings.clear();
  h.v.env.uiKind = 2; await assert.rejects(h.tool.ensureCompatible(), /桌面版/); h.v.env.uiKind = 1;
  h.v.workspace.isTrusted = false; await assert.rejects(h.tool.ensureCompatible(), /可信/);
});
test('host: no-key authenticated write rejected without touching disk', async t => {
  const h = await harness(t); await assert.rejects(h.tool.apply(form()), /录入 API Key/);
  assert.equal(h.state.text, '[]'); assert.equal((await h.backups()).length, 0);
});
test('host: explicit no-auth writes without secret command', async t => {
  const h = await harness(t); await h.tool.apply(form({ noAuth: true }));
  assert.equal(parseGroups(h.state.text).value[0].apiKey, undefined); assert.equal(h.state.secrets.size, 0);
});
test('host: cancel confirmation does not modify model file, settings, vault or backups', async t => {
  const h = await harness(t); h.tool.pendingKey = 'key'; h.state.cancel = true;
  await h.tool.apply(form({ enableAgentHost: true })); assert.equal(h.state.text, '[]');
  assert.equal(h.state.settings.size, 0); assert.equal(h.state.secrets.size, 0); assert.equal((await h.backups()).length, 0);
});
test('host: dirty buffer and disk-buffer divergence reject writes', async t => {
  const h = await harness(t); h.state.dirty = true; await assert.rejects(h.tool.readConfig(), /未保存/);
  h.state.dirty = false; await fs.writeFile(h.uri.fsPath, '[\n]'); await assert.rejects(h.tool.readConfig(), /不同步/);
});
test('host: baseline conflict prevents overwriting another window edits', async t => {
  const h = await harness(t); h.tool.pendingKey = 'key'; await h.tool.apply(form());
  const groups = parseGroups(h.state.text).value; groups[0].models[0].name = 'External edit';
  await h.external(JSON.stringify(groups)); const changed = h.state.text;
  await assert.rejects(h.tool.apply(form()), /已被修改/); assert.equal(h.state.text, changed);
});
test('host: confirmation-time conflict aborts before backup or secret write', async t => {
  const h = await harness(t); h.tool.pendingKey = 'key'; h.state.beforeConfirm = () => h.external('[\n]');
  await assert.rejects(h.tool.apply(form()), /确认期间/); assert.equal(h.state.secrets.size, 0); assert.equal((await h.backups()).length, 0);
});
test('host: failed optional setting keeps models and reports partial success', async t => {
  const h = await harness(t); h.tool.pendingKey = 'key'; h.state.failingSetting = HOST;
  await h.tool.apply(form({ enableAgentHost: true }));
  assert.equal(parseGroups(h.state.text).value.length, 1);
  assert.ok(h.state.posts.some(p => p.type === 'notice' && p.kind === 'warning' && p.text.includes('未能写入')));
});
test('host: same-tool concurrent lock is not overridden', async t => {
  const h = await harness(t); await h.tool.readConfig();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = h.tool.withLock(async () => { await assert.rejects(h.tool.withLock(async () => {}), /另一个窗口/); release(); });
  await Promise.all([first, gate]); await h.tool.withLock(async () => {});
});
function expectedLocks(tool) {
  const name = 'write-' + core.digest(tool.configUri.toString()).slice(0, 20) + '.lock';
  const storage = tool.context.globalStorageUri.fsPath;
  return { shared: path.join(path.dirname(storage), '.byok-' + name), legacy: path.join(storage, name) };
}
for (const holder of ['public', 'enterprise']) test(`profile lock: ${holder} excludes the other edition from applying and restoring`, async t => {
  const h = await harness(t);
  const edition = sampleEdition();
  const enterprise = new ByokTool(h.v, { ...h.tool.context,
    globalStorageUri: Uri.file(path.join(h.dir, 'globalStorage', `${edition.publisher}.${edition.name}`)) }, edition);
  const [owner, other] = holder === 'public' ? [h.tool, enterprise] : [enterprise, h.tool];
  await other.apply(form({ noAuth: true })); // Give the contender a real backup to restore.
  await owner.readConfig();
  const before = h.state.text, root = path.join(other.context.globalStorageUri.fsPath, 'backups');
  const backups = await fs.readdir(root);
  await owner.withLock(async () => {
    await assert.rejects(other.apply(form({ noAuth: true, name: 'second' })), /另一个窗口/);
    await assert.rejects(other.restore(), /另一个窗口/);
    assert.equal(h.state.text, before); assert.deepEqual(await fs.readdir(root), backups);
    for (const file of Object.values(expectedLocks(owner))) assert.equal(await fs.readFile(file, 'utf8'), String(process.pid));
    await assert.rejects(fs.stat(expectedLocks(other).legacy), { code: 'ENOENT' });
  });
  other.panel = h.tool.panel;
  await other.restore(); assert.equal(h.state.text, '[]');
});
test('profile lock: old writer blocks new writer without losing the old lock or leaking the shared lock', async t => {
  const h = await harness(t); await h.tool.readConfig();
  const { shared, legacy } = expectedLocks(h.tool);
  await h.v.workspace.fs.createDirectory(h.tool.context.globalStorageUri);
  await fs.writeFile(legacy, '123');
  await assert.rejects(h.tool.withLock(() => assert.fail()), e => e.message.includes(legacy));
  assert.equal(await fs.readFile(legacy, 'utf8'), '123');
  await assert.rejects(fs.stat(shared), { code: 'ENOENT' });
  await fs.unlink(legacy);
  await assert.rejects(h.tool.withLock(async () => {
    await assert.rejects(fs.open(legacy, 'wx', 0o600), { code: 'EEXIST' });
    throw Error('operation failed');
  }), /operation failed/);
  for (const file of [legacy, shared]) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
for (const language of ['en', 'zh-cn']) test(`profile lock: stale shared lock is preserved and paths are diagnosed (${language})`, async t => {
  const h = await harness(t); h.v.env.language = language;
  const tool = new ByokTool(h.v, h.tool.context); await tool.readConfig();
  const { legacy, shared } = expectedLocks(tool);
  await fs.mkdir(path.dirname(shared), { recursive: true }); await fs.writeFile(shared, '0');
  await assert.rejects(tool.apply(form({ noAuth: true })), e => e.message.includes(shared) && (language === 'en' ? /stale/i : /锁/).test(e.message));
  assert.equal(await fs.readFile(shared, 'utf8'), '0');
  await assert.rejects(fs.stat(legacy), { code: 'ENOENT' });
  await new ByokTool(h.v, h.tool.context).diagnose(); // Also works as a standalone command after restart.
  assert.ok(h.state.diagnostic.includes(shared)); assert.ok(h.state.diagnostic.includes(legacy));
  assert.match(h.state.diagnostic, language === 'en' ? /shared profile lock/i : /共享锁/);
  assert.equal(h.state.text, '[]'); assert.deepEqual(await h.backups(), []);
});
test('profile lock: a writer does not block another profile using the same storage root', async t => {
  const a = await harness(t), b = await harness(t);
  b.tool.context.globalStorageUri = a.tool.context.globalStorageUri;
  await a.tool.readConfig();
  await a.tool.withLock(() => b.tool.apply(form({ noAuth: true })));
  assert.equal(a.state.text, '[]'); assert.equal(parseGroups(b.state.text).value.length, 1);
});
test('profile lock: unexpected storage parent fails closed before touching it', async t => {
  const h = await harness(t); h.tool.context.globalStorageUri = Uri.file(path.join(h.dir, 'unexpected', 'edition'));
  await assert.rejects(h.tool.apply(form({ noAuth: true })), /globalStorage/);
  await assert.rejects(fs.stat(path.join(h.dir, 'unexpected')), { code: 'ENOENT' });
});
test('host: key input is native masked, not passed to webview; diagnostics omit it', async t => {
  const h = await harness(t); h.state.inputValue = 'test-sensitive-value'; await h.tool.setKey();
  assert.equal(h.state.inputOptions.password, true); assert.equal(h.tool.pendingKey, h.state.inputValue);
  assert.equal(JSON.stringify(h.state.posts).includes(h.state.inputValue), false);
  await h.tool.diagnose(); assert.equal(h.state.diagnostic.includes(h.state.inputValue), false);
});
test('host: mutation handler always releases busy flag and masks pending key errors', async t => {
  const h = await harness(t); h.tool.pendingKey = 'private-error-key';
  h.tool.apply = async () => { throw new Error('failure private-error-key'); };
  await h.tool.handle({ type: 'apply', form: form() }); assert.equal(h.tool.busy, false);
  assert.equal(h.state.lastError.includes('private-error-key'), false);
  assert.deepEqual(h.state.posts.at(-1), { type: 'busy', value: false });
});

const destination = 'https://gateway.example/v1/models';
test('discovery: real loopback catalogue through the host picker to an unsaved draft', async t => {
  const h = await harness(t);
  const calls = [];
  const server = require('node:http').createServer((req, res) => {
    calls.push([req.method, req.url, req.headers.authorization]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'existing' }, { id: 'picked' }, { id: 'skipped' }] }));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/tenant/v1`;
  h.tool.panel.onDidDispose = () => ({ dispose() {} });
  h.state.inputValue = 'loopback-only';
  h.state.pick = rows => rows.filter(row => row.label === 'picked');
  await h.tool.handle({type: 'discoverModels', form: { apiType:'chat-completions', defaultUrl:url, noAuth:false, modelsText:'[{"id":"existing","custom":1}]' }});
  assert.deepEqual(calls, [['GET', '/tenant/v1/models', 'Bearer loopback-only']]);
  const change = h.state.posts.find(m => m.type === 'models');
  assert.ok(change); const draft = parseDocument(change.text).value;
  assert.deepEqual(draft.map(m => m.id), ['existing','picked']);
  assert.equal(draft[0].custom, 1); assert.equal(draft[1].maxOutputTokens, undefined);
  assert.ok(!JSON.stringify(h.state.posts).includes('loopback-only'));
  assert.equal(h.tool.pendingKey, undefined); assert.equal(h.state.text, '[]'); assert.deepEqual(await h.backups(), []);
});

test('a replacement panel receives its ready state, not the previous panel’s input or results', async t => {
  const h = await harness(t);
  const nextPosts = [];
  h.v.window.showInputBox = async () => {
    h.tool.panel = {webview:{postMessage: async m => { nextPosts.push(m); return true; }}, reveal() {}};
    await h.tool.handle({type:'ready'});
    return 'already-closed-panel';
  };
  await h.tool.handle({type:'setKey'});
  assert.equal(h.tool.pendingKey, undefined);
  assert.equal(nextPosts.some(m => m.type === 'state'), true);
  assert.equal(nextPosts.some(m => m.type === 'key'), false);
  assert.equal(nextPosts.at(-1).value, false);
});

const fixtureKey = 'discovery-test-only-credential';
async function discoveryHarness(t) {
  const h = await harness(t); const { state, v, tool } = h;
  const calls = []; const events = []; const picks = [];
  const disposeListeners = new Set();
  tool.panel.onDidDispose = fn => { disposeListeners.add(fn); return { dispose: () => disposeListeners.delete(fn) }; };
  const dispose = () => { for (const fn of disposeListeners) fn(); tool.panel = undefined; };
  const transport = {
    modelsUrl(value) { assert.equal(value, 'https://gateway.example/v1/'); return destination; },
    async fetchModels(url, key, { signal }) {
      calls.push({ url, key, signal }); events.push('request');
      return [{ id: 'existing' }, { id: 'fresh' }, { id: 'fresh', name: 'duplicate' }, { id: 'other' }];
    }
  };
  tool.discovery = transport;
  state.beforeConfirm = () => events.push('confirm');
  v.window.showQuickPick = async (items, options) => {
    picks.push({ items, options }); events.push('pick');
    return state.pick ? state.pick(items) : items.filter(i => i.label === 'fresh');
  };
  const run = overrides => tool.handle({ type: 'discoverModels', form: { defaultUrl: 'https://gateway.example/v1/',
    modelsText: '[]', apiType: 'responses', noAuth: false, ...overrides } });
  const models = () => state.posts.find(m => m.type === 'models');
  return { ...h, run, models, events, calls, picks, dispose, transport };
}

test('discovery: confirms exact destination and pending bearer before GET; appends only selected unique IDs to the JSONC draft', async t => {
  const h = await discoveryHarness(t); h.tool.pendingKey = fixtureKey;
  const existing = '{ "id" : "existing", "manual": 42 }';
  await h.run({ modelsText: '[ // my draft\r\n' + existing + ', /* keep */\r\n] // footer' });
  assert.deepEqual(h.events, ['confirm', 'request', 'pick']);
  assert.equal(h.state.dialogs[0].options.modal, true); assert.ok(h.state.dialogs[0].options.detail.includes(destination));
  assert.match(h.state.dialogs[0].options.detail, /Bearer/i);
  assert.equal(h.calls[0].url, destination); assert.equal(h.calls[0].key, fixtureKey); assert.equal(h.calls[0].signal.aborted, false);
  assert.equal(h.picks[0].options.canPickMany, true); assert.deepEqual(h.picks[0].items.map(i => i.label), ['fresh', 'other']);
  const text = h.models().text; assert.ok(text.includes(existing) && text.includes('// my draft') && text.includes('/* keep */') && text.endsWith('// footer'));
  assert.deepEqual(parseDocument(text).value, [{ id: 'existing', manual: 42 }, { id: 'fresh' }]);
  assert.match(h.state.posts.findLast(p => p.type === 'notice').text, /maxOutputTokens/);
  assert.equal(h.tool.pendingKey, fixtureKey); assert.equal(h.state.inputOptions, undefined);
  assert.deepEqual(h.state.commands, []); assert.equal(h.state.text, '[]'); assert.deepEqual(await h.backups(), []);
  assert.equal(h.state.secrets.size, 0); assert.equal(h.state.settings.size, 0);
  assert.ok(!JSON.stringify([h.state.posts, h.state.dialogs, h.picks]).includes(fixtureKey));
});

test('discovery: explicit no-auth ignores pending key; one-shot input is masked, never saved or echoed on transport failure', async t => {
  const h = await discoveryHarness(t); h.tool.pendingKey = fixtureKey;
  await h.run({ noAuth: true, apiType: 'chat-completions' });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].key, undefined); assert.equal(h.state.inputOptions, undefined);
  assert.match(h.state.dialogs[0].options.detail, /不发送|不使用|without|no authorization/i); assert.equal(h.tool.pendingKey, fixtureKey);
  h.tool.pendingKey = undefined; h.state.inputValue = fixtureKey; h.state.posts = [];
  let received; h.transport.fetchModels = async (_, key) => { received = key; throw new Error('raw response body: ' + key); };
  await h.run(); assert.equal(received, fixtureKey); assert.equal(h.state.inputOptions.password, true);
  assert.ok(h.state.lastError); assert.doesNotMatch(JSON.stringify([h.state.posts, h.state.lastError, h.state.dialogs]), /discovery-test-only-credential|raw response body/);
  assert.equal(h.tool.pendingKey, undefined); assert.equal(h.models(), undefined); assert.equal(h.tool.busy, false);
});

test('discovery: reports sanitized provider errors without exposing the raw response', async t => {
  const h = await discoveryHarness(t); const { DiscoveryError } = require('../src/discovery');
  h.tool.pendingKey = fixtureKey;
  h.transport.fetchModels = async () => { throw new DiscoveryError(401); };
  await h.run(); assert.match(h.state.lastError, /401/); assert.equal(h.models(), undefined);
});

test('discovery: reflected credentials in model strings are not offered or posted', async t => {
  const h = await discoveryHarness(t); h.state.inputValue = fixtureKey;
  h.transport.fetchModels = async () => [{ id: 'prefix-' + fixtureKey }, { id: 'id', name: fixtureKey }, { id: 'fresh' }];
  await h.run(); assert.deepEqual(h.picks[0].items.map(i => i.label), ['fresh']);
  assert.ok(!JSON.stringify([h.picks, h.state.posts, h.state.dialogs]).includes(fixtureKey));
});

test('discovery: cancelled confirmation, key prompt and selection never apply a draft', async t => {
  const h = await discoveryHarness(t); h.state.cancel = true;
  await h.run(); assert.deepEqual(h.events, ['confirm']); assert.equal(h.state.inputOptions, undefined);
  h.state.cancel = false; await h.run(); assert.equal(h.state.inputOptions.password, true); assert.equal(h.calls.length, 0);
  h.state.pick = () => undefined; await h.run({ noAuth: true }); assert.equal(h.picks.length, 1); assert.equal(h.models(), undefined);
});

test('discovery: rejects invalid draft, protocol, full list, and missing permissions before confirmation', async t => {
  const h = await discoveryHarness(t);
  for (const opts of [{ apiType: 'messages' }, { modelsText: '{}' }, { modelsText: '[bad' }, { modelsText: '[{"id":" a"},{"id":"a"}]' },
    { modelsText: JSON.stringify(Array.from({ length: 300 }, (_, n) => ({ id: String(n) }))) }]) {
    h.state.lastError = undefined; await h.run(opts); assert.ok(h.state.lastError);
  }
  h.v.workspace.isTrusted = false; h.state.lastError = undefined; await h.run(); assert.ok(h.state.lastError); h.v.workspace.isTrusted = true;
  h.v.env.uiKind = 2; h.state.lastError = undefined; await h.run(); assert.ok(h.state.lastError); h.v.env.uiKind = 1;
  h.state.settings.set('chat.disableAIFeatures', true); h.state.lastError = undefined; await h.run(); assert.ok(h.state.lastError);
  assert.deepEqual(h.events, []);
});

test('discovery: rejects references and raw line breaks in pending and one-shot credentials', async t => {
  const h = await discoveryHarness(t);
  for (const key of ['${input:chat.lm.secret.fixture}', 'test-key\n', '\rtest-key']) {
    for (const pending of [true, false]) {
      h.tool.pendingKey = pending ? key : undefined; h.state.inputValue = pending ? undefined : key;
      h.state.lastError = undefined; await h.run(); assert.ok(h.state.lastError); assert.equal(h.tool.pendingKey, pending ? key : undefined);
    }
  }
  assert.equal(h.calls.length, 0); assert.equal(h.models(), undefined);
});

test('discovery: rejects selection exceeding 300 rather than partially appending', async t => {
  const h = await discoveryHarness(t); h.state.pick = items => items;
  await h.run({ noAuth: true, modelsText: JSON.stringify(Array.from({ length: 299 }, (_, n) => ({ id: String(n) }))) });
  assert.equal(h.picks.length, 1); assert.match(h.state.lastError, /300/); assert.equal(h.models(), undefined);
});

test('discovery: duplicate clicks ignored; disposing during confirmation, input, request, or picker prevents stale results', async t => {
  for (const stage of ['confirmation', 'input', 'request', 'picker']) {
    const h = await discoveryHarness(t); let signal, requests = 0;
    h.state.beforeConfirm = async () => { await h.run(); if (stage === 'confirmation') h.dispose(); };
    h.v.window.showInputBox = async () => { if (stage === 'input') h.dispose(); return fixtureKey; };
    h.transport.fetchModels = async (_, __, options) => { signal = options.signal; requests++; if (stage === 'request') h.dispose(); return [{ id: 'fresh' }]; };
    h.state.pick = items => { if (stage === 'picker') h.dispose(); return items; };
    await h.run(); assert.equal(h.state.dialogs.length, 1); assert.equal(requests, ['request', 'picker'].includes(stage) ? 1 : 0);
    if (requests) assert.equal(signal.aborted, true);
    assert.equal(h.models(), undefined); assert.equal(h.state.lastError, undefined); assert.equal(h.tool.busy, false);
  }
});

const preset = {name:'custom',vendor:'customendpoint',apiType:'chat-completions',models:[{...sampleModel(),id:'first-model',name:'First model'}]};
const lastDraft = h => h.state.posts.filter(p => p.type === 'state').at(-1).draft;

const switchTarget = { ...preset, name: 'Second Group', models: [], apiKey: '${input:chat.lm.secret.picker-fixture}', requestHeaders: { Authorization: 'private-header' } };
async function switchHarness(t, edition) {
  const h = await harness(t, JSON.stringify([preset]), edition);
  h.tool.panel.active = true;
  await h.tool.refresh();
  await h.external(JSON.stringify([preset, switchTarget, { ...preset, vendor: 'unrelated' }, { ...preset, name: core.TEMP_PREFIX + 'hidden' }]));
  h.state.posts.length = 0;
  const run = (dirty, extra) => h.tool.handle({ type: 'switchGroup', dirty, ...extra }, h.tool.panel);
  return { ...h, run };
}
for (const edition of ['public', 'enterprise']) test(`switchGroup: ${edition} picks a fresh profile group by its exact name without writing`, async t => {
  const h = await switchHarness(t, edition === 'enterprise' ? sampleEdition() : undefined);
  const { setLocale } = require('../src/i18n'); setLocale(edition === 'public' ? 'en' : 'zh-cn');
  let rows, options;
  h.v.window.showQuickPick = async (items, opts) => { rows = items; options = opts; return rows[1]; };
  const before = h.state.text;
  await h.run(false, { name: 'untrusted', groups: ['forged'] });
  assert.deepEqual(rows?.map(r => r.label), [preset.name, switchTarget.name]);
  assert.notEqual(options.canPickMany, true);
  assert.match(rows[0].description, /1/); assert.match(rows[1].description, /0/);
  const current = edition === 'public' ? /current/i : /当前/;
  assert.match(JSON.stringify(rows[0]), current); assert.doesNotMatch(JSON.stringify(rows[1]), current);
  assert.doesNotMatch(JSON.stringify(rows), /picker-fixture|private-header|first-model/);
  assert.equal(h.state.dialogs.length, 0); assert.equal(lastDraft(h).name, switchTarget.name);
  assert.equal(h.tool.baseline.group.apiKey, switchTarget.apiKey); assert.equal(h.state.text, before);
  assert.deepEqual(await h.backups(), []); assert.equal(h.state.secrets.size, 0); assert.equal(h.state.settings.size, 0);
});
test('switchGroup: can switch from a preset draft to the saved group with the same name', async t => {
  const h = await switchHarness(t, sampleEdition());
  await h.tool.refresh(null, 'preset');
  h.state.pick = rows => rows.find(row => row.label === preset.name);
  await h.run(true);
  assert.equal(h.state.dialogs.length, 1);
  assert.equal(h.state.posts.findLast(m => m.type === 'state').draftKind, 'existing');
});
test('switchGroup: discard confirmation is only for a different group with edits or a pending key', async t => {
  const h = await switchHarness(t), original = h.tool.baseline;
  h.tool.pendingKey = 'pending-fixture';
  for (const choice of [undefined, preset.name]) {
    h.state.pick = rows => rows.find(r => r.label === choice);
    await h.run(true); assert.equal(h.state.dialogs.length, 0); assert.equal(h.tool.pendingKey, 'pending-fixture');
  }
  h.state.pick = rows => rows[1]; h.state.cancel = true;
  await h.run(false); assert.equal(h.state.dialogs.length, 1); assert.equal(h.state.dialogs[0].options.modal, true);
  assert.equal(h.tool.pendingKey, 'pending-fixture'); assert.equal(h.tool.baseline, original);
  h.tool.pendingKey = undefined; await h.run(true); assert.equal(h.state.dialogs.length, 2);
  assert.equal(h.tool.baseline, original); assert.ok(!h.state.posts.some(m => m.type === 'state'));
  h.tool.pendingKey = 'pending-fixture'; h.state.cancel = false; await h.run(true);
  assert.equal(lastDraft(h).name, switchTarget.name); assert.equal(h.tool.pendingKey, undefined);
  assert.doesNotMatch(JSON.stringify([h.state.dialogs, h.state.posts]), /pending-fixture|private-header|picker-fixture/);
});
for (const failure of ['removed', 'unreadable']) test(`switchGroup: ${failure} target after confirmation preserves the old draft and key`, async t => {
  const h = await switchHarness(t), baseline = h.tool.baseline, template = h.tool.template;
  h.tool.pendingKey = 'pending-fixture'; h.state.pick = rows => rows[1];
  h.state.beforeConfirm = async () => { if (failure === 'removed') await h.external(JSON.stringify([preset])); else h.state.dirty = true; };
  await h.run(false);
  assert.ok(h.state.lastError); assert.equal(h.tool.baseline, baseline); assert.equal(h.tool.template, template);
  assert.equal(h.tool.pendingKey, 'pending-fixture'); assert.ok(!h.state.posts.some(m => m.type === 'state'));
});
for (const stage of ['initial read', 'picker', 'confirmation', 'reload read']) test(`switchGroup: replacement during ${stage} never receives stale draft or loses its key`, async t => {
  const h = await switchHarness(t), nextPosts = [];
  const replace = () => {
    h.tool.panel = { active: true, webview: { postMessage: async m => { nextPosts.push(m); return true; } }, reveal() {} };
    h.tool.pendingKey = 'replacement-key';
  };
  const read = h.tool.readConfig.bind(h.tool); let reads = 0, picks = 0;
  h.tool.readConfig = async () => {
    ++reads; const result = await read();
    if (stage === 'initial read' && reads === 1 || stage === 'reload read' && reads === 2) replace();
    return result;
  };
  h.state.pick = rows => { ++picks; if (stage === 'picker') replace(); return rows[1]; };
  h.state.beforeConfirm = () => { if (stage === 'confirmation') replace(); };
  await h.run(true);
  assert.equal(reads, stage === 'reload read' ? 2 : 1); assert.equal(picks, stage === 'initial read' ? 0 : 1);
  assert.equal(h.state.dialogs.length, ['confirmation', 'reload read'].includes(stage) ? 1 : 0);
  assert.deepEqual(nextPosts, []); assert.equal(h.tool.pendingKey, 'replacement-key'); assert.equal(h.tool.baseline.name, preset.name);
});
test('switchGroup: disposing the panel dismisses its outstanding native picker', async t => {
  const h = await switchHarness(t); let finishPick, started, onDispose, cancelled = false;
  const opened = new Promise(resolve => { started = resolve; });
  h.tool.panel.onDidDispose = listener => { onDispose = listener; return { dispose() {} }; };
  h.v.CancellationTokenSource = class {
    token = { onCancellationRequested: fn => { finishPick = fn; } };
    cancel() { cancelled = true; finishPick(); }
    dispose() {}
  };
  h.v.window.showQuickPick = (_, __, token) => new Promise(resolve => {
    finishPick = resolve; token?.onCancellationRequested(resolve); started();
  });
  const switching = h.run(false); await opened;
  try {
    h.tool.panel = undefined; onDispose?.();
    assert.equal(cancelled, true);
  } finally { finishPick(); await switching; }
  assert.equal(h.tool.busy, false); assert.ok(!h.state.posts.some(m => m.type === 'state'));
});
test('switchGroup: malformed requests and absent or inactive panels cannot open the picker', async t => {
  const h = await switchHarness(t); let picks = 0;
  h.state.pick = () => { ++picks; }; await h.run('false');
  await h.tool.handle({ type: 'switchGroup', dirty: false });
  await h.tool.handle({ type: 'switchGroup', dirty: false }, { active: true });
  h.tool.panel.active = false; h.state.posts.length = 0; await h.run(false);
  assert.deepEqual(h.state.posts, [{type:'busy',value:false}]);
  h.tool.panel = undefined; await h.run(false);
  assert.equal(picks, 0); assert.equal(h.state.dialogs.length, 0);
});

test('host: explicit refresh does not replace a draft, baseline, or pending key on read failure', async t => {
  const h = await harness(t, JSON.stringify([preset]));
  await h.tool.refresh();
  const baseline = h.tool.baseline, template = h.tool.template;
  h.tool.pendingKey = 'pending-fixture'; h.state.posts.length = 0; h.state.dirty = true;
  await h.tool.handle({ type: 'refresh', name: preset.name });
  assert.equal(h.tool.baseline, baseline); assert.equal(h.tool.template, template);
  assert.equal(h.tool.pendingKey, 'pending-fixture');
  assert.equal(h.state.posts.some(m => m.type === 'state'), false);
  assert.ok(h.state.posts.some(m => m.type === 'notice' && m.kind === 'error'));
  assert.equal(JSON.stringify(h.state.posts).includes('pending-fixture'), false);
  h.state.dirty = false;
  await h.tool.handle({ type: 'refresh', name: preset.name });
  assert.equal(h.tool.pendingKey, undefined);
  assert.equal(h.state.posts.findLast(m => m.type === 'state').hasPendingKey, false);
});

for (const failure of ['reject', 'not delivered']) {
  test(`host: explicit refresh retains its host draft when replacement state is ${failure}`, async t => {
    const h = await harness(t, JSON.stringify([preset, { ...preset, name: 'other' }]));
    await h.tool.refresh(); h.tool.pendingKey = 'pending-fixture';
    const baseline = h.tool.baseline, template = h.tool.template, deliver = h.tool.panel.webview.postMessage;
    h.tool.panel.webview.postMessage = async m => {
      if (m.type !== 'state') return deliver(m);
      if (failure === 'reject') throw new Error('Panel delivery failed');
      return false;
    };
    await h.tool.handle({ type: 'refresh', name: 'other' });
    assert.equal(h.tool.baseline, baseline); assert.equal(h.tool.template, template);
    assert.equal(h.tool.pendingKey, 'pending-fixture');
  });
}

test('host: explicitly reloading a vanished group preserves the last loaded group', async t => {
  const h = await harness(t, JSON.stringify([preset]));
  await h.tool.refresh(); h.tool.pendingKey = 'pending-fixture';
  await h.external('[]'); h.state.posts.length = 0;
  await h.tool.handle({ type: 'refresh', name: preset.name });
  assert.equal(h.tool.baseline?.name, preset.name);
  assert.equal(h.tool.pendingKey, 'pending-fixture');
  assert.equal(h.state.posts.some(m => m.type === 'state'), false);
  assert.ok(h.state.posts.some(m => m.type === 'notice' && m.kind === 'error'));
});

test('host: rejected initial busy delivery does not strand subsequent operations', async t => {
  const h = await harness(t), deliver = h.tool.panel.webview.postMessage;
  h.tool.panel.webview.postMessage = async m => {
    if (m.type === 'busy' && m.value) throw new Error('Panel delivery failed');
    return deliver(m);
  };
  await h.tool.handle({ type: 'format', modelsText: '[]' }).catch(() => {});
  assert.equal(h.tool.busy, false);
  assert.deepEqual(h.state.posts.at(-1), { type: 'busy', value: false });
  assert.ok(!h.state.posts.some(m => m.type === 'models'));
  h.tool.panel.webview.postMessage = deliver;
  await h.tool.handle({ type: 'format', modelsText: '[]' });
  assert.ok(h.state.posts.some(m => m.type === 'models'));
});

test('host: save failure unlocks while the non-modal error notification is still visible', async t => {
  const h = await harness(t);
  let shown, dismiss;
  const visible = new Promise(resolve => { shown = resolve; });
  h.v.window.showErrorMessage = () => { shown(); return new Promise(resolve => { dismiss = resolve; }); };
  h.tool.apply = async () => { throw new Error('Invalid draft'); };
  const saving = h.tool.handle({ type: 'apply', form: form() });
  try {
    await visible; await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.tool.busy, false);
    assert.deepEqual(h.state.posts.at(-1), { type: 'busy', value: false });
    assert.ok(h.state.posts.some(m => m.kind === 'error' && m.text === 'Invalid draft'));
  } finally { dismiss(); await saving; }
});
const sampleEdition = () => ({ edition: 'sample', publisher: 'sample', name: 'sample-manager', displayName: 'Sample Manager',
  preset, auxiliaryModel: preset.models[0].id, settings: [{ key: HOST, value: false }], aliases: { 'legacySample.open': 'byokManager.open' },
  features: { presetButton: true }, locales: { en: {}, 'zh-cn': {} } });
test('edition: a fresh profile loads a cloned default, but a saved group takes priority', async t => {
  const edition = sampleEdition(), h = await harness(t, '[]', edition);
  await h.tool.refresh(); assert.deepEqual(JSON.parse(lastDraft(h).modelsText), preset.models);
  assert.equal(lastDraft(h).auxiliaryModel, edition.auxiliaryModel); assert.notEqual(h.tool.template.models, preset.models);
  await h.external(JSON.stringify([{ ...preset, name: 'local' }])); await h.tool.refresh();
  assert.equal(lastDraft(h).name, 'local'); assert.equal(lastDraft(h).auxiliaryModel, '');
  await h.tool.apply(form({ name: 'local', noAuth: true, applyRecommendedSettings: true }));
  assert.deepEqual([...h.state.settings], [[HOST, false]]);
});
test('edition: loading requires confirmation, retains pending key and tracks the existing group for conflicts', async t => {
  const stored = { ...preset, apiKey: '${input:chat.lm.secret.sample}', models: [sampleModel()] };
  const initial = JSON.stringify([stored]); const h = await harness(t, initial, sampleEdition());
  await h.tool.refresh(); h.tool.pendingKey = 'pending-sample'; h.state.cancel = true;
  await h.tool.handle({ type: 'editionPreset' }); assert.equal(h.state.dialogs.length, 1);
  assert.deepEqual(JSON.parse(lastDraft(h).modelsText), stored.models);
  h.state.cancel = false; await h.tool.handle({ type: 'editionPreset' });
  assert.deepEqual(JSON.parse(lastDraft(h).modelsText), preset.models); assert.equal(h.tool.pendingKey, 'pending-sample');
  assert.equal(h.state.text, initial); assert.equal((await h.backups()).length, 0); assert.equal(h.state.secrets.size, 0);
  assert.ok(!JSON.stringify(h.state.posts).includes('pending-sample'));
  await h.external(JSON.stringify([{ ...stored, models: [] }])); await assert.rejects(h.tool.apply(lastDraft(h)), /已被修改/);
});
test('edition: an upgraded installation restores a format-1 backup in its existing storage without copying keys', async t => {
  const h = await harness(t, '[]', sampleEdition());
  const original = JSON.stringify([{ ...preset, apiKey: '${input:chat.lm.secret.old}' }]);
  const historic = path.join(h.tool.context.globalStorageUri.fsPath, 'backups', 'historic');
  await fs.mkdir(historic, { recursive: true });
  await fs.writeFile(path.join(historic, 'config.jsonc'), original);
  await fs.writeFile(path.join(historic, 'meta.json'), JSON.stringify({ format: 1, created: '2026-01-01',
    reason: 'apply', status: 'complete', configUri: h.uri.toString(), beforeHash: core.digest(original),
    settingsBefore: [{ key: HOST, hadValue: false }], settingsApplied: [{ key: HOST, value: false }] }));
  h.state.settings.set(HOST, false); await h.tool.restore();
  assert.equal(h.state.text, original); assert.equal(h.state.settings.has(HOST), false);
  assert.equal(h.state.commands.some(c => c.name === ADD), false);
  assert.deepEqual((await h.backups()).map(b => b.meta.reason).sort(), ['apply', 'before-restore']);
});
test('edition: public runtime ignores forged preset request', async t => {
  const h = await harness(t); await h.tool.handle({ type: 'editionPreset', preset });
  assert.equal(h.state.dialogs.length, 0); assert.equal(h.state.posts.some(p => p.type === 'state'), false);
});
test('edition: legacy commands run the same manager without a duplicate panel', async t => {
  const h = await harness(t), sidebar = activateSidebar(h, 'en', sampleEdition());
  await sidebar.commands.get('legacySample.open')(); await sidebar.commands.get('byokManager.open')();
  assert.equal(sidebar.panels.length, 1); assert.equal(sidebar.panels[0].reveals, 1);
  assert.equal(sidebar.panels[0].title, 'Sample Manager'); sidebar.dispose();
});
test('edition stages can coexist: manifests, runtime registrations and walkthrough links use the same distinct IDs', async t => {
  const { withStage } = require('../scripts/build');
  const fixture = { ...require('../editions/enterprise.example.json'), publisher: 'fixture-org', name: 'fixture-manager' };
  const h = await harness(t), configPath = path.join(h.dir, 'fixture.json');
  await fs.writeFile(configPath, JSON.stringify(fixture));
  await withStage('enterprise', async ({ stage, pkg: staged }) => {
    const entry = require(path.join(stage, 'src', 'extension.js'));
    const [container] = staged.contributes.viewsContainers.activitybar;
    assert.notEqual(container.id, pkg.contributes.viewsContainers.activitybar[0].id);
    const stagedIds = staged.contributes.commands.map(c => c.command);
    const publicIds = pkg.contributes.commands.map(c => c.command);
    assert.ok(stagedIds.every(id => !publicIds.includes(id)));
    const [view] = staged.contributes.views[container.id]; assert.notEqual(view.id, 'byokManager.actions');
    h.tool.context.extensionPath = stage; h.tool.context.extensionUri = Uri.file(stage);
    const sidebar = activateSidebar(h, 'en', undefined, entry.activate);
    assert.ok(sidebar.views.has(view.id));
    assert.ok(stagedIds.every(id => sidebar.commands.has(id)));
    await sidebar.commands.get(Object.keys(fixture.aliases)[0])();
    assert.notEqual(sidebar.panels[0].id, 'byokManager');
    assert.match(sidebar.panels[0].webview.html, /id="loadEditionPreset"/);
    for (const lang of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const labels = require(path.join(stage, lang));
      for (const value of Object.values(labels)) for (const [,id] of value.matchAll(/\(command:([\w.]+)\)/g)) assert.ok(sidebar.commands.has(id), id);
    }
    sidebar.dispose();
  }, { configPath, expectedEnterpriseId: `${fixture.publisher}.${fixture.name}` });
});

test('host: first open shows a blank generic group and never writes', async t => {
  const h=await harness(t); await h.tool.refresh(); const draft=lastDraft(h);
  assert.equal(draft.name,'custom'); assert.equal(draft.apiType,'chat-completions'); assert.equal(draft.defaultUrl,'');
  assert.deepEqual(JSON.parse(draft.modelsText),[]); assert.equal(h.state.text,'[]'); assert.equal(h.state.secrets.size,0);
});
test('host: first existing group is selected; new group cancel keeps draft',async t=>{
  const h=await harness(t,JSON.stringify([preset])); await h.tool.refresh();
  assert.deepEqual(JSON.parse(lastDraft(h).modelsText),preset.models);
  h.tool.pendingKey='pending'; h.state.cancel=true; await h.tool.handle({type:'new'});
  assert.equal(h.tool.pendingKey,'pending'); assert.deepEqual(JSON.parse(lastDraft(h).modelsText),preset.models);
});
test('host: new group resets draft but not configuration',async t=>{
  const initial=JSON.stringify([preset]); const h=await harness(t,initial); await h.tool.refresh(); h.tool.pendingKey='pending';
  await h.tool.handle({type:'new'}); assert.equal(h.tool.pendingKey,undefined); assert.equal(h.state.text,initial); assert.deepEqual(JSON.parse(lastDraft(h).modelsText),[]);
});
test('host: visual merge only changes draft, apply reuses original secret and backs up', async t => {
  const existing={...preset,apiKey:'${input:chat.lm.secret.existing}'};
  const other={name:'other',vendor:'another',models:[]};
  const initial=JSON.stringify([existing,other]);const h=await harness(t,initial);
  await h.tool.refresh();const draft=lastDraft(h);
  await h.tool.handle({type:'mergeModels',form:draft,incomingText:JSON.stringify(sampleModel())});
  const merged=h.state.posts.findLast(m=>m.type==='merged');assert.ok(merged);assert.equal(h.state.text,initial);
  await h.tool.apply({...draft,modelsText:merged.text});
  const groups=parseGroups(h.state.text).value;
  assert.equal(groups[0].apiKey,existing.apiKey);assert.equal(groups[0].models.length,2);assert.deepEqual(groups[1],other);
  assert.equal((await h.backups())[0].text,initial);assert.equal(h.state.secrets.size,0);
});
test('host: failed merge never mutates config or loses pending key', async t => {
  const h=await harness(t);await h.tool.refresh();h.tool.pendingKey='pending-key';
  await h.tool.handle({type:'mergeModels',form:lastDraft(h),incomingText:'[{"id":"invalid"}]'});
  assert.ok(h.state.lastError);assert.equal(h.state.text,'[]');assert.equal(h.tool.pendingKey,'pending-key');
  assert.equal(h.state.posts.some(m=>m.type==='merged'),false);
});

const recommendedForm = overrides => form({applyRecommendedSettings:true, auxiliaryModel:sampleModel().id,...overrides});
test('host: selected model writes seven settings and restores prior settings', async t=>{
  const h=await harness(t); h.tool.pendingKey='key'; h.state.settings.set('unrelated.setting','keep');
  await h.tool.apply(recommendedForm()); for(const [k,v] of Object.entries(RECOMMENDED)) assert.deepEqual(h.state.settings.get(k),v);
  const [b]=await h.backups(); assert.equal(b.meta.settingsApplied.length,7); assert.equal(b.meta.settingsBefore.length,7);
  await h.tool.restore(); assert.deepEqual([...h.state.settings],[['unrelated.setting','keep']]);
});
test('host: no auxiliary selection writes only the three generic settings',async t=>{
  const h=await harness(t); h.tool.pendingKey='key'; await h.tool.apply(recommendedForm({auxiliaryModel:''})); assert.equal(h.state.settings.size,3); assert.equal(h.state.settings.has('chat.utilityModel'),false);
});
test('host: invalid auxiliary selection never writes selectors',async t=>{
  const h=await harness(t); h.tool.pendingKey='key'; await h.tool.apply(recommendedForm({auxiliaryModel:'nonexistent'})); assert.equal(h.state.settings.size,3);
});
test('host: preserve conflicting settings by default',async t=>{
  const h=await harness(t); h.tool.pendingKey='key'; h.state.settings.set(HOST,false); h.state.settings.set('chat.utilityModel','other/model');
  await h.tool.apply(recommendedForm()); assert.equal(h.state.settings.get(HOST),false); assert.equal(h.state.settings.get('chat.utilityModel'),'other/model'); assert.equal((await h.backups())[0].meta.settingsApplied.length,5);
});
test('host: explicit overwrite with restore',async t=>{
  const h=await harness(t); h.tool.pendingKey='key'; h.state.settings.set(HOST,false); await h.tool.apply(recommendedForm({overwriteRecommendedSettings:true})); assert.equal(h.state.settings.get(HOST),true); await h.tool.restore(); assert.equal(h.state.settings.get(HOST),false);
});
test('host: unchecked recommendation writes nothing',async t=>{
  const h=await harness(t); h.tool.pendingKey='key'; await h.tool.apply(recommendedForm({applyRecommendedSettings:false})); assert.equal(h.state.settings.size,0);
});
test('host: unsupported setting skipped',async t=>{
  const h=await harness(t); h.tool.pendingKey='key'; h.state.unsupportedSetting='chat.requestQueuing.defaultAction'; await h.tool.apply(recommendedForm()); assert.equal(h.state.settings.size,6);
});
test('host: concurrent settings preserved',async t=>{
  const h=await harness(t); h.tool.pendingKey='key'; h.state.beforeConfirm=()=>h.state.settings.set(HOST,false); await h.tool.apply(recommendedForm({overwriteRecommendedSettings:true})); assert.equal(h.state.settings.get(HOST),false);
});
test('host: identical settings skipped',async t=>{
  const h=await harness(t); h.tool.pendingKey='key'; for(const [k,v] of Object.entries(RECOMMENDED)) h.state.settings.set(k,v); await h.tool.apply(recommendedForm()); assert.equal((await h.backups())[0].meta.settingsApplied.length,0);
});
test('host: settings failure does not roll back models',async t=>{
  const h=await harness(t); h.tool.pendingKey='key'; h.state.failingSetting='chat.utilityModel'; await h.tool.apply(recommendedForm()); assert.equal(h.state.settings.size,6); assert.equal(parseGroups(h.state.text).value.length,1);
});
test('host: language-specific webview and native messages',async t=>{
  const h=await harness(t); const web={cspSource:'test',asWebviewUri:u=>u};
  const zh=await h.tool.html(web); assert.match(zh,/lang="zh-CN"/); assert.match(zh,/默认辅助模型/); assert.match(zh,/id="applyRecommendedSettings" type="checkbox" checked/);
  h.v.env.language='en'; const enTool=new ByokTool(h.v,h.tool.context); const en=await enTool.html(web); assert.match(en,/lang="en"/); assert.match(en,/Default Auxiliary Model/); assert.doesNotMatch(en,/\p{Script=Han}/u); assert.ok(!en.includes('{{RECOMMENDED_SETTINGS}}'));
  h.v.workspace.isTrusted=false; await assert.rejects(enTool.ensureCompatible(),/trusted workspace/);
});
