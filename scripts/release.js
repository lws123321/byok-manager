'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, withStage } = require('./build');
const { withCandidate } = require('./package');
const { auditSource, verifyVsix } = require('./audit');

function releaseManifest(pkg, publisher, repository) {
  if (pkg.publisher !== 'asong-dev' || pkg.name !== 'byok-manager' || (publisher !== undefined && publisher !== pkg.publisher)) throw new Error('Marketplace is restricted to the fixed Public identity.');
  const result = { ...pkg };
  if (repository) {
    let url;
    try { url = new URL(repository); } catch { throw new Error('Invalid BYOK_REPOSITORY.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('BYOK_REPOSITORY must be a public HTTPS repository URL without credentials.');
    result.repository = { type:'git', url:url.href };
  }
  return result;
}
function assertMayPublish(edition,env) {
  if (edition !== 'public' || env.BYOK_CONFIRM_PUBLISH !== 'yes') throw new Error('Only Public may publish, with BYOK_CONFIRM_PUBLISH=yes.');
}
function vsce(cli, args, cwd) {
  const result = spawnSync(process.execPath,[cli,...args],{cwd,stdio:'inherit'});
  if (result.error || result.status !== 0) throw new Error('Official vsce command failed.');
}
async function release(action, edition='public') {
  if (edition !== 'public' || !['package','publish'].includes(action)) throw new Error('Usage: node scripts/release.js package|publish public');
  if (action === 'publish') assertMayPublish(edition,process.env);
  const vsceRoot = path.join(ROOT,'node_modules','@vscode','vsce');
  let metadata;
  try { metadata = JSON.parse(await fs.readFile(path.join(vsceRoot,'package.json'),'utf8')); }
  catch { throw new Error('Install the official CLI: npm install --no-save --package-lock=false @vscode/vsce'); }
  if (metadata.name !== '@vscode/vsce') throw new Error('Expected locally installed @vscode/vsce.');
  const cli = path.resolve(vsceRoot,typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.vsce);
  if (!cli.startsWith(vsceRoot + path.sep)) throw new Error('Invalid official CLI path.');
  await auditSource(ROOT);
  return withStage(edition,async ({stage,pkg,files}) => {
    const manifest = releaseManifest(pkg,process.env.BYOK_PUBLISHER,process.env.BYOK_REPOSITORY);
    await fs.writeFile(path.join(stage,'package.json'),JSON.stringify(manifest,null,2)+'\n');
    const out = path.join(ROOT,'dist','marketplace');
    return withCandidate(out, async tmp => {
      const name = `${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`;
      const candidate = path.join(tmp,name);
      vsce(cli,['package','--no-dependencies','--out',candidate],stage);
      await verifyVsix(candidate,edition,manifest,{stage,files});
      // Publish the verified, privately staged file; do not accept someone else's package path.
      if (action === 'publish') vsce(cli,['publish','--packagePath',candidate],stage);
      const dest = path.join(out,name); await fs.rename(candidate,dest); return dest;
    });
  });
}
if (require.main === module) {
  (async () => { const args=process.argv.slice(2); if(args.length>2) throw new Error('Unexpected release arguments.'); console.log(await release(...args)); })().catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports = { releaseManifest, assertMayPublish, release };
