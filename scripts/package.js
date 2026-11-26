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
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="html" ContentType="text/html" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>\n`;
async function filesIn(directory) {
  const result = [];
  for (const entry of await fs.readdir(path.join(ROOT, directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not packaged.');
    const name = directory + '/' + entry.name;
    if (entry.isDirectory()) result.push(...await filesIn(name)); else if (entry.isFile()) result.push(name);
  }
  return result;
}
async function build(outDir = path.join(ROOT, 'dist')) {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const runtimeFiles = ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'README.md', 'README.zh-CN.md', 'LICENSE.txt', 'CHANGELOG.md', 'SUPPORT.md', 'SECURITY.md', ...await filesIn('src'), ...await filesIn('media')];
  const entries = await Promise.all(runtimeFiles.map(async name => ['extension/' + name, await fs.readFile(path.join(ROOT, name))]));
  const vsix = zip([['[Content_Types].xml', CONTENT_TYPES], ['extension.vsixmanifest', manifest({ ...pkg, description: JSON.parse(await fs.readFile(path.join(ROOT, 'package.nls.json'), 'utf8'))['extension.description'] })], ...entries]);
  const sourceFiles = [...runtimeFiles, 'TESTING.md', 'RELEASE.md', '.gitignore', '.vscodeignore', ...await filesIn('scripts'), ...await filesIn('test'), ...await filesIn('.vscode')];
  const source = zip(await Promise.all(sourceFiles.map(async name => [pkg.name + '/' + name, await fs.readFile(path.join(ROOT, name))])));
  await fs.mkdir(outDir, { recursive: true });
  const artifacts = [[`byok-manager-${pkg.version}.vsix`, vsix], [`byok-manager-source-${pkg.version}.zip`, source]];
  for (const [name, bytes] of artifacts) await fs.writeFile(path.join(outDir, name), bytes);
  const hashes = artifacts.map(([name, bytes]) => crypto.createHash('sha256').update(bytes).digest('hex') + '  ' + name).join('\n') + '\n';
  await fs.writeFile(path.join(outDir, 'SHA256SUMS.txt'), hashes, 'utf8');
  for (const [name, bytes] of artifacts) console.log(`${path.join(outDir, name)} (${bytes.length} bytes)`);
  return artifacts;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) { console.error('Usage: node scripts/package.js [--out DIR]'); process.exitCode = 1; }
  else build(args.length ? path.resolve(args[1]) : undefined).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { zip, crc32, manifest, build };
