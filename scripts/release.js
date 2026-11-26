'use strict';
// Run only from the maintainer's machine. Never reads or embeds access tokens.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const runtime = ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE.txt', 'SECURITY.md', 'SUPPORT.md', 'src', 'media', '.vscodeignore'];
function releaseManifest(pkg, publisher, repository) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(publisher || '') || publisher === 'asong-local') throw new Error('Set BYOK_PUBLISHER to your registered Marketplace publisher ID (not the local placeholder).');
  const output = { ...pkg, publisher };
  if (repository) {
    const u = new URL(repository);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('BYOK_REPOSITORY must be a public HTTPS repository URL with no credentials.');
    output.repository = { type: 'git', url: u.href };
  }
  return output;
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (exit ${result.status}).`);
}
function main() {
  const action = process.argv[2];
  if (!['package','publish'].includes(action)) throw new Error('Usage: node scripts/release.js package|publish');
  const manifest = releaseManifest(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')), process.env.BYOK_PUBLISHER, process.env.BYOK_REPOSITORY);
  // Use locally installed official vsce CLI; no shell interpolation or downloads.
  const vsceRoot = path.join(root, 'node_modules', '@vscode', 'vsce');
  if (!fs.existsSync(path.join(vsceRoot, 'package.json'))) throw new Error('Install the official CLI: npm install --no-save --package-lock=false @vscode/vsce');
  const vscePkg = JSON.parse(fs.readFileSync(path.join(vsceRoot,'package.json'),'utf8'));
  const cli = path.resolve(vsceRoot, typeof vscePkg.bin === 'string' ? vscePkg.bin : vscePkg.bin.vsce);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-release-'));
  try {
    for (const file of runtime) fs.cpSync(path.join(root,file), path.join(stage,file), {recursive:true});
    fs.writeFileSync(path.join(stage,'package.json'), JSON.stringify(manifest,null,2)+'\n');
    const out = path.join(root,'dist', `${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`);
    fs.mkdirSync(path.dirname(out), {recursive:true});
    run(process.execPath, [cli,'package','--no-dependencies','--out',out], stage);
    console.log(`Marketplace candidate: ${out}`);
    if (action === 'publish') {
      if (process.env.BYOK_CONFIRM_PUBLISH !== 'yes') throw new Error('Set BYOK_CONFIRM_PUBLISH=yes to explicitly publish. Otherwise upload the candidate manually.');
      // Uses vsce's own supported authentication, not an embedded token.
      run(process.execPath, [cli,'publish','--packagePath',out], stage);
    }
  } finally { fs.rmSync(stage,{recursive:true,force:true}); }
}
if (require.main === module) { try { main(); } catch (e) { console.error(e.message); process.exitCode=1; } }
module.exports = { releaseManifest };
