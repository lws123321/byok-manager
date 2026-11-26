'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { releaseManifest } = require('../scripts/release');
const { setLocale, tr } = require('../src/i18n');
const pkg = require('../package.json');
test('marketplace identity is fixed and repository metadata does not modify the checkout', () => {
  for (const p of ['', 'different-publisher', 'bad publisher', 'x;cmd']) assert.throws(() => releaseManifest(pkg,p));
  const output=releaseManifest(pkg,pkg.publisher,'https://github.com/example-dev/byok-manager');
  assert.equal(output.publisher,'asong-dev'); assert.equal(output.repository.url,'https://github.com/example-dev/byok-manager');
  assert.equal(pkg.repository,undefined); assert.equal(output.name,'byok-manager');
});
test('root packaging is refused and the inventory excludes private files even without the hook', async t => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  assert.match(pkg.scripts['vscode:prepublish'] || '', /process\.exit\(1\)/);
  let cli;
  try { cli = require.resolve('@vscode/vsce/vsce'); } catch { t.skip('official vsce not installed'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-root-package-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(root, '.vscodeignore'), path.join(dir, '.vscodeignore'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, description: 'Synthetic fixture' }));
  fs.writeFileSync(path.join(dir, 'README.md'), 'Synthetic release test.');
  fs.mkdirSync(path.join(dir, 'dist', 'enterprise'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'enterprise', 'previous.vsix'), 'Synthetic artifact');
  fs.mkdirSync(path.join(dir, 'editions', 'enterprise.local'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'editions', 'enterprise.local', 'config.json'), '{}');
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 30000 });
  const list = run(['ls', '--no-dependencies']);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(list.stdout.trim().split(/\r?\n/).sort(), ['README.md', 'package.json']);
  const attempt = run(['package', '--no-dependencies', '--out', 'blocked.vsix']);
  assert.notEqual(attempt.status, 0); assert.match(attempt.stdout + attempt.stderr, /Use the edition packaging commands/);
  assert.equal(fs.existsSync(path.join(dir, 'blocked.vsix')), false);
});
test('release rejects credential-bearing and non-HTTPS repository URLs', () => {
  for (const u of ['http://example.com/a','https://user:pass@example.com/a','https://example.com/a?token=abc','https://example.com/a#x']) assert.throws(()=>releaseManifest(pkg,pkg.publisher,u));
});
test('activity bar contributes a native view with localized titles and a bundled key icon', () => {
  const [container] = pkg.contributes.viewsContainers.activitybar;
  const [view] = pkg.contributes.views[container.id];
  assert.ok(view.id); assert.equal(view.type || 'tree', 'tree');
  for (const locale of [require('../package.nls.json'), require('../package.nls.zh-cn.json')]) {
    for (const title of [container.title, view.name]) {
      assert.match(title, /^%.+%$/); assert.ok(locale[title.slice(1, -1)]);
    }
  }
  assert.equal(container.icon, 'media/key.svg');
  assert.match(fs.readFileSync(path.join(__dirname, '..', container.icon), 'utf8'), /<svg\b/);
});
test('native walkthrough localizes every step, screenshot and action in both languages', () => {
  const guides = pkg.contributes.walkthroughs;
  assert.equal(guides?.length, 1);
  const [guide] = guides;
  assert.equal(guide.id, 'userGuide');
  assert.equal(guide.steps.length, 7);
  assert.equal(new Set(guide.steps.map(s => s.id)).size, 7);
  assert.deepEqual(guide.steps.find(s => s.id === 'save').completionEvents, ['onContext:byokManager.configurationSaved']);
  const commands = new Set(pkg.contributes.commands.map(c => c.command));
  assert.ok(commands.has('byokManager.openGuide'));
  assert.ok(!(pkg.activationEvents || []).some(event => event === '*' || event === 'onStartupFinished'));
  for (const [lang, locale] of [['en', require('../package.nls.json')], ['zh-cn', require('../package.nls.zh-cn.json')]]) {
    const localize = token => {
      assert.match(token, /^%[^%]+%$/);
      const value = locale[token.slice(1, -1)];
      assert.ok(value?.trim(), `${lang}: ${token}`);
      return value;
    };
    localize(guide.title); localize(guide.description);
    const images = new Set();
    for (const step of guide.steps) {
      localize(step.title); localize(step.media.altText);
      images.add(localize(step.media.image));
      const expectedAction = { open: 'byokManager.open', save: 'byokManager.open', maintain: 'byokManager.restore', faq: 'byokManager.diagnose' }[step.id];
      const actions = [...localize(step.description).matchAll(/^\[[^\]\n]+\]\(command:([\w.]+)\)$/gm)].map(match => match[1]);
      assert.deepEqual(actions, expectedAction ? [expectedAction] : [], `${lang}: ${step.id} actions`);
      for (const action of actions) assert.ok(commands.has(action));
    }
    assert.deepEqual(images, new Set(['provider', 'model', 'save'].map(name => `media/guide/${name}-${lang}.png`)));
    for (const image of images) {
      const bytes = fs.readFileSync(path.join(__dirname, '..', image));
      assert.ok(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), image);
    }
    for (const status of ['400', '401', '403', '429']) assert.ok(guide.steps.some(s => localize(s.description).includes(status)), `${lang} FAQ: ${status}`);
  }
});
test('localized package metadata keys and UI IDs match',()=>{
  const en=require('../package.nls.json'), zh=require('../package.nls.zh-cn.json');
  assert.deepEqual(Object.keys(en).sort(),Object.keys(zh).sort());
  const ids=file=>Array.from(fs.readFileSync(path.join(__dirname,'../media',file),'utf8').matchAll(/\bid="([^"]+)"/g),m=>m[1]).sort();
  assert.deepEqual(ids('index.html'),ids('index.zh-cn.html'));
  setLocale('zh-cn');assert.equal(tr('中文','English'),'中文');setLocale('fr');assert.equal(tr('中文','English'),'English');
});
