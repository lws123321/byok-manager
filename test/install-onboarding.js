'use strict';
// Windows Desktop; external playwright-core only. Usage:
// node test/install-onboarding.js candidate.vsix [previous-same-publisher.vsix]
// BYOK_ZH_PACK: optional, path to an installed Simplified Chinese pack (read-only).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const { codeExecutable, isolatedEnv, setupProfile } = require('./run-host-smoke');
const pkg = require('../package.json');
const guide = pkg.contributes.walkthroughs.find(w => w.id === 'userGuide');
const code = codeExecutable(process.env.BYOK_CODE_EXE);
const [candidate, previous] = process.argv.slice(2).map(p => path.resolve(p));
const texts = lang => lang === 'en' ? require('../package.nls.json') : require('../package.nls.zh-cn.json');
const titleSelector = 'h2[x-category-title-for$="#userGuide"]';
const tabSelector = '.tabs-container .tab';
const guideTab = page => page.locator(tabSelector).filter({ hasText: /^(Welcome|Walkthrough:.*BYOK)/ });
const observationMs = 7000; // Native contribution registration includes a 5s treatment timeout.

async function waitFor(fn, what, timeout = 20000) {
  const end = Date.now() + timeout;
  do { const value = await fn(); if (value) return value; await delay(100); } while (Date.now() < end);
  throw Error('Timed out: ' + what);
}

function cli(profile, ...args) {
  // Invoke the same entry point as code.cmd, without shell-quoting user paths.
  const root = path.dirname(code);
  const entry = ['', ...fs.readdirSync(root).filter(n => /^[0-9a-f]{10}$/i.test(n))]
    .map(n => path.join(root, n, 'resources', 'app', 'out', 'cli.js')).find(p => fs.existsSync(p));
  assert.ok(entry, 'Cannot locate installed VS Code CLI');
  return execFileSync(code, [entry, ...profile.args, ...args], { env: { ...isolatedEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 });
}

async function desktop(profile, locale, check) {
  const optionsFile = path.join(profile.data, 'User', 'settings.json');
  const options = JSON.parse(fs.readFileSync(optionsFile, 'utf8'));
  fs.writeFileSync(optionsFile, JSON.stringify({ ...options, 'workbench.startupEditor': 'welcomePage',
    'workbench.welcomePage.experimentalOnboarding': false }));
  fs.writeFileSync(path.join(profile.data, 'User', 'keybindings.json'), JSON.stringify([
    { key: 'ctrl+alt+f9', command: 'workbench.extensions.action.installVSIX' },
    { key: 'ctrl+alt+f10', command: 'byokManager.openGuide' },
    { key: 'ctrl+alt+f11', command: 'welcome.showAllWalkthroughs' }
  ]));
  const marker = path.join(profile.data, 'DevToolsActivePort');
  fs.rmSync(marker, { force: true });
  const child = spawn(code, [...profile.args, '--new-window', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--disable-updates', '--disable-workspace-trust', '--skip-release-notes', '--skip-welcome', '--locale=' + locale, profile.workspace],
  { env: isolatedEnv(), stdio: 'ignore' });
  const exit = new Promise(resolve => child.on('close', resolve));
  let browser, page;
  try {
    const port = await waitFor(() => fs.existsSync(marker) && Number(fs.readFileSync(marker, 'utf8').split('\n')[0]), 'isolated desktop debugging port');
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 15000 });
    page = await waitFor(() => browser.contexts().flatMap(c => c.pages()).find(p => /workbench\.html/.test(p.url())), 'isolated workbench renderer');
    page.on('pageerror', e => console.error('Workbench error:', e.message));
    page.on('console', msg => { if (msg.type() === 'error' && /walkthrough|asong|BYOK|\.map is not|is not a function|Cannot read/i.test(msg.text())) console.error('Workbench:', msg.text()); });
    page.setDefaultTimeout(15000);
    await page.locator('.monaco-workbench').waitFor();
    try { await check(page); } catch (error) {
      console.error('Workbench at failure:', (await page.locator('body').innerText({ timeout: 3000 })).slice(-3000));
      throw error;
    }
  } finally {
    if (page) await page.keyboard.press('Control+Shift+w').catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (await Promise.race([exit.then(() => true), delay(3500, false)]) === false) child.kill();
    await exit;
  }
}

async function palette(page, label, execute = true) {
  // Refocus the workbench (the manager may still have keyboard focus inside its iframe).
  await page.locator('.part.sidebar .title-label').first().click();
  await page.keyboard.press('Control+Shift+p');
  await page.locator('.quick-input-widget input:visible').fill('>' + label);
  const option = page.locator('.quick-input-list .monaco-list-row:visible').filter({ hasText: label }).first();
  await option.waitFor();
  if (execute) await option.click(); else await page.keyboard.press('Escape');
}

