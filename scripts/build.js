'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const core = require('../src/core');

const ROOT = path.resolve(__dirname, '..');
const sharedGuide = ['provider', 'model', 'save'].flatMap(s => ['en', 'zh-cn'].map(l => `media/guide/${s}-${l}.png`));
const runtimeFiles = Object.freeze([
  'src/extension.js', 'src/discovery.js', 'src/core.js', 'src/i18n.js', 'src/jsonc.js',
  'media/app.js', 'media/index.html', 'media/index.zh-cn.html', 'media/style.css', 'media/key.svg', 'media/icon.png', ...sharedGuide,
  'package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'README.md', 'README.zh-CN.md', 'LICENSE.txt', 'CHANGELOG.md', 'SECURITY.md', 'SUPPORT.md'
]);
const publicId = 'asong-dev.byok-manager';
// Pin the upgrade identity without including private identifiers in public distributions.
const enterpriseIdHash = '79c64667ed62db0dcf3ef445fd80863152946f02aed87caf2b5d7219515f90bb';
// Pinned after comparing the working config and its VSIX against the original 0.4.2 release.
const enterprise042Digest = '0ba2499e7d0e333e0094799120abfc2731e22c95c1bf7ab6b153514741ca90bc';
const sha256 = value => createHash('sha256').update(value).digest('hex');
function compatibilityDigest({aliases, preset, settings, auxiliaryModel}) {
  // Object member order is immaterial; array order affects model display and setting application.
  const canonical = JSON.stringify({aliases, preset, settings, auxiliaryModel}, (_, v) => record(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  return sha256(canonical);
}
const locales = { en:'package.nls.json', 'zh-cn':'package.nls.zh-cn.json' };
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.trim().length > 0;
const check = (ok, field) => { if (!ok) throw new Error(`Invalid edition configuration: ${field}.`); };
const only = (obj, keys, label) => check(record(obj) && Object.keys(obj).every(k => keys.includes(k)), label);
// Build policy must not be inferred from the release input it is meant to verify.
const knownSettings = new Map([
  ['chat.agentHost.byokModels.enabled', {formKey:'enableAgentHost', value:true}],
  ['chat.byokUtilityModelDefault', {formKey:'utilityMain', value:'mainAgent'}],
  ['chat.requestQueuing.defaultAction', {value:'queue'}],
  ['chat.planAgent.defaultModel', {model:'name'}], ['inlineChat.defaultModel', {model:'name'}],
  ['chat.utilityModel', {model:'id'}], ['chat.utilitySmallModel', {model:'id'}]
]);
const commands = new Set(require('../package.json').contributes.commands.map(c => c.command));
const guideKeys = new Set(Object.keys(require('../package.nls.json')).filter(k => k.startsWith('guide.')));
const assetPath = /^media\/edition\/[a-z0-9][a-z0-9_-]{0,80}\.png$/;
function checkTree(obj) {
  if (typeof obj === 'string') check(!/\$\{(?:input:chat\.lm\.secret\.|apiKey\})/i.test(obj), 'credential reference');
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    check(!/^(?:__proto__|constructor|prototype)$|api[-_]?key|authorization|password|secret|headers|^(?:(?:access|refresh|auth)[-_]?)?token$/i.test(k), 'prohibited field');
    checkTree(v);
  }
}
function validateSettings(list, edition) {
  check(Array.isArray(list), 'settings');
  const keys = new Set();
  for (const s of list) {
    only(s, ['key','formKey','model','value'], 'settings descriptor');
    check(typeof s.key === 'string' && !keys.has(s.key), 'settings key'); keys.add(s.key);
    const known = knownSettings.get(s.key);
    if (known) {
      check(s.formKey === known.formKey, 'settings formKey');
      check(s.model === known.model && (known.model ? !Object.hasOwn(s, 'value') || (edition === 'enterprise' && text(s.value)) : s.value === known.value), 'settings value/model');
    } else {
      check(edition === 'enterprise' && s.key === ['github.copilot.chat.commitMessageGeneration','instructions'].join('.') && !s.model && !s.formKey && Array.isArray(s.value), 'unsupported setting');
      for (const instruction of s.value) { only(instruction,['text'],'instruction'); check(text(instruction.text),'instruction text'); }
    }
  }
  if (edition === 'public') check(list.length === knownSettings.size && [...knownSettings.keys()].every((key, i) => key === list[i].key), 'public recommendation settings');
}
function validateConfig(c, edition, options = {}) {
  only(c, ['edition','publisher','name','displayName','preset','settings','auxiliaryModel','aliases','features','locales','assets'], 'fields');
  checkTree(c);
  check(['public','enterprise'].includes(edition) && c.edition === edition, 'edition');
  for (const id of [c.publisher, c.name]) check(typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(id), 'extension identity');
  const id = `${c.publisher}.${c.name}`;
  const productionEnterprise = edition === 'enterprise' && sha256(id) === enterpriseIdHash;
  // An in-process fixture identity can never relax checks on either release ID.
  if (edition === 'public') check(id === publicId, 'extension identity');
  else if (options.expectedEnterpriseId !== undefined) {
    check(!productionEnterprise && id !== publicId && id !== 'example-org.example-model-manager' && id === options.expectedEnterpriseId, 'synthetic extension identity');
  } else check(productionEnterprise, 'extension identity');
  check(text(c.displayName) && !/[\x00-\x1f]/.test(c.displayName), 'displayName');
  only(c.features,['presetButton'],'features'); check(typeof c.features.presetButton === 'boolean', 'features.presetButton');
  if (edition === 'public') check(c.preset === null && !c.features.presetButton && c.auxiliaryModel === '' && !c.assets, 'public preset/features');
  if (c.preset !== null) {
    only(c.preset,['name','vendor','apiType','models','url'],'preset');
    check(c.preset.vendor === core.VENDOR && Array.isArray(c.preset.models), 'preset');
    try { core.buildGroup({ name:c.preset.name, apiType:c.preset.apiType, modelsText:JSON.stringify(c.preset.models), defaultUrl:c.preset.url }); }
    catch { throw new Error('Invalid edition configuration: preset model or endpoint.'); }
  }
  check(!c.features.presetButton || c.preset !== null, 'preset button');
  check(c.auxiliaryModel === '' || (text(c.auxiliaryModel) && c.preset?.models.some(m => m.id === c.auxiliaryModel)), 'auxiliaryModel');
  validateSettings(c.settings, edition);
  if (productionEnterprise) {
    check(c.features.presetButton && compatibilityDigest(c) === enterprise042Digest, 'Enterprise 0.4.2 compatibility baseline');
    for (const lang of Object.keys(locales)) check(text(c.locales?.[lang]?.['guide.title']) && text(c.locales?.[lang]?.['guide.provider.description']), 'missing edition tutorial');
  }
  check(record(c.aliases) && (edition !== 'public' || !Object.keys(c.aliases).length), 'aliases');
  for (const [alias,target] of Object.entries(c.aliases)) check(/^[A-Za-z][\w-]*(?:\.[\w-]+)+$/.test(alias) && !commands.has(alias) && !commands.has(alias.replace(/^byokEnterpriseManager\./,'byokManager.')) && commands.has(target), 'command alias');
  const assets = c.assets === undefined ? {} : c.assets;
  check(record(assets), 'assets');
  for (const [dest,source] of Object.entries(assets)) check(assetPath.test(dest) && typeof source === 'string' && /^assets\/[a-z0-9][a-z0-9_-]{0,80}\.png$/.test(source), 'private PNG asset paths');
  only(c.locales,Object.keys(locales),'locales');
  const used = new Set();
  for (const lang of Object.keys(locales)) {
    const dict = c.locales[lang]; check(record(dict), 'locale');
    if (c.features.presetButton) check(text(dict['edition.loadPreset']), 'preset button label');
    for (const [key,val] of Object.entries(dict)) {
      check(text(val) && (key === 'edition.loadPreset' || guideKeys.has(key)), 'locale key/value');
      for (const link of val.matchAll(/command:([^\s)]+)/gi)) check(commands.has(link[1]) || Object.hasOwn(c.aliases,link[1]), 'walkthrough command link');
      if (key.endsWith('.image')) { check(sharedGuide.includes(val) || Object.hasOwn(assets,val),'guide image'); used.add(val); }
    }
  }
  check(Object.keys(assets).every(dest => used.has(dest)), 'unused private asset');
  return c;
}
async function safeRead(base, relative) {
  const absolute = path.resolve(base, relative);
  if (await fs.realpath(absolute) !== path.join(await fs.realpath(base), relative) || !(await fs.lstat(absolute)).isFile()) throw new Error('Stage inputs must be regular files, not links.');
  return fs.readFile(absolute);
}
async function loadConfig(edition, options = {}) {
  check(['public','enterprise'].includes(edition),'edition');
  const file = edition === 'public' ? path.join(ROOT,'editions','public.json') : path.resolve(options.configPath || process.env.BYOK_ENTERPRISE_CONFIG || path.join(ROOT,'editions','enterprise.local','config.json'));
  let json;
  try { json = JSON.parse(await safeRead(path.dirname(file),path.basename(file))); }
  catch { throw new Error(`Missing, unreadable or invalid ${edition} configuration${edition === 'enterprise' ? ': provide editions/enterprise.local/config.json or BYOK_ENTERPRISE_CONFIG' : ''}.`); }
  return { config:validateConfig(json, edition, options), base:path.dirname(file) };
}
function once(source, marker, value) {
  if (source.split(marker).length !== 2) throw new Error('Missing or duplicate edition insertion point.');
  return source.replace(marker, () => value);
}
function escapeHtml(value) { return value.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
const json = data => JSON.stringify(data,null,2)+'\n';
async function withStage(edition, callback, options = {}) {
  const { config, base } = await loadConfig(edition, options);
  const { assets = {}, ...runtime } = config;
  // Commands, context keys, panel types and view container IDs are global within a window.
  const scoped = str => edition === 'enterprise' ? str.replace(/\bbyokManager\b/g, 'byokEnterpriseManager') : str;
  const pkg = JSON.parse(scoped((await safeRead(ROOT,'package.json')).toString()));
  runtime.aliases = Object.fromEntries(Object.entries(config.aliases).map(([id,target]) => [id,scoped(target)]));
  for (const k of ['publisher','name','displayName']) pkg[k] = config[k];
  delete pkg.scripts;
  if (Object.keys(config.aliases).length) pkg.activationEvents = [...new Set([...(pkg.activationEvents || []), ...Object.keys(config.aliases).map(s => 'onCommand:'+s)])];
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-stage-'));
  const files = [...runtimeFiles, 'edition.json', ...Object.keys(assets)].sort();
  try {
    for (const file of files) {
      let data;
      if (file === 'edition.json') data = json(runtime);
      else if (file === 'package.json') data = json(pkg);
      else if (Object.hasOwn(assets,file)) {
        data = await safeRead(base, assets[file]);
        check(data.length <= 8*1024*1024 && data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')), 'private guide PNG');
      } else {
        data = await safeRead(ROOT,file);
        const button = config.features.presetButton;
        if (file === 'src/extension.js') data = scoped(once(data.toString(), "require('../editions/public.json')", "require('../edition.json')"));
        if (file === 'media/app.js') data = once(data.toString(), '// EDITION_PRESET_ACTION', button ? "el('loadEditionPreset').addEventListener('click', () => send('editionPreset'));" : '');
        for (const lang of Object.keys(locales)) {
          const dict = config.locales[lang];
          if (file === locales[lang]) data = scoped(json({ ...JSON.parse(data), ...Object.fromEntries(Object.entries(dict).filter(([k]) => k.startsWith('guide.'))) }));
          if (file === (lang === 'en' ? 'media/index.html' : 'media/index.zh-cn.html')) data = once(data.toString(), '<!--EDITION_PRESET_ACTION-->', button ? `<button id="loadEditionPreset" type="button">${escapeHtml(dict['edition.loadPreset'])}</button>` : '');
        }
      }
      const dest = path.join(stage,file);
      await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.writeFile(dest,data,{flag:'wx'});
    }
    return await callback({ stage, pkg, config:runtime, files });
  } finally { await fs.rm(stage,{recursive:true,force:true}); }
}
async function build(edition) {
  await require('./audit').auditSource(ROOT);
  return withStage(edition, ({pkg,files}) => ({id:`${pkg.publisher}.${pkg.name}`,version:pkg.version,fileCount:files.length}));
}
if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => { if(args.length !== 1) throw new Error('Usage: node scripts/build.js public|enterprise'); console.log(await build(args[0])); })().catch(e => { console.error(e.message); process.exitCode=1; });
}
module.exports = { ROOT, runtimeFiles, safeRead, validateConfig, loadConfig, withStage, build };
