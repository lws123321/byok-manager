'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const api = () => require('../scripts/build');
const example = () => structuredClone(require('../editions/enterprise.example.json'));

async function synthetic(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edition-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = { ...example(), publisher: 'fixture-org', name: 'fixture-manager' };
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  return { config, configPath, expectedEnterpriseId: 'fixture-org.fixture-manager' };
}

test('public stage contains only packaged files; no enterprise UI or source config path', async () => {
  let dir;
  await api().withStage('public', async ({ stage, pkg, files }) => {
    dir = stage;
    assert.equal(`${pkg.publisher}.${pkg.name}`, 'asong-dev.byok-manager');
    assert.equal(pkg.version, require('../package.json').version); assert.equal(pkg.scripts, undefined);
    assert.ok(files.includes('edition.json')); assert.ok(!files.some(f => /^(?:editions|scripts|test)\//.test(f)));
    for (const file of ['media/index.html', 'media/index.zh-cn.html', 'media/app.js']) {
      assert.doesNotMatch(await fs.readFile(path.join(stage, file), 'utf8'), /EDITION_PRESET_ACTION|loadEditionPreset/);
    }
    assert.match(await fs.readFile(path.join(stage, 'src/extension.js'), 'utf8'), /require\('\.\.\/edition.json'\)/);
  }, { configPath: '/does/not/exist' });
  await assert.rejects(fs.stat(dir), {code:'ENOENT'});
});

test('enterprise stage injects localized action and cleans up even after callback failure', async t => {
  const opts = await synthetic(t); let dir;
  await assert.rejects(api().withStage('enterprise', async ({ stage, pkg, config }) => {
    dir = stage; assert.equal(pkg.publisher, opts.config.publisher);
    for (const [file, lang] of [['index.html','en'],['index.zh-cn.html','zh-cn']]) {
      const html = await fs.readFile(path.join(stage, 'media', file), 'utf8');
      assert.ok(html.includes('id="loadEditionPreset"')); assert.ok(html.includes(config.locales[lang]['edition.loadPreset']));
    }
    assert.match(await fs.readFile(path.join(stage, 'media/app.js'), 'utf8'), /send\('editionPreset'\)/);
    throw new Error('callback failure');
  }, opts), /callback failure/);
  await assert.rejects(fs.stat(dir), {code:'ENOENT'});
});

test('reject wrong identity, broken models, credentials, unsafe assets and malformed settings', async t => {
  const opts = await synthetic(t);
  const validate = config => api().validateConfig(config, 'enterprise', opts);
  for (const change of [c => { c.publisher='wrong'; }, c => { c.preset.models[0].apiKey='private'; },
    c => { c.preset.models.push(c.preset.models[0]); }, c => { c.auxiliaryModel='missing'; },
    c => { c.locales.en['guide.save.image']='../outside.png'; }, c => { c.settings=[{key:'terminal.integrated.env.windows',value:{}}]; },
    c => { c.aliases = { 'another.command': 'workbench.action.openSettings' }; }]) {
    const c = structuredClone(opts.config); change(c); assert.throws(() => validate(c));
  }
  assert.throws(() => validate(example()));
  assert.throws(() => api().validateConfig(opts.config, 'enterprise'), /extension identity/);
});

test('public recommendations cannot redefine their own validation policy', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'public-policy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const f of ['scripts/build.js', 'src/core.js', 'src/jsonc.js', 'src/i18n.js', 'package.json', 'package.nls.json', 'editions/public.json']) {
    const dest = path.join(dir, f);
    await fs.mkdir(path.dirname(dest), {recursive:true}); await fs.copyFile(path.join(root, f), dest);
  }
  const input = path.join(dir, 'editions/public.json');
  const config = JSON.parse(await fs.readFile(input));
  config.settings[0].value = false;
  config.settings.push({key:'editor.fontSize', value:20});
  await fs.writeFile(input, JSON.stringify(config));
  // First import after modifying the input: a validator seeded from the JSON would accept it.
  const isolated = require(path.join(dir, 'scripts/build.js'));
  await assert.rejects(isolated.loadConfig('public'), /setting|recommendation/i);
});

test('public settings require every approved descriptor, with its exact form binding, value and selector', () => {
  for (const edit of [s => s.pop(), s => s.reverse(), s => { delete s[0].formKey; }, s => { s[0].value = false; },
    s => { s[1].value = 'different'; }, s => { s[3].model = 'id'; }, s => { s[3].value = 'fixed'; }]) {
    const c = structuredClone(require('../editions/public.json')); edit(c.settings);
    assert.throws(() => api().validateConfig(c, 'public'), /setting|recommendation/i);
  }
});