async function noGuide(page, phase) {
  const until = Date.now() + observationMs;
  do {
    assert.equal(await guideTab(page).count(), 0, 'unexpected BYOK tab during ' + phase);
    assert.equal(await page.locator(titleSelector).count(), 0, 'unexpected native guide during ' + phase);
    await delay(150);
  } while (Date.now() < until);
  console.log(`${phase}: no guide during ${observationMs}ms observation`);
}

async function clickInstall(page, file) {
  // A private shortcut invokes the same native Install from VSIX action as the
  // Extensions menu, independent of menu visibility and display language.
  await page.keyboard.press('Control+Alt+F9');
  await page.locator('.quick-input-widget .quick-input-titlebar').getByText('Install from VSIX', { exact: true }).waitFor();
  await page.locator('.quick-input-list .monaco-list-row:visible').first().waitFor();
  const input = page.locator('.quick-input-widget input:visible');
  await input.fill(file);
  const match = page.locator('.quick-input-list .monaco-list-row:visible').filter({ hasText: path.basename(file) }).first();
  await match.waitFor();
  await input.press('Enter');
  if (await input.waitFor({ state: 'hidden', timeout: 1500 }).then(() => false, () => true)) {
    await match.dblclick();
    const accept = page.getByRole('button', { name: 'Install', exact: true });
    if (await accept.isVisible()) await accept.click();
  }
  await input.waitFor({ state: 'hidden' });
  // Some Desktop builds ask for trust when installing an unsigned local VSIX.
  // This fixture is explicitly supplied by the caller and affects only this profile.
  const trust = page.getByRole('button', { name: /trust publisher.*install|trust.*install/i });
  if (await trust.waitFor({ timeout: 2500 }).then(() => true, () => false)) await trust.click();
}

async function verifyGuide(page, lang) {
  const nls = texts(lang);
  await page.locator(titleSelector).waitFor();
  assert.equal(await page.locator(titleSelector).innerText(), nls['guide.title']);
  const fullId = await page.locator(titleSelector).getAttribute('x-category-title-for');
  const steps = page.locator('[data-step-id^="' + fullId + '#"]');
  assert.deepEqual(await steps.locator('h3').allInnerTexts(), guide.steps.map(s => nls[s.title.slice(1, -1)]));
  for (const step of guide.steps) {
    const row = steps.filter({ has: page.locator(`[x-step-title-for="${fullId}#${step.id}"]`) });
    if (await row.getAttribute('aria-expanded') !== 'true') await row.locator('h3').click();
    const expected = nls[step.media.image.slice(1, -1)];
    await page.waitForFunction(name => [...document.images].some(img => img.currentSrc.endsWith(name) && img.complete && img.naturalWidth > 0), expected, { timeout: 10000 });
  }
  const open = steps.filter({ has: page.locator(`[x-step-title-for="${fullId}#open"]`) });
  await open.locator('h3').click();
  await open.getByRole('button', { name: nls['command.open'], exact: true }).click();
  await page.locator('.tab.active').getByText('BYOK Manager', { exact: true }).waitFor();
  console.log(`walkthrough: ${lang}, ${fullId}, ${await steps.count() || guide.steps.length} localized steps; decoded images; manager tab after real CTA`);
}

