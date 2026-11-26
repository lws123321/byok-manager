'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { ByokTool } = require('../src/extension');
const { parseGroups } = require('../src/jsonc');
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
async function harness(t, initial = '[]') {
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
      async executeCommand(name, payload) {
        state.commands.push({ name, payload });
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
  const context = { globalStorageUri: Uri.file(path.join(dir, 'storage')), extensionUri: Uri.file(path.resolve('.')), extensionPath: path.resolve('.'), subscriptions: [] };
  const tool = new ByokTool(v, context);
  tool.panel = { webview: { async postMessage(m) { state.posts.push(m); return true; } }, reveal() {} };
  async function backups() {
    const root = path.join(context.globalStorageUri.fsPath, 'backups');
    const names = await fs.readdir(root).catch(() => []);
    return Promise.all(names.map(async name => ({ name, text: await fs.readFile(path.join(root, name, 'config.jsonc'), 'utf8'), meta: JSON.parse(await fs.readFile(path.join(root, name, 'meta.json'), 'utf8')), folder: path.join(root, name) })));
  }
  async function external(text) { state.text = text; await fs.writeFile(uri.fsPath, text); }
  return { tool, v, state, dir, uri, backups, external };
}

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

const preset = {name:'custom',vendor:'customendpoint',apiType:'chat-completions',models:[{...sampleModel(),id:'first-model',name:'First model'}]};
const lastDraft = h => h.state.posts.filter(p => p.type === 'state').at(-1).draft;
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
