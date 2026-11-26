'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const audit = () => require('../scripts/audit');
const root = path.resolve(__dirname, '..');
const { zip, manifest } = require('../scripts/package');
const pkg = { ...require('../package.json'), publisher: 'asong-dev' };
const baseFiles = ['package.nls.json','package.nls.zh-cn.json','README.md','README.zh-CN.md','SECURITY.md','SUPPORT.md','LICENSE.txt','CHANGELOG.md','media/app.js','media/style.css','media/index.html','media/index.zh-cn.html','media/key.svg','media/icon.png','src/core.js','src/extension.js','src/i18n.js','src/jsonc.js', ...['en','zh-cn'].flatMap(l => ['provider','model','save'].map(s => `media/guide/${s}-${l}.png`))];
async function candidate(t) {
  const { dir } = await workspace(t);
  const types = { png:'image/png',svg:'image/svg+xml',md:'text/markdown',txt:'text/plain',json:'application/json',css:'text/css',js:'application/javascript',html:'text/html',vsixmanifest:'text/xml' };
  const edition = {edition:'public',name:pkg.name,publisher:pkg.publisher,displayName:pkg.displayName,preset:null,aliases:{},auxiliaryModel:'',settings:require('../editions/public.json').settings,features:{presetButton:false},locales:{en:{},'zh-cn':{}}};
  const entries = [ ['extension.vsixmanifest', manifest(pkg)], ['[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${Object.entries(types).map(([ext,mime]) => `<Default Extension="${ext}" ContentType="${mime}"/>`).join('')}</Types>`], ['extension/package.json', JSON.stringify(pkg)], ['extension/edition.json', JSON.stringify(edition)], ...await Promise.all(baseFiles.map(async f => ['extension/'+f, await fs.readFile(path.join(root,f))])) ];
  const file = path.join(dir, 'candidate.vsix');
  async function verify(changes = {}, edit = b => b, editionName = 'public', expected = pkg) {
    const data = new Map(entries); for (const [k,v] of Object.entries(changes)) data.set(k,v);
    await fs.writeFile(file, edit(zip([...data])));
    return audit().verifyVsix(file, editionName, expected, { root: dir });
  }
  return { entries, verify, dir };
}

test('verifies ordinary ZIP, metadata, public configuration and tutorial assets', async t => {
  const { verify, entries } = await candidate(t);
  await verify();
  const config = JSON.parse(new Map(entries).get('extension/edition.json'));
  await assert.rejects(verify({'extension/edition.json':JSON.stringify({...config, settings:[]})}), /settings|recommendation/i);
  await assert.rejects(verify({'extension/sidecar.txt':'extra'}), /inventory/i);
  await assert.rejects(verify({'extension/readme.md':'duplicate'}), /duplicate/i);
  await assert.rejects(verify({'extension/media/guide/model-en.png':'not an image'}), /PNG/i);
  await assert.rejects(verify({'extension.vsixmanifest': manifest(pkg).replace('Path="extension/package.json"','Path="extension/README.md"')}), /asset/i);
  await assert.rejects(verify({'extension.vsixmanifest': manifest(pkg).replace('Publisher="asong-dev"','Publisher="example"')}), /identity/i);
  await assert.rejects(verify({'extension/edition.json':JSON.stringify({...JSON.parse(new Map(entries).get('extension/edition.json')),edition:'enterprise'})}), /edition/i);
  await assert.rejects(verify({'extension/src/core.js':'ghp_'+'x'.repeat(36)}), /credential/i);
});

test('enterprise payload may include private edition labels, never credentials', async t => {
  const { verify, entries } = await candidate(t);
  const ep = {...pkg,publisher:'asong-local',name:['asong','byok','helper'].join('-')};
  const c = { ...JSON.parse(new Map(entries).get('extension/edition.json')), name:ep.name,publisher:ep.publisher,edition:'enterprise',preset:{models:[{id:'sample'}]},features:{presetButton:true} };
  const changes = {'extension/package.json':JSON.stringify(ep),'extension/edition.json':JSON.stringify(c),'extension.vsixmanifest':manifest(ep)};
  for (const f of ['media/index.html','media/index.zh-cn.html']) changes['extension/'+f] = '<button id="loadEditionPreset"></button>';
  await verify(changes, undefined, 'enterprise', ep);
  await assert.rejects(verify({...changes,'extension/edition.json':JSON.stringify({...c, apiKey:'opaque-value'})},undefined,'enterprise',ep), /credential/i);
});

test('trusted stage rejects stale resource bytes even when archive inventory is correct', async t => {
  const { entries, verify, dir } = await candidate(t);
  const stage = path.join(dir,'stage');
  for (const [name,data] of entries.filter(([name]) => name.startsWith('extension/'))) {
    const dest = path.join(stage,name.slice(10)); await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.writeFile(dest,data);
  }
  await verify();
  const check = () => audit().verifyVsix(path.join(dir,'candidate.vsix'),'public',pkg,{stage,root:dir});
  await check();
  await fs.writeFile(path.join(stage,'src/core.js'),'stale'); await assert.rejects(check(), /trusted stage/i);
});

test('rejects corrupted CRC, unsafe ZIP paths, symlinks, hidden trailing data', async t => {
  const { verify } = await candidate(t);
  const central = b => b.readUInt32LE(b.length - 6);
  await assert.rejects(verify({}, b => { b[central(b)+16] ^= 1; return b; }), /CRC|header/i);
  await assert.rejects(verify({}, b => { b.writeUInt32LE((0o120777 * 65536) >>> 0, central(b)+38); return b; }), /symlink|regular/i);
  await assert.rejects(verify({}, b => { const at = central(b); b[at+46] = 47; return b; }), /path|header/i);
  await assert.rejects(verify({}, b => Buffer.concat([b,Buffer.from('extra')])), /ZIP/i);
});

async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  const write = async (name, content) => {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  };
  await write('.gitignore', 'editions/enterprise.local/\ndist/\nnode_modules/\n');
  return { dir, git, write };
}

test('audit API is available', () => {
  assert.equal(typeof audit().auditSource, 'function');
  assert.equal(typeof audit().verifyVsix, 'function');
});

test('checks untracked, staged-only, and worktree-only secrets without printing them', async t => {
  const { dir, git, write } = await workspace(t);
  const token = 'ghp_' + 'X'.repeat(36);
  const rejected = () => assert.rejects(audit().auditSource(dir), e => /credential/i.test(e.message) && !e.message.includes(token));
  await write('notes.md', token); await rejected();
  git('add', 'notes.md'); await write('notes.md', 'redacted'); await rejected();
  git('add', 'notes.md'); await write('notes.md', token); await rejected();
  await write('notes.md', 'redacted'); await audit().auditSource(dir);
});

test('ignoring an untracked public runtime or documentation input cannot hide it', async t => {
  const {dir,write} = await workspace(t);
  await write('.gitignore','src/\n*.md\n');
  await write('src/worker.js','ghp_'+'Z'.repeat(36));
  await assert.rejects(audit().auditSource(dir), /credential/i);
  await write('src/worker.js','public'); await write('NOTES.md','ghp_'+'Z'.repeat(36));
  await assert.rejects(audit().auditSource(dir), /credential/i);
});

test('only ignored private inputs/artifacts may stay local; force-added paths fail', async t => {
  const { dir, git, write } = await workspace(t);
  await write('dist/private.vsix', 'opaque');
  await write('editions/enterprise.local/config.json', '{}');
  await audit().auditSource(dir);
  for (const name of ['editions/enterprise.local/config.json', 'dist/private.vsix', 'editions/test.local.json']) {
    await write(name, '{}');
    git('add', '-f', '--', name);
    await assert.rejects(audit().auditSource(dir), /private|artifact/i);
    git('rm', '--cached', '--', name);
  }
});

test('private input derives distinctive host, model IDs, instructions, and extra markers', async t => {
  const { dir, write } = await workspace(t);
  const [host, model, text, label] = ['inference.invalid','fixture-private-alpha','Write our special commit format','private-tenant-label'];
  const key = ['commitMessageGeneration', 'instructions'].join('.');
  await write('editions/enterprise.local/config.json', JSON.stringify({ preset:{models:[{id:model,url:`https://${host}/v1`}]}, settings:[{key,value:[{text}]}] }));
  await write('editions/enterprise.local/audit-markers.json', JSON.stringify([label]));
  for (const marker of [host, model, text, label]) {
    await write('notes.md', marker); await assert.rejects(audit().auditSource(dir), /private/i);
  }
  await write('notes.md', 'Synthetic sample with no private configuration.');
  await audit().auditSource(dir);
});
