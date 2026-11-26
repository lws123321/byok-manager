'use strict';
// Release checks intentionally accept only this project's ordinary Git blobs and VSIX profile.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { inflateRawSync } = require('node:zlib');
const ROOT = path.resolve(__dirname, '..');
const MiB = 1024 * 1024;
const LIMIT = 16 * MiB;
const TOTAL = 128 * MiB;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const utf8 = new TextDecoder('utf-8', { fatal: true });
const instruction = ['commitMessageGeneration', 'instructions'].join('.');
const oldName = ['asong', 'byok', 'helper'].join('-');
const org = ['xy', 'g'].join('');
const credentials = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:github_pat_[a-z0-9_]{30,}|gh[pousr]_[a-z0-9]{30,}|sk-[a-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[a-z0-9-]{20,})/i;
const privatePath = /(?:^|\/)editions\/[^/]+\.local\.json$|(?:^|\/)(?:enterprise\.local|node_modules|dist|\.env(?:\..*)?|[^/]+\.(?:vsix|zip|tgz|7z|pem|key|p12|pfx)|enterprise\.(?:local\.)?json)(?:\/|$)/i;
function json(bytes, message) {
  try { return JSON.parse(utf8.decode(bytes)); } catch { throw new Error(message); }
}
async function regularFile(file, root, optional = false) {
  try {
    const st = await fs.lstat(file);
    check(st.isFile() && st.size <= LIMIT && (!root || await fs.realpath(file) === path.resolve(root, path.relative(root, file))), 'Unsafe or oversized input file');
    return await fs.readFile(file);
  } catch (err) {
    if (optional && err.code === 'ENOENT') return null;
    throw new Error('Missing, unsafe or unreadable audit input');
  }
}
async function privateMarkers(root) {
  const dir = path.join(root, 'editions/enterprise.local');
  const markers = new Set([oldName, instruction, org]);
  const add = (v, min = 4) => { if (typeof v === 'string' && v.trim().length >= min) markers.add(v.trim().toLowerCase()); };
  const bytes = await regularFile(path.join(dir, 'audit-markers.json'), root, true);
  if (bytes) {
    const list = json(bytes, 'Invalid private marker file');
    check(Array.isArray(list) && list.every(v => typeof v === 'string' && v.trim().length >= 3), 'Invalid private marker list');
    list.forEach(v => add(v, 3));
  }
  // Only the auditor uses these private values. Never return them to a stage or log them.
  const override = process.env.BYOK_ENTERPRISE_CONFIG;
  const configFile = override ? path.resolve(root, override) : path.join(dir, 'config.json');
  const config = await regularFile(configFile, override ? null : root, !override);
  if (config) {
    const cfg = json(config, 'Invalid private configuration');
    add(cfg.name); if (cfg.displayName !== 'BYOK Manager') add(cfg.displayName); add(cfg.preset?.name); add(cfg.auxiliaryModel);
    for (const alias of Object.keys(cfg.aliases || {})) add(alias);
    function strings(value, fn) {
      if (typeof value === 'string') fn(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, fn));
    }
    strings(cfg.preset, value => {
      if (/^https?:\/\//i.test(value)) { try { add(new URL(value).hostname); } catch { throw new Error('Invalid private provider URL'); } }
    });
    for (const model of cfg.preset?.models || []) add(model.id);
    for (const setting of cfg.settings || []) if (String(setting.key).includes(instruction)) strings(setting.value, v => add(v));
  }
  return [...markers].map(s => s.toLowerCase());
}
// Fingerprints permit checking known legacy provider/model/commit strings even in a
// public-only clone. A rolling prefilter keeps SHA-256 work proportional to hits.
const fingerprints = [
  [14,3355641756,'1900d31333a13ba61b13daa6'], [24,4026225453,'4308291207a30ecb728539bd'],
  [15,144013407,'14effeed5150fa6e17201c16'], [29,2609139894,'faf45e4e53a73a7225ddbab4'],
  [110,676103862,'2e18843cebe2195ddd815e7b'], [55,3588180425,'68ed23b048b9ac43d8cba79c'],
  [38,3997262067,'6d786084a186bc12230c0900']
].map(([n,rolling,digest]) => {
  let power = 1; for (let i=0; i<n; i++) power = Math.imul(power,31);
  return {n,rolling,digest,power};
});
function knownPrivate(text) {
  for (const {n,rolling,digest,power} of fingerprints) {
    let h=0;
    for (let i=0; i<text.length; i++) {
      h = (Math.imul(h,31) + text.charCodeAt(i) - (i >= n ? Math.imul(text.charCodeAt(i-n),power) : 0)) >>> 0;
      if (i+1 >= n && h === rolling && require('node:crypto').createHash('sha256').update(text.slice(i+1-n,i+1)).digest('hex').startsWith(digest)) return true;
    }
  }
  return false;
}
function scan(bytes, markers, context) {
  const text = bytes.toString('utf8');
  // Literal text in UTF-8 (including ASCII runs in binary files) or UTF-16LE.
  for (const candidate of bytes.includes(0) ? [text, bytes.toString('utf16le')] : [text]) {
    check(!credentials.test(candidate), `Credential marker in ${context}`);
    const lower = candidate.toLowerCase();
    check(!markers.some(m => lower.includes(m)) && !(markers.length && knownPrivate(lower)), `Private marker in ${context}`);
  }
}
function git(root, args, input) {
  try { return execFileSync('git', ['--no-replace-objects', ...args], { cwd: root, input, stdio: ['pipe','pipe','pipe'], maxBuffer: TOTAL }); }
  catch { throw new Error('Cannot inspect Git inventory or index blobs'); }
}
function paths(bytes) { return utf8.decode(bytes).split('\0').filter(Boolean); }
async function auditSource(root = ROOT) {
  root = await fs.realpath(root);
  check(git(root, ['rev-parse','--show-prefix']).toString().trim() === '', 'Audit must run at the repository root');
  const markers = await privateMarkers(root);
  const files = new Set(), hashes = new Set();
  function name(file) {
    check(!privatePath.test(file), 'Private path or build artifact in source inventory');
    scan(Buffer.from(file), markers, 'source path');
    files.add(file);
  }
  for (const entry of paths(git(root, ['ls-files','--stage','-z']))) {
    const m = /^(100644|100755) ([0-9a-f]{40,64}) 0\t([\s\S]+)$/.exec(entry);
    check(m, 'Unsupported or unresolved Git index entry');
    name(m[3]); hashes.add(m[2]);
  }
  const batch = hashes.size ? git(root, ['cat-file','--batch'], [...hashes].join('\n')+'\n') : Buffer.alloc(0);
  let cursor = 0;
  for (const hash of hashes) {
    const eol = batch.indexOf(10, cursor), header = batch.toString('ascii', cursor, eol).split(' '), size = Number(header[2]);
    check(eol >= cursor && header[0] === hash && header[1] === 'blob' && Number.isSafeInteger(size) && size <= LIMIT, 'Invalid or oversized staged blob');
    cursor = eol + 1;
    scan(batch.subarray(cursor, cursor + size), markers, 'Git index');
    cursor += size; check(batch[cursor++] === 10, 'Truncated Git index response');
  }
  check(cursor === batch.length, 'Invalid Git index response');
  for (const file of paths(git(root, ['ls-files','--others','--exclude-standard','-z']))) name(file);
  // A broad ignore rule must not conceal a release input. Use fixed exclusions, not
  // user/global ignore settings, for untracked workspace sources and docs.
  const skips = ['.git','node_modules','dist','.vscode-test','enterprise.local'];
  const extra = git(root, ['ls-files','--others','-z',...skips.map(d => '--exclude='+d+'/')]);
  for (const file of paths(extra)) if (!privatePath.test(file) && /\.(?:[cm]?[jt]sx?|jsonc?|md|ya?ml|py|html|css|svg|png|txt|ps1|sh)$/i.test(file)) name(file);
  for (const file of files) {
    const bytes = await regularFile(path.join(root, file), root, true);
    if (bytes) scan(bytes, markers, 'working tree');
  }
}

