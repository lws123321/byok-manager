'use strict';
// Optional offline release gate: node test/compare-legacy.js BASELINE.vsix CANDIDATE.vsix
// Only run on trusted local builds; the packaged CommonJS entry points execute in Node.
// Python 3 reads the ZIPs in memory. Never print exception messages, setting values or IDs.
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path').posix;
const { isDeepStrictEqual: equal } = require('node:util');
const { compileFunction } = require('node:vm');

function readArchive(file) {
  const reader = `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 assert len(set(z.namelist())) == len(z.namelist()) and z.testzip() is None
 print(json.dumps({n[10:]:z.read(n).decode('utf-8-sig') for n in z.namelist() if n.startswith('extension/') and n.endswith(('.js','.json'))}))`;
  const result = spawnSync('python', ['-c', reader, file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw Error();
  return JSON.parse(result.stdout);
}

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return 'file://' + this.fsPath; }
}
function fixture(files, shared = {}) {
  const pkg = JSON.parse(files['package.json']);
  const registered = new Map(), dispatched = [], values = shared.values ?? new Map();
  const disk = shared.disk ?? new Map(), locks = shared.locks ?? new Map();
  const namespace = `${pkg.publisher}.${pkg.name}`;
  const storage = new Uri('/test/globalStorage/' + namespace), target = new Uri('/test/profile/models.json');
  const context = { globalStorageUri: storage, extensionPath: '/extension', extensionUri: new Uri('/extension'), extension: { id: namespace }, subscriptions: [] };
  const configuration = { inspect: k => ({ globalValue: values.get(k) }), update: async (k,v) => { if (v === undefined) values.delete(k); else values.set(k,v); } };
  const v = { Uri, env: { language: 'en' }, FileType: { Directory: 2 }, ConfigurationTarget: { Global: 1 },
    TreeItem: class {}, TreeItemCollapsibleState: { None: 0 }, ThemeIcon: class {},
    workspace: { getConfiguration: () => configuration, fs: {
      createDirectory: async () => {}, writeFile: async (u,b) => disk.set(u.fsPath, Buffer.from(b)),
      readFile: async u => { if (!disk.has(u.fsPath)) throw Error(); return disk.get(u.fsPath); },
      readDirectory: async u => [...new Set([...disk.keys()].filter(k => k.startsWith(u.fsPath + '/')).map(k => k.slice(u.fsPath.length+1).split('/')[0]))].map(n => [n,2]) } },
    window: { showWarningMessage: async (_, __, action) => action, showInformationMessage: async () => {},
      showQuickPick: async choices => choices[0], showErrorMessage: async () => { throw Error(); }, registerTreeDataProvider: () => ({}) },
    commands: { registerCommand(id, fn) { registered.set(id, fn); return {}; }, async executeCommand(id, ...args) {
      if (registered.has(id)) return registered.get(id)(...args);
      dispatched.push([id,...args]);
    } }
  };
  const fakeFs = { chmod: async () => {}, async open(p, flag, mode) {
    if (flag !== 'wx' || mode !== 0o600) throw Error();
    if (locks.has(p)) throw Object.assign(Error(), { code: 'EEXIST' });
    locks.set(p,true); return { writeFile: async () => {}, close: async () => {} };
  }, unlink: async p => locks.delete(p) };
  const modules = new Map();
  function load(key) {
    if (modules.has(key)) return modules.get(key);
    if (!Object.hasOwn(files,key)) throw Error();
    const mod = { exports: {} };
    if (key.endsWith('.json')) mod.exports = JSON.parse(files[key]);
    else compileFunction(files[key], ['require','module','exports','__dirname'])(specifier => {
      if (specifier === 'vscode') return v;
      if (specifier === 'node:crypto') return crypto;
      if (specifier === 'node:path') return path;
      if (specifier === 'node:fs/promises') return fakeFs;
      if (!specifier.startsWith('.')) throw Error();
      const dep = path.join(path.dirname(key),specifier); return load(path.extname(dep) ? dep : dep + '.js');
    }, mod, mod.exports, path.dirname(key));
    modules.set(key,mod.exports); return mod.exports;
  }
  const { ByokTool, activate } = load(path.normalize(pkg.main));
  const tool = new ByokTool(v, context);
  const state = { text: shared.text ?? '[]', draft: null };
  tool.configUri = target;
  tool.environment = tool.ensureCompatible = async () => ({statelessSupported:true});
  tool.readConfig = async () => ({uri:target,text:state.text});
  tool.writeConfig = async (before,after) => { if (state.text !== before) throw Error(); state.text = after; };
  tool.post = async m => { if (m.type === 'state') state.draft = m.draft; };
  tool.notice = async () => {};
  return { state, storage, target, values, disk, locks, tool, pkg, registered, dispatched, ByokTool, activate: () => activate(context,v) };
}

