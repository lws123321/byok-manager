'use strict';
// node test/run-host-smoke.js [path-to-Code.exe-or-VS-Code-executable]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function codeExecutable(override) {
  if (override) return override;
  if (process.platform !== 'win32') return 'code';
  const cli = execFileSync('where.exe', ['code.cmd'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  return path.resolve(path.dirname(cli), '..', 'Code.exe');
}

function isolatedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (/^(?:VSCODE_|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key];
  return env;
}

function setupProfile(tmp) {
  const data = path.join(tmp, 'profile'), extensions = path.join(tmp, 'extensions'), workspace = path.join(tmp, 'workspace');
  for (const dir of [path.join(data, 'User'), extensions, workspace]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(data, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'files.simpleDialog.enable': true, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'chat.disableAIFeatures': true
  }));
  return { data, extensions, workspace, args: ['--user-data-dir', data, '--extensions-dir', extensions,
    '--shared-data-dir', path.join(tmp, 'shared'), '--use-inmemory-secretstorage'] };
}

function run() {
  const installed = process.argv[2] === '--installed';
  if (installed) assert.equal(process.argv.length, 5, 'Supply both VSIX paths');
  const code = codeExecutable(installed ? undefined : process.argv[2]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-host-smoke-'));
  try {
    const profile = setupProfile(tmp), result = path.join(tmp, 'assertions.json');
    let developmentRoot = path.resolve(__dirname, '..');
    const archives = process.argv[2] === '--installed' ? process.argv.slice(3) : [];
    let extraEnv = {};
    if (archives.length) {
      assert.equal(archives.length, 2, 'Supply the Public and Enterprise VSIX');
      // A test-only development extension hosts assertions without replacing either installed edition.
      developmentRoot = path.join(tmp, 'test-driver'); fs.mkdirSync(developmentRoot);
      fs.writeFileSync(path.join(developmentRoot, 'package.json'), JSON.stringify({ name: 'edition-smoke-driver', publisher: 'test', version: '1.0.0', engines: {vscode: '*'} }));
      const cli = args => {
        if (process.platform !== 'win32') return execFileSync('code', [...profile.args, ...args], {env: isolatedEnv(), encoding: 'utf8'});
        const root = path.dirname(code);
        const entry = ['', ...fs.readdirSync(root).filter(n => /^[\da-f]{10}$/i.test(n))].map(n => path.join(root, n, 'resources','app','out','cli.js')).find(p => fs.existsSync(p));
        assert.ok(entry, 'VS Code CLI not found');
        return execFileSync(code, [entry, ...profile.args, ...args], {env: {...isolatedEnv(), ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8', timeout: 60000});
      };
      for (const file of archives) cli(['--install-extension', path.resolve(file), '--force']);
      const ids = cli(['--list-extensions', '--show-versions']).trim().split(/\r?\n/).filter(line => line.endsWith('@' + require('../package.json').version)).map(x => x.split('@')[0]);
      assert.equal(ids.length, 2, 'Both edition packages must be installed in the isolated profile');
      extraEnv = {BYOK_TEST_INSTALLED_IDS: JSON.stringify(ids)};
    }
    const args = ['--new-window', '--wait', '--disable-updates', '--disable-workspace-trust', '--skip-welcome',
      '--skip-release-notes', '--locale=en', ...profile.args, '--extensionDevelopmentPath=' + developmentRoot,
      '--extensionTestsPath=' + path.join(__dirname, 'host-smoke.js'), profile.workspace];
    const outcome = spawnSync(code, args, { env: isolatedEnv({ ...extraEnv, BYOK_HOST_SMOKE_RESULT: result }), stdio: 'inherit', timeout: 100_000 });
    if (outcome.error) throw outcome.error;
    const report = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : {};
    assert.equal(report.passed, true, report.error || `Host did not finish the assertions (exit ${outcome.status})`);
    assert.equal(outcome.status, 0, 'VS Code exit status');
    console.log('PASS real extension host:', JSON.stringify(report));
  } finally {
    fs.rmSync(tmp, { force: true, recursive: true, maxRetries: 12, retryDelay: 250 });
  }
}
if (require.main === module) run();
module.exports = { codeExecutable, isolatedEnv, setupProfile };