// Restrict ZIP to the two writers we use (store/deflate, optional signed data descriptors).
// No comments, extra fields, links, encryption, alternate names, gaps or overlapping records.
const crcTable = Uint32Array.from({ length: 256 }, (_, x) => {
  for (let n = 0; n < 8; n++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
  return x;
});
function crc32(bytes) {
  let x = 0xffffffff;
  for (const b of bytes) x = crcTable[(x ^ b) & 255] ^ (x >>> 8);
  return (x ^ 0xffffffff) >>> 0;
}
function safePath(name) {
  return /^[\w.\-\/\[\]]+$/.test(name) && name.split('/').every(p => p && !p.endsWith('.') && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(p));
}
function readZip(b) {
  const e = b.length - 22;
  const u16 = at => b.readUInt16LE(at), u32 = at => b.readUInt32LE(at);
  check(e >= 0 && u32(e) === 0x06054b50 && u32(e+4) === 0 && u16(e+20) === 0, 'Invalid ZIP end record');
  const count = u16(e+10), cd = u32(e+16);
  check(count > 0 && count <= 512 && count === u16(e+8) && cd + u32(e+12) === e, 'Invalid ZIP central directory');
  let pos = cd, total = 0;
  const names = new Set(), ranges = [], entries = new Map();
  for (let n = 0; n < count; n++) {
    check(pos+46 <= e && u32(pos) === 0x02014b50, 'Invalid ZIP central header');
    const flags = u16(pos+8), method = u16(pos+10), crc = u32(pos+16), compressed = u32(pos+20), size = u32(pos+24), len = u16(pos+28), local = u32(pos+42);
    check(!(flags & ~0x0808) && [0,8].includes(method) && u16(pos+30) === 0 && u16(pos+32) === 0 && u16(pos+34) === 0, 'Unsupported ZIP features');
    check(size <= LIMIT && (total += size) <= TOTAL && pos+46+len <= e && local+30 <= cd, 'Oversized or truncated ZIP');
    const attrs = u32(pos+38), kind = (attrs >>> 16) & 0xf000;
    check((kind === 0 || kind === 0x8000) && !(attrs & 0x410), 'Non-regular ZIP member');
    const nameBytes = b.subarray(pos+46,pos+46+len), name = utf8.decode(nameBytes);
    check(safePath(name), 'Unsafe ZIP member path');
    check(!names.has(name.toLowerCase()), 'Duplicate ZIP member'); names.add(name.toLowerCase());
    check(u32(local) === 0x04034b50 && u16(local+6) === flags && u16(local+8) === method && u16(local+26) === len && u16(local+28) === 0 && b.subarray(local+30,local+30+len).equals(nameBytes), 'ZIP local header mismatch');
    const descriptor = Boolean(flags & 8);
    const dataAt = local+30+len, end = dataAt+compressed;
    check(end+(descriptor ? 16 : 0) <= cd, 'Truncated ZIP member');
    for (const [delta,value] of [[0,crc],[4,compressed],[8,size]]) {
      check(u32(local+14+delta) === (descriptor ? 0 : value), 'ZIP local CRC/size header mismatch');
      if (descriptor) check(u32(end) === 0x08074b50 && u32(end+4+delta) === value, 'Invalid ZIP data descriptor');
    }
    ranges.push([local,end+(descriptor ? 16 : 0)]);
    const packed = b.subarray(dataAt,end);
    let bytes = packed;
    if (method === 8) {
      try {
        const result = inflateRawSync(packed,{maxOutputLength:Math.max(1,size),info:true});
        check(result.engine.bytesWritten === compressed, 'Unused ZIP deflate data'); bytes = result.buffer;
      } catch { throw new Error('Invalid ZIP deflate stream'); }
    }
    check(bytes.length === size && crc32(bytes) === crc, 'ZIP CRC or size mismatch');
    entries.set(name,bytes); pos += 46+len;
  }
  check(pos === e, 'Invalid ZIP directory length');
  let last = 0;
  for (const [start,end] of ranges.sort((a,c) => a[0]-c[0])) { check(last === start, 'Unexpected ZIP local data'); last = end; }
  check(last === cd, 'Unexpected ZIP local data');
  return entries;
}

// Small, non-expanding XML subset for the generated VSIX documents; no DTD, PI,
// comments, prefixes on elements, CDATA, namespace redeclarations or external URLs to resolve.
function xmlDocument(bytes) {
  const text = utf8.decode(bytes).replace(/^<\?xml version="1\.0" encoding="utf-8"\?>/i,'');
  const root = { children:[], text:'' }, stack = [root];
  const token = /<\/?[\w.-]+(?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/gy;
  const attr = /\s+([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  function decode(s) {
    check(!/&(?!(?:amp|lt|gt|apos|quot);)/.test(s), 'Unsupported XML entity');
    return s.replace(/&(amp|lt|gt|apos|quot);/g, (_,n) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[n]);
  }
  let cursor = 0;
  while (cursor < text.length) {
    const match = token.exec(text); check(match && match.index === cursor, 'Invalid manifest XML'); cursor = token.lastIndex;
    const s = match[0], parent = stack.at(-1);
    if (s.startsWith('</')) { check(s === `</${parent.name}>` && parent !== root, 'Unbalanced manifest XML'); stack.pop(); }
    else if (!s.startsWith('<')) { parent.text += decode(s); }
    else {
      const node = { name:/^<([\w.-]+)/.exec(s)[1], attrs:Object.create(null), children:[], text:'' };
      for (const [,key,,value] of s.matchAll(attr)) {
        check(!(key in node.attrs) && !(parent !== root && key.startsWith('xmlns')), 'Invalid XML attributes'); node.attrs[key] = decode(value);
      }
      parent.children.push(node); if (!s.endsWith('/>')) stack.push(node);
    }
  }
  check(stack.length === 1 && root.children.length === 1 && !root.text.trim(), 'Invalid manifest XML root');
  return root.children[0];
}
function only(parent, tag) {
  const found = parent.children.filter(c => c.name === tag);
  check(found.length === 1, 'Missing or duplicate manifest element: '+tag); return found[0];
}
const baseFiles = ['package.json','edition.json','package.nls.json','package.nls.zh-cn.json','README.md','README.zh-CN.md','CHANGELOG.md','LICENSE.txt','SECURITY.md','SUPPORT.md','src/extension.js','src/core.js','src/i18n.js','src/jsonc.js','media/app.js','media/key.svg','media/icon.png','media/index.html','media/index.zh-cn.html','media/style.css', ...['en','zh-cn'].flatMap(lang => ['provider','model','save'].map(step => `media/guide/${step}-${lang}.png`))];
const mime = { png:'image/png', svg:'image/svg+xml', md:'text/markdown', txt:'text/plain', json:'application/json', css:'text/css', js:'application/javascript', html:'text/html', vsixmanifest:'text/xml' };
function verifyMetadata(entries, actual, pkg) {
  const manifest = xmlDocument(entries.get('extension.vsixmanifest'));
  check(manifest.name === 'PackageManifest' && manifest.attrs.Version === '2.0.0' && manifest.attrs.xmlns === 'http://schemas.microsoft.com/developer/vsx-schema/2011', 'Invalid VSIX manifest schema');
  const meta = only(manifest,'Metadata'), id = only(meta,'Identity').attrs;
  check(id.Publisher === pkg.publisher && id.Id === pkg.name && id.Version === pkg.version, 'Unexpected VSIX identity');
  check(only(only(manifest,'Installation'),'InstallationTarget').attrs.Id === 'Microsoft.VisualStudio.Code', 'Invalid installation target');
  const engine = only(meta,'Properties').children.filter(p => p.attrs.Id === 'Microsoft.VisualStudio.Code.Engine');
  check(engine.length === 1 && engine[0].attrs.Value === pkg.engines.vscode, 'Invalid VS Code engine');
  const assets = new Map(Object.entries({ 'Microsoft.VisualStudio.Code.Manifest':'package.json','Microsoft.VisualStudio.Services.Icons.Default':pkg.icon,'Microsoft.VisualStudio.Services.Content.Details':'README.md','Microsoft.VisualStudio.Services.Content.License':'LICENSE.txt','Microsoft.VisualStudio.Services.Content.Changelog':'CHANGELOG.md' }));
  for (const a of only(manifest,'Assets').children) {
    const { Type, Path, Addressable } = a.attrs;
    check(a.name === 'Asset' && assets.has(Type) && Path === actual.get('extension/'+assets.get(Type)) && Addressable === 'true', 'Unexpected manifest asset'); assets.delete(Type);
  }
  check(!assets.size && only(meta,'Icon').text === actual.get('extension/'+pkg.icon) && only(meta,'License').text === actual.get('extension/LICENSE.txt'), 'Missing manifest asset');
  const types = xmlDocument(entries.get('[Content_Types].xml'));
  check(types.name === 'Types' && types.attrs.xmlns === 'http://schemas.openxmlformats.org/package/2006/content-types', 'Invalid content types schema');
  const seen = new Set();
  for (const node of types.children) {
    const ext = node.attrs.Extension?.replace(/^\./,'');
    check(node.name === 'Default' && Object.hasOwn(mime,ext) && !seen.has(ext) && node.attrs.ContentType === mime[ext], 'Invalid content type declaration'); seen.add(ext);
  }
  check(seen.size === Object.keys(mime).length, 'Missing content types');
}

const png = Buffer.from('89504e470d0a1a0a','hex');
function verifyResources(get, pkg, edition, config) {
  const guides = pkg.contributes?.walkthroughs;
  check(guides?.length === 1 && guides[0].steps?.length === 7 && new Set(guides[0].steps.map(s => s.id)).size === 7, 'Incomplete walkthrough');
  const screenshots = new Set();
  for (const [lang,nls,doc] of [['en','package.nls.json','README.md'],['zh-cn','package.nls.zh-cn.json','README.zh-CN.md']]) {
    const locale = json(get(nls),'Invalid NLS JSON');
    const resolve = s => {
      const key = /^%([^%]+)%$/.exec(s || '')?.[1];
      check(key && typeof locale[key] === 'string' && locale[key].trim(), 'Missing tutorial translation'); return locale[key];
    };
    resolve(guides[0].title); resolve(guides[0].description);
    for (const step of guides[0].steps) {
      resolve(step.title); resolve(step.description); resolve(step.media?.altText);
      const image = resolve(step.media?.image);
      check(/^media\/(?:guide|edition)\/[\w-]+\.png$/.test(image) && get(image)?.subarray(0,8).equals(png), 'Missing or invalid tutorial PNG'); screenshots.add(image);
    }
    const readme = get(doc).toString('utf8');
    for (const step of ['provider','model','save']) {
      const img = `media/guide/${step}-${lang}.png`;
      check(get(img)?.subarray(0,8).equals(png), 'Invalid README PNG');
      const repo = pkg.repository?.url?.replace(/(?:\.git)?\/?$/,'');
      const urls = [...readme.matchAll(/!\[[^\]\r\n]*\]\(([^)\s]+)\)/g)].map(m => m[1]);
      check(urls.includes(img) || urls.includes('./'+img) || (repo && urls.includes(repo+'/raw/HEAD/'+img)), 'Missing README tutorial image');
    }
    const html = get(lang === 'en' ? 'media/index.html' : 'media/index.zh-cn.html').toString();
    check(/\bid=["']loadEditionPreset["']/.test(html) === Boolean(config.features.presetButton), 'Inconsistent edition preset button');
  }
  check(get(pkg.icon)?.subarray(0,8).equals(png), 'Invalid extension icon PNG');
  for (const rel of screenshots) check(edition === 'enterprise' || rel.startsWith('media/guide/'), 'Unexpected private tutorial image');
  return screenshots;
}
function verifyConfig(c, edition, pkg) {
  check(c?.edition === edition && ['name','publisher','displayName'].every(k => c[k] === pkg[k]), 'Unexpected edition identity');
  check(typeof c.features?.presetButton === 'boolean' && Array.isArray(c.settings) && c.aliases && typeof c.aliases === 'object' && !Array.isArray(c.aliases), 'Invalid edition configuration');
  if (edition === 'public') {
    check(c.preset === null && !c.features.presetButton && c.auxiliaryModel === '' && !Object.keys(c.aliases).length, 'Private configuration in public edition');
    // Check the configuration actually shipped, including when called without a trusted stage.
    require('./build').validateConfig(c, 'public');
  }
  else check(c.preset?.models?.length > 0 && c.features.presetButton, 'Missing enterprise preset');
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key,v] of Object.entries(value)) {
      if (/^(?:api[-_]?key|(?:proxy-)?authorization|x-api-key|(?:access[-_]?)?token|secret|password)$/i.test(key)) {
        check(v === '' || /^(?:Bearer )?\$\{apiKey\}$/.test(v), 'Credential field in edition configuration');
      }
      visit(v);
    }
  }
  visit(c);
}
function marketplaceReadme(text, repository) {
  const base = repository?.replace(/(?:\.git)?\/?$/,'');
  if (!base) return text;
  return text.replace(/(!?\[[^\]\n]*\]\()((?:\.\/)?[\w.-]+(?:\/[\w.-]+)*)(\))/g, (_,s,rel,end) => s+base+(s.startsWith('!')?'/raw/HEAD/':'/blob/HEAD/')+rel.replace(/^\.\//,'')+end);
}
/** `stage` is a trusted extension staging directory. `files` is its caller-approved relative inventory. */
async function verifyVsix(file, edition, expectedPkg, options = {}) {
  const root = await fs.realpath(options.root || ROOT);
  check(['enterprise','public'].includes(edition) && expectedPkg?.version && expectedPkg.name && expectedPkg.publisher, 'Missing trusted edition or expected manifest');
  const id = expectedPkg.publisher+'.'+expectedPkg.name;
  check(id === (edition === 'public' ? 'asong-dev.byok-manager' : (options.expectedEnterpriseId || ['asong-local',oldName].join('.'))), 'Unexpected edition identity');
  const stat = await fs.lstat(file);
  check(stat.isFile() && stat.size <= TOTAL, 'Invalid or oversized ZIP file');
  const entries = readZip(await fs.readFile(file));
  const markers = edition === 'public' ? await privateMarkers(root) : [];
  const actual = new Map();
  for (const [name,bytes] of entries) {
    scan(Buffer.from(name),markers,'VSIX member name'); scan(bytes,markers,'VSIX member');
    const canonical = ({'extension/readme.md':'extension/README.md','extension/changelog.md':'extension/CHANGELOG.md'})[name] || name;
    actual.set(canonical,name);
  }
  const get = rel => entries.get(actual.get('extension/'+rel));
  const pkg = json(get('package.json'),'Invalid package manifest');
  check(isDeepStrictEqual(pkg,expectedPkg), 'Unexpected packaged extension manifest');
  check(!Object.keys(pkg.dependencies || {}).length && !Object.keys(pkg.optionalDependencies || {}).length && pkg.main === './src/extension.js', 'Unexpected runtime dependencies or entry point');
  const config = json(get('edition.json'),'Invalid edition configuration');
  verifyConfig(config,edition,pkg);
  const images = verifyResources(get,pkg,edition,config);
  const expected = [...baseFiles, ...[...images].filter(s => s.startsWith('media/edition/'))];
  if (options.files) check(isDeepStrictEqual([...options.files].sort(), [...expected].sort()), 'Unexpected staging inventory');
  check(actual.size === expected.length+2 && [...expected.map(f=>'extension/'+f),'extension.vsixmanifest','[Content_Types].xml'].every(key => actual.has(key)), 'Unexpected VSIX inventory');
  verifyMetadata(entries,actual,pkg);
  const stage = options.stage || options.stageDir;
  if (stage) {
    const dir = await fs.realpath(stage);
    for (const rel of expected) {
      const bytes = await regularFile(path.join(dir,rel), dir);
      if (rel === 'package.json') { check(isDeepStrictEqual(json(bytes,'Invalid stage manifest'),pkg), 'Stale stage manifest'); continue; }
      const shipped = get(rel);
      if (bytes.equals(shipped)) continue;
      check(rel === 'README.md' && Buffer.from(marketplaceReadme(utf8.decode(bytes),pkg.repository?.url)).equals(shipped), 'VSIX differs from trusted stage');
    }
  }
  return { entryCount:entries.size };
}

module.exports = { auditSource, verifyVsix };

async function main(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === 'source')) {
    await auditSource(ROOT); console.log('Source inventory, index and working tree verified.'); return;
  }
  const [action,archive,id,version,repository] = args;
  check(action === 'verify' && [4,5].includes(args.length), 'Usage: node scripts/audit.js source | verify ARCHIVE EXTENSION_ID VERSION [REPOSITORY]');
  const edition = id === 'asong-dev.byok-manager' ? 'public' : 'enterprise';
  await require('./build').withStage(edition, async ({ stage, pkg, files }) => {
    check(pkg.publisher+'.'+pkg.name === id && pkg.version === version, 'Requested release differs from this checkout');
    if (repository) {
      let url; try { url = new URL(repository); } catch { throw new Error('Invalid repository URL'); }
      check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Invalid repository URL');
      pkg.repository = { type:'git', url:url.href };
      await fs.writeFile(path.join(stage,'package.json'), JSON.stringify(pkg,null,2)+'\n');
    }
    const result = await verifyVsix(archive,edition,pkg,{root:ROOT,stage,files});
    console.log(`${edition} VSIX: ${result.entryCount} entries verified against trusted stage.`);
  });
}
if (require.main === module) main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exitCode = 1; });