async function run(tmp) {
  assert.ok(candidate && fs.existsSync(candidate), 'Supply an existing candidate VSIX');
  const ui = setupProfile(path.join(tmp, 'fresh-ui'));
  const file = path.join(ui.workspace, 'candidate.vsix'); fs.copyFileSync(candidate, file);
  console.log('Desktop', cli(ui, '--version').trim(), 'candidate', path.basename(candidate));
  await desktop(ui, 'en', async page => {
    await page.bringToFront();
    // Wait for the native Getting Started service to subscribe to live installs.
    // Do not open any guide or install the candidate until it is listening.
    await page.keyboard.press('Control+Alt+F11');
    await page.locator('.quick-input-list .monaco-list-row:visible').first().waitFor();
    await page.keyboard.press('Escape');
    await clickInstall(page, file);
    const auto = await page.locator(titleSelector).waitFor({ timeout: observationMs }).then(() => true, () => false);
    console.log(`fresh UI install: auto-visible=${auto}, focus=${await page.evaluate(() => document.hasFocus())}, tabs=${JSON.stringify(await page.locator(tabSelector).allInnerTexts())}`);
    console.log('Installed from picker:', cli(ui, '--list-extensions', '--show-versions').trim());
    const manifestFile = fs.readdirSync(ui.extensions).filter(s => s.includes(pkg.name)).map(s => path.join(ui.extensions, s, 'package.json')).find(s => fs.existsSync(s));
    assert.ok(manifestFile, 'VSIX must be present in the isolated extensions directory');
    console.log('Installed walkthrough ID:', JSON.parse(fs.readFileSync(manifestFile, 'utf8')).contributes.walkthroughs?.[0]?.id);
    assert.ok(auto, 'eligible in-window VSIX install did not show the native guide');
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('Control+w');
      await page.locator(titleSelector).waitFor({ state: 'hidden' });
      await palette(page, 'BYOK: ' + texts('en')['command.openGuide']);
      await page.locator(titleSelector).waitFor();
    }
    console.log('Manual Command Palette guide opens: 2');
    await verifyGuide(page, 'en');
    // Close the actual guide tab explicitly rather than relying on the active
    // editor: the manager may open a model configuration editor asynchronously.
    const welcome = page.locator(tabSelector).filter({ hasText: /Welcome|Walkthrough/i });
    if (await welcome.count()) await welcome.first().click({ button: 'middle' });
    await welcome.waitFor({ state: 'detached' });
  });
  const installed = cli(ui, '--list-extensions', '--show-versions').trim().split(/\r?\n/).find(s => s.includes(`.${pkg.name}@`));
  assert.ok(installed, 'installed candidate identity and version');
  await desktop(ui, 'en', async page => {
    await palette(page, 'BYOK: ' + texts('en')['command.openGuide'], false);
    await noGuide(page, 'restart with walkthrough explicitly closed');
  });
  const offline = setupProfile(path.join(tmp, 'offline'));
  cli(offline, '--install-extension', candidate);
  assert.ok(cli(offline, '--list-extensions', '--show-versions').includes(installed));
  await desktop(offline, 'en', async page => {
    await palette(page, 'BYOK: ' + texts('en')['command.openGuide'], false);
    await noGuide(page, 'first launch after offline CLI install');
  });
  if (previous) {
    const upgrade = setupProfile(path.join(tmp, 'upgrade'));
    cli(upgrade, '--install-extension', previous);
    const prior = cli(upgrade, '--list-extensions', '--show-versions').trim();
    assert.ok(prior.split(/\r?\n/).some(s => s.startsWith(installed.split('@')[0] + '@') && s !== installed), 'previous release must have same identity and a different version');
    const oldDir = fs.readdirSync(upgrade.extensions).find(name => name === prior.replace('@', '-'));
    const hadGuide = JSON.parse(fs.readFileSync(path.join(upgrade.extensions, oldDir, 'package.json'), 'utf8')).contributes.walkthroughs?.some(w => w.id === 'userGuide') || false;
    const update = path.join(upgrade.workspace, 'candidate.vsix'); fs.copyFileSync(candidate, update);
    await desktop(upgrade, 'en', async page => {
      await palette(page, 'BYOK: ' + texts('en')['command.open'], false);
      await page.keyboard.press('Control+Alt+F11');
      if (hadGuide) await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: /BYOK/ }).first().waitFor();
      else await page.locator('.quick-input-list .monaco-list-row:visible').first().waitFor();
      await page.keyboard.press('Escape');
      await clickInstall(page, update);
      const shown = await page.locator(titleSelector).waitFor({ timeout: observationMs }).then(() => true, () => false);
      console.log(`UI upgrade from ${prior} to ${installed}: priorGuide=${hadGuide}, native guide visible=${shown}, observation ${observationMs}ms`);
      assert.equal(shown, !hadGuide, 'initialized, focused Desktop should only auto-open a newly introduced walkthrough');
    });
    assert.ok(cli(upgrade, '--list-extensions', '--show-versions').includes(installed), 'upgrade persisted');
  }
  if (process.env.BYOK_ZH_PACK) {
    const zh = setupProfile(path.join(tmp, 'chinese'));
    const source = path.resolve(process.env.BYOK_ZH_PACK);
    const pack = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    assert.equal(pack.name, 'vscode-language-pack-zh-hans');
    // Seed only this isolated profile's language-pack index with Microsoft's
    // actual installed translations; Desktop builds its own NLS message cache.
    const copy = path.join(zh.extensions, path.basename(source));
    fs.cpSync(source, copy, { recursive: true });
    const translations = Object.fromEntries(pack.contributes.localizations[0].translations.map(t => [t.id, path.join(copy, t.path)]));
    const hash = require('node:crypto').createHash('sha256').update(fs.readFileSync(translations.vscode)).digest('hex');
    fs.writeFileSync(path.join(zh.data, 'languagepacks.json'), JSON.stringify({ 'zh-cn': { hash, translations,
      extensions: [{ extensionIdentifier: { id: `${pack.publisher}.${pack.name}` }, version: pack.version }] } }));
    console.log('Desktop zh-cn: isolated copy of', pack.name, pack.version);
    cli(zh, '--install-extension', candidate);
    await desktop(zh, 'zh-cn', async page => {
      // A cold Desktop may display the built-in Welcome page if the palette
      // command beats asynchronous contribution registration. Wait for the real
      // localized entry, dismiss the picker, then invoke the extension command.
      await page.keyboard.press('Control+Alt+F11');
      await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: texts('zh-cn')['guide.title'] }).waitFor();
      await page.keyboard.press('Escape');
      await palette(page, 'BYOK: ' + texts('zh-cn')['command.openGuide']);
      await verifyGuide(page, 'zh-cn');
    });
  } else console.log('SKIP zh-cn Desktop: BYOK_ZH_PACK not supplied');
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-onboarding-'));
run(tmp).catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }));