test('local production baseline rejects drift and cannot be bypassed with a matching identity override', async t => {
  // Optional maintainer coverage: no private fixtures, identifiers or assertion diffs in the public suite.
  const input = process.env.BYOK_ENTERPRISE_CONFIG || path.join(root, 'editions/enterprise.local/config.json');
  let c;
  try { c = JSON.parse(await fs.readFile(input, 'utf8')); }
  catch (err) { if (!process.env.BYOK_ENTERPRISE_CONFIG && err.code === 'ENOENT') return t.skip('private config unavailable'); throw Error('Unreadable private input'); }
  const validate = (candidate, opts) => api().validateConfig(candidate, 'enterprise', opts);
  validate(c);
  const reordered = JSON.parse(JSON.stringify(c, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).reverse()) : v));
  validate(reordered);
  const override = {expectedEnterpriseId:`${c.publisher}.${c.name}`};
  for (const edit of [x => { x.preset.url = 'https://changed.example.invalid'; }, x => x.preset.models.reverse(),
    x => { x.preset.models[0].name += ' changed'; }, x => { x.auxiliaryModel = x.preset.models.find(m => m.id !== x.auxiliaryModel).id; },
    x => { x.settings.find(s => Array.isArray(s.value)).value[0].text += ' changed'; },
    x => { x.settings.find(s => s.model).value = 'different'; }, x => { delete x.aliases[Object.keys(x.aliases)[0]]; },
    x => { const [a,b] = Object.keys(x.aliases); [x.aliases[a], x.aliases[b]] = [x.aliases[b], x.aliases[a]]; }]) {
    const candidate = structuredClone(c); edit(candidate);
    assert.throws(() => validate(candidate), /Invalid edition configuration/);
    assert.throws(() => validate(candidate, override), /Invalid edition configuration/);
  }
});

test('private tutorial embeds only referenced PNG assets and never their source paths', async t => {
  const opts=await synthetic(t), dir=path.dirname(opts.configPath);
  const src=path.join(dir,'assets','tutorial.png'), dest='media/edition/fixture.png';
  await fs.mkdir(path.dirname(src)); await fs.copyFile(path.join(root,'media/guide/model-en.png'),src);
  opts.config.assets = { [dest]:'assets/tutorial.png' };
  opts.config.locales.en['guide.model.image']=dest;
  await fs.writeFile(opts.configPath,JSON.stringify(opts.config));
  await api().withStage('enterprise',async ({stage,files}) => {
    assert.ok(files.includes(dest)); assert.ok(files.every(f => !f.startsWith('assets/')));
    const shipped=JSON.parse(await fs.readFile(path.join(stage,'edition.json'))); assert.equal(shipped.assets,undefined);
    assert.equal(JSON.parse(await fs.readFile(path.join(stage,'package.nls.json')))['guide.model.image'],dest);
    assert.deepEqual(await fs.readFile(path.join(stage,dest)),await fs.readFile(src));
  },opts);
  opts.config.assets[dest]='../private.png'; await fs.writeFile(opts.configPath,JSON.stringify(opts.config));
  await assert.rejects(api().withStage('enterprise',()=>assert.fail('unexpected stage'),opts),/asset paths/);
});

test('configuration cannot introduce secret references or collide with staged commands', async t => {
  const opts = await synthetic(t);
  for (const edit of [c => { c.preset.models[0].name = '${input:chat.lm.secret.example}'; },
    c => { c.aliases['byokEnterpriseManager.open'] = 'byokManager.open'; },
    c => { c.locales.en['guide.open.description']='[Unrelated command](command:workbench.action.openSettings)'; }]) {
    const c=structuredClone(opts.config); edit(c); assert.throws(() => api().validateConfig(c,'enterprise',opts));
  }
});

test('audited packagers work from a clean checkout without private inputs', async t => {
  const fixture = await synthetic(t);
  const dir = path.join(path.dirname(fixture.configPath),'checkout');
  const {sourceFiles} = require('../scripts/package');
  for (const f of sourceFiles) {
    const dest = path.join(dir,f); await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.copyFile(path.join(root,f),dest);
  }
  execFileSync('git',['init','-q'],{cwd:dir});
  const pk = require(path.join(dir,'scripts/package.js'));
  const old = process.env.BYOK_ENTERPRISE_CONFIG;
  delete process.env.BYOK_ENTERPRISE_CONFIG;
  try {
    const targets = await pk.build('public',{source:true});
    assert.equal(targets.length,2); assert.equal(path.basename(targets[0]), `asong-dev.byok-manager-${require('../package.json').version}.vsix`);
    assert.deepEqual((await fs.readdir(path.dirname(targets[0]))).sort(),['SHA256SUMS.txt',...targets.map(f => path.basename(f))].sort());
    await assert.rejects(pk.build('enterprise'),/configuration/);
    const [internal] = await pk.build('enterprise',fixture);
    assert.equal(path.basename(internal), `fixture-org.fixture-manager-${require('../package.json').version}.vsix`);
    assert.deepEqual((await fs.readdir(path.dirname(internal))).sort(), ['SHA256SUMS.txt',path.basename(internal)].sort());
    if (process.env.BYOK_TEST_VSCE === '1') {
      await fs.symlink(path.join(root,'node_modules'),path.join(dir,'node_modules'),process.platform === 'win32' ? 'junction' : 'dir');
      execFileSync(process.execPath,['scripts/release.js','package','public'],{cwd:dir,env:{...process.env,BYOK_REPOSITORY:'https://github.com/example-org/byok-manager'},stdio:'pipe'});
      assert.ok((await fs.stat(path.join(dir,'dist','marketplace',path.basename(targets[0])))).size>0);
    }
  } finally { if(old === undefined) delete process.env.BYOK_ENTERPRISE_CONFIG; else process.env.BYOK_ENTERPRISE_CONFIG=old; }
});

test('publish guard rejects enterprise, missing or wrong explicit confirmation', () => {
  const { assertMayPublish } = require('../scripts/release');
  assert.throws(() => assertMayPublish('enterprise', { BYOK_CONFIRM_PUBLISH: 'yes' }));
  assert.throws(() => assertMayPublish('public', {}));
  assert.throws(() => assertMayPublish('public', { BYOK_CONFIRM_PUBLISH: 'maybe' }));
  assert.doesNotThrow(() => assertMayPublish('public', { BYOK_CONFIRM_PUBLISH: 'yes' }));
});
