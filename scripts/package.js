'use strict';
// Dependency-free local VSIX/source ZIP builder. Does not sign or publish.
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  if (entries.length > 65535) throw new Error('ZIP64 is not supported.');
  const chunks = [], central = [], names = new Set(); let offset = 0;
  // Fixed timestamp and sorted entries make repeated builds reproducible.
  const dosDate = ((2026 - 1980) << 9) | (11 << 5) | 26;
  for (const [name, input] of [...entries].sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
    if (names.has(name) || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) throw new Error('Unsafe/duplicate ZIP path: ' + name);
    names.add(name);
    const nameBytes = Buffer.from(name, 'utf8'); const data = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 }); const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10);
    record.writeUInt16LE(dosDate, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes); offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}
const xml = s => String(s).replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]));
function manifest(pkg) {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}" />
    <DisplayName>${xml(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description)}</Description>
    <Icon>extension/media/icon.png</Icon>
    <Tags>BYOK,configuration,customendpoint</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
  </Assets>
</PackageManifest>\n`;
}
const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="html" ContentType="text/html" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>\n`;
const { runtimeFiles, safeRead, withStage } = require('./build');
const { auditSource, verifyVsix } = require('./audit');
const sourceFiles = Object.freeze([...runtimeFiles, 'editions/public.json', 'editions/enterprise.example.json',
  'TESTING.md','RELEASE.md','.gitignore','.vscodeignore','.vscode/launch.json',
  'scripts/audit.js','scripts/build.js','scripts/package.js','scripts/release.js',
  'test/core.test.js','test/discovery.test.js','test/extension.test.js','test/release.test.js','test/webview.test.js','test/build-editions.test.js','test/audit.test.js',
  'test/browser-smoke.js','test/host-smoke.js','test/run-host-smoke.js','test/install-onboarding.js','test/compare-legacy.js','test/verify_vsix.py']);

// Write/verify on the output volume; rename only verified bytes into the public-facing location.
async function withCandidate(outDir, job) {
  await fs.mkdir(outDir, {recursive:true});
  const tmp = await fs.mkdtemp(path.join(outDir,'.candidate-'));
  try { return await job(tmp); } finally { await fs.rm(tmp,{recursive:true,force:true}); }
}
async function build(edition = 'public', options = {}) {
  if (options.source && edition !== 'public') throw new Error('Only the public source archive is distributable.');
  await auditSource(ROOT);
  const outDir = path.resolve(options.outDir || path.join(ROOT,'dist',edition));
  return withStage(edition, async ({stage,pkg,files}) => withCandidate(outDir, async tmp => {
    const entries = await Promise.all(files.map(async f => ['extension/'+f,await safeRead(stage,f)]));
    const nls = JSON.parse(await safeRead(stage,'package.nls.json'));
    const name = `${pkg.publisher}.${pkg.name}-${pkg.version}.vsix`;
    const vsix = zip([['[Content_Types].xml',CONTENT_TYPES],['extension.vsixmanifest',manifest({...pkg,description:nls['extension.description']})],...entries]);
    const candidate = path.join(tmp,name);
    await fs.writeFile(candidate,vsix);
    await verifyVsix(candidate,edition,pkg,{stage,files,expectedEnterpriseId:options.expectedEnterpriseId});
    const artifacts = [[name,vsix]];
    if (options.source) {
      const sourceName = `${pkg.name}-source-${pkg.version}.zip`;
      const bytes = zip(await Promise.all(sourceFiles.map(async f => [pkg.name+'/'+f,await safeRead(ROOT,f)])));
      await fs.writeFile(path.join(tmp,sourceName),bytes); artifacts.push([sourceName,bytes]);
    }
    const sums = artifacts.map(([f,b]) => `${crypto.createHash('sha256').update(b).digest('hex')}  ${f}\n`).join('');
    await fs.writeFile(path.join(tmp,'SHA256SUMS.txt'),sums);
    for (const f of [...artifacts.map(([f]) => f),'SHA256SUMS.txt']) await fs.rename(path.join(tmp,f),path.join(outDir,f));
    return artifacts.map(([f]) => path.join(outDir,f));
  }),options);
}
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2); let edition='public', outDir, source=false;
    if (args[0] && !args[0].startsWith('--')) edition=args.shift();
    while (args.length) {
      const arg=args.shift();
      if(arg==='--out' && args[0] && !outDir) outDir=path.resolve(args.shift());
      else if(arg==='--source' && !source) source=true;
      else throw new Error('Usage: node scripts/package.js [public|enterprise] [--out DIR] [--source]');
    }
    for (const f of await build(edition,{outDir,source})) console.log(f);
  })().catch(e => {console.error(e.message);process.exitCode=1;});
}
module.exports = { zip, crc32, manifest, build, withCandidate, sourceFiles };