function comparable(draft) {
  return { name:draft.name, apiType:draft.apiType, defaultUrl:draft.defaultUrl, models:JSON.parse(draft.modelsText) };
}
async function apply(files, form, options = {}, initial = '[]') {
  const f = fixture(files, {text:initial}); await f.tool.refresh();
  await f.tool.apply({...form, noAuth:true, applyRecommendedSettings:true, ...options});
  return f;
}
async function commandRoutes(files, ids) {
  const f = fixture(files); let action;
  for (const key of ['show','restore','diagnose']) f.ByokTool.prototype[key] = async () => { action = key; };
  f.activate();
  const routes = new Map();
  for (const id of ids) {
    if (!f.registered.has(id)) continue;
    action = null; f.dispatched.length = 0; await f.registered.get(id)();
    const guide = f.dispatched.find(x => x[0] === 'workbench.action.openWalkthrough');
    if (guide && f.pkg.contributes.walkthroughs.some(w => guide[1] === `${f.pkg.publisher}.${f.pkg.name}#${w.id}`)) action = 'walkthrough';
    if (action) routes.set(id, action);
  }
  return routes;
}
async function main() {
  if (process.argv.length !== 4) throw Error();
  const [old, next] = process.argv.slice(2).map(readArchive);
  const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) process.exitCode = 1; };
  const [a,b] = [fixture(old),fixture(next)];
  await a.tool.refresh(); await b.tool.refresh();
  check('global storage identity', a.storage.toString() === b.storage.toString());
  const d = comparable(a.state.draft), e = comparable(b.state.draft);
  check(`initial preset: ${d.models.length} ordered models, full fields including headers, shared URL`, !!d.defaultUrl && equal(d,e));
  const ids = a.pkg.contributes.commands.map(c => c.command);
  const listed = ids.filter(id => b.pkg.contributes.commands.some(c => c.command === id));
  check(`manifest activates all ${ids.length} legacy commands (${listed.length} directly listed)`, ids.every(id => listed.includes(id) || b.pkg.activationEvents?.includes('onCommand:' + id)));
  for (const [f, files] of [[a,old],[b,next]]) {
    // Resolve the UI action in each archive; a no-op must not pass by leaving the initial draft intact.
    f.state.draft = null;
    await f.tool.handle({type: files['media/app.js'].includes("send('editionPreset')") ? 'editionPreset' : 'preset'});
  }
  check('explicit preset action loads the same draft without configuration writes', !!a.state.draft && !!b.state.draft && equal(comparable(a.state.draft), comparable(b.state.draft)) && a.state.text === '[]' && b.state.text === '[]');
  if (!a.state.draft || !b.state.draft) throw Error();
  const [ar,br] = await Promise.all([commandRoutes(old,ids),commandRoutes(next,ids)]);
  check('all legacy commands dispatch the original actions, including guide', ar.size === ids.length && equal(ar,br));
  const oldSaved = await apply(old,a.state.draft), saved = await apply(next,b.state.draft);
  const backupFiles = f => [...f.disk].map(([p,data]) => [p.split('/').at(-1), data]);
  const backupSchema = f => {
    const files = new Map(backupFiles(f));
    const meta = JSON.parse(files.get('meta.json'));
    const {created, ...stable} = meta;
    return { files:[...files.keys()].sort(), snapshot:files.get('config.jsonc'), dated:Number.isFinite(Date.parse(created)), meta:stable };
  };
  check('original backup files, metadata schema, hashes and settings journal', equal(backupSchema(oldSaved),backupSchema(saved)));
  check('saved provider group, including all nested fields', equal(JSON.parse(oldSaved.state.text), JSON.parse(saved.state.text)));
  const matches = [...oldSaved.values].filter(([k,v]) => saved.values.has(k) && equal(saved.values.get(k),v)).length;
  check(`exact recommendation keys and values: ${matches}/${oldSaved.values.size}`, oldSaved.values.size === 8 && equal(oldSaved.values,saved.values));
  // Derive the fixed model from the baseline's actual ID-based preference, not a private fixture.
  const model = d.models.find(m => [...oldSaved.values.values()].includes(`${a.tool.template.vendor}/${m.id}`));
  if (!model) throw Error();
  const others = d.models.filter(m => m !== model);
  for (const [label, models, aux, initial] of [
    ['same ID, renamed display name', [{...model,name:'renamed'}],model.id,'[]'],
    ['different model selected', others,others[0]?.id,'[]'],
    ['fixed model present only in another group', others,'',JSON.stringify([{...a.tool.template,name:'separate',models:[model]}])]
  ]) {
    const form = {...a.state.draft,modelsText:JSON.stringify(models),auxiliaryModel:aux};
    const left = await apply(old,form,{},initial), right = await apply(next,form,{},initial);
    check(`fixed selectors: ${label} (${right.values.size}/${left.values.size} settings)`, equal(left.values,right.values));
  }
  const restore = fixture(next,{ disk:oldSaved.disk,values:new Map(oldSaved.values),text:oldSaved.state.text });
  let restored = false;
  try { await restore.tool.restore(); restored = restore.state.text === '[]' && restore.values.size === 0; } catch { /* redacted */ }
  check('candidate restores original backup snapshot and all settings at original storage URI',restored);
  const concurrent = fixture(next,{locks:a.locks});
  for (const [label, owner, contender] of [['original to candidate', a, concurrent], ['candidate to original', concurrent, a]]) {
    let rejected = false, entered = false;
    await owner.tool.withLock(async () => {
      try { await contender.tool.withLock(async () => { entered = true; }); } catch { rejected = true; }
    });
    check(`cross-version lock excludes same-profile writers and releases (${label})`, rejected && !entered && a.locks.size === 0);
  }
}
main().catch(() => { console.error('FAIL: comparison could not complete (details suppressed; provide two trusted, compatible VSIX files).'); process.exitCode = 1; });
