'use strict';
// node test/browser-smoke.js; set PLAYWRIGHT_CORE_PATH for an external install,
// CHROMIUM_PATH for a local Chromium executable (defaults to installed Edge on Windows).
// Pass --screenshots to regenerate the six bilingual media/guide PNGs instead of running the smoke matrix.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const { ByokTool } = require('../src/extension');
const root = path.resolve(__dirname, '..');
const origin = 'http://byok.test'; // All URLs are fulfilled locally; no HTTP server or provider needed.
const widths = [320, 400, 540, 720, 850, 1024, 1200, 1600];
const models = Array.from({ length: 12 }, (_, i) => ({
  id: `example/${i}-${'long-id-'.repeat(8)}model`, name: `Fixture ${i}`, apiType: 'responses', contextWindow: 32768,
  maxInputTokens: 28672, maxOutputTokens: 4096, toolCalling: true, vision: true, thinking: true, supportsReasoningEffort: ['low', 'high']
}));
const state = { type: 'state', env: { version: 'test', openJson: true, provider: true, trusted: true, desktop: true },
  groups: [{ name: 'fixture', count: models.length }], selected: 'fixture', draft: { name: 'fixture', apiType: 'messages',
    defaultUrl: 'https://example.invalid/v1', modelsText: JSON.stringify(models) }, configPath: '/synthetic/profile/chatLanguageModels.json' };
const emit = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const list = page => page.locator('#modelsText').evaluate(el => JSON.parse(el.value));
const palettes = {
  light: { background: '#ffffff', foreground: '#212121', field: '#f1f1f1', button: '#0065ae' },
  dark: { background: '#1e1e1e', foreground: '#ddddee', field: '#333333', button: '#0e639c' },
  'high-contrast': { background: '#000000', foreground: '#ffffff', field: '#101010', button: '#151580' }
};

async function checkLayout(page, width, chinese) {
  await page.setViewportSize({ width, height: 640 });
  const main = page.locator('main');
  const footer = async () => {
    const boxes = [];
    for (const id of ['apply', 'restore']) {
      const box = await page.locator('#' + id).boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.x + box.width <= width + 1 &&
        box.y >= 0 && box.y + box.height <= 641, `footer #${id} outside viewport: ${JSON.stringify(box)}`);
      await page.locator('#' + id).click({ trial: true });
      boxes.push(box);
    }
    return boxes;
  };
  await main.evaluate(el => el.scrollTop = 0);
  const before = await footer();
  const row = page.locator('#modelList .model-item').first();
  await row.scrollIntoViewIfNeeded();
  const visible = await row.innerText();
  for (const value of [models[0].id, models[0].name, 'Responses', '32,768', '28,672', '4,096', 'low', 'high',
    ...(chinese ? ['工具', '视觉', '思考'] : ['Tools', 'Vision', 'Reasoning'])]) assert.ok(visible.includes(value), `missing visible model field '${value}' in ${visible}`);
  for (const action of await row.getByRole('button').all()) await action.click({ trial: true });
  const atBottom = await main.evaluate(el => {
    el.scrollTop = el.scrollHeight;
    return { bottom: el.scrollTop, pageScroll: document.scrollingElement.scrollTop, overflow: Math.max(el.scrollWidth - el.clientWidth,
      document.documentElement.scrollWidth - innerWidth, document.querySelector('footer').scrollWidth - document.querySelector('footer').clientWidth) };
  });
  assert.ok(atBottom.bottom > 200 && !atBottom.pageScroll, `main did not scroll independently: ${JSON.stringify(atBottom)}`);
  assert.ok(atBottom.overflow <= 1, `horizontal overflow: ${atBottom.overflow}px`);
  assert.deepEqual(await footer(), before, 'footer moved while scrolling');
}

async function crud(page, chinese) {
  const byId = id => page.locator('#' + id);
  const row = () => page.locator('#modelList .model-item').filter({ has: page.getByText('smoke-created', { exact: true }) });
  const existing = await list(page);
  await byId('createModel').click();
  await byId('editId').fill('smoke-created');
  await byId('editName').fill('Smoke created');
  await byId('editContext').fill('32768');
  await byId('editOutput').fill('4096');
  await byId('saveModel').click();
  assert.equal((await list(page)).length, existing.length + 1);
  assert.equal(await byId('saveState').getAttribute('data-state'), 'dirty');
  await byId('searchModels').fill('smoke-created');
  assert.equal(await page.locator('#modelList .model-item').count(), 1);
  await row().getByRole('button', { name: chinese ? /^编辑/ : /^Edit/ }).click();
  await byId('editName').fill('Renamed fixture');
  await byId('saveModel').click();
  assert.equal((await list(page)).find(m => m.id === 'smoke-created').name, 'Renamed fixture');
  await row().getByRole('button', { name: chinese ? /^复制/ : /^Copy/ }).click();
  await byId('editId').fill('smoke-copy'); await byId('saveModel').click();
  assert.equal((await list(page)).at(-1).name, 'Renamed fixture');
  const copy = page.locator('#modelList .model-item').filter({ has: page.getByText('smoke-copy', { exact: true }) });
  await copy.getByRole('button', { name: chinese ? /^删除/ : /^Delete/ }).click();
  await byId('confirmDelete').click();
  const remaining = await list(page);
  assert.deepEqual(remaining.slice(0, -1), existing); assert.equal(remaining.at(-1).id, 'smoke-created');
  await byId('apply').click();
  const submitted = await page.evaluate(() => window.messages.at(-1));
  assert.equal(submitted.type, 'apply'); assert.deepEqual(JSON.parse(submitted.form.modelsText), remaining);
  assert.equal(await byId('saveState').getAttribute('data-state'), 'saving');
  await emit(page, { type: 'busy', value: true, operation: 'apply' });
  assert.equal(await byId('apply').isDisabled(), true);
  await emit(page, { type: 'notice', kind: 'error', text: 'Synthetic error' });
  await emit(page, { type: 'busy', value: false });
  assert.equal(await byId('apply').isEnabled(), true);
  assert.equal(await byId('saveState').getAttribute('data-state'), 'dirty', 'failed save must retain the draft');
  assert.equal(await byId('notice').innerText(), 'Synthetic error');
  await emit(page, { ...state, draft: { ...state.draft, modelsText: submitted.form.modelsText } });
  assert.equal(await byId('saveState').getAttribute('data-state'), 'clean', 'refresh after successful save should clear dirty state');
}

// Supply only host theme tokens, as VS Code does; the webview owns every layout and control.
const guideThemeCss = `:root {
  --vscode-editor-background: #1f1f1f; --vscode-foreground: #cccccc; --vscode-descriptionForeground: #aaaaaa;
  --vscode-input-background: #313131; --vscode-input-foreground: #cccccc; --vscode-input-border: #616161;
  --vscode-dropdown-background: #313131; --vscode-dropdown-foreground: #cccccc; --vscode-dropdown-border: #616161;
  --vscode-button-background: #0078d4; --vscode-button-foreground: white; --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc; --vscode-textLink-foreground: #4daafc; --vscode-focusBorder: #0078d4;
  --vscode-settings-headerBorder: #454545; --vscode-errorForeground: #f48771;
}`;

async function captureGuide(page, language) {
  const directory = path.join(root, 'media', 'guide');
  fs.mkdirSync(directory, { recursive: true });
  const output = step => ({ path: path.join(directory, `${step}-${language.toLowerCase()}.png`), caret: 'hide' });
  const byId = id => page.locator(`#${id}`);
  const provider = 'Demo Provider';
  const endpoint = 'https://api.example.invalid/v1';
  await emit(page, { type: 'state', env: state.env, groups: [], selected: '', configPath: 'chatLanguageModels.json',
    draft: { name: 'custom', defaultUrl: '', apiType: 'responses', modelsText: '[]' } });
  await emit(page, { type: 'busy', value: false });
  await byId('name').fill(provider);
  await byId('defaultUrl').fill(endpoint);
  await page.locator('.settings-section').first().getByRole('heading').click();
  const section = await page.locator('.settings-section').first().boundingBox();
  const { width, height } = page.viewportSize();
  await page.screenshot({ ...output('provider'), clip: { x: 0, y: section.y, width, height: section.height } });

  await byId('createModel').click();
  await byId('editId').fill('example-chat');
  await byId('editName').fill('Example Chat');
  await byId('editContext').fill('32768');
  await byId('editOutput').fill('4096');
  await byId('editThinking').selectOption('true');
  await byId('editTool').check();
  await byId('editEffort').fill('low, medium, high');
  await byId('modelDialog').getByRole('heading').click();
  // Round inward so a subpixel-centered dialog does not include slivers of backdrop text.
  const dialog = await byId('modelDialog').boundingBox();
  const x = Math.ceil(dialog.x), y = Math.ceil(dialog.y);
  await page.screenshot({ ...output('model'), clip: { x, y, width: Math.floor(dialog.x + dialog.width) - x,
    height: Math.floor(dialog.y + dialog.height) - y } });

  await byId('saveModel').click();
  await byId('auxiliaryModel').selectOption('example-chat');
  assert.equal(await byId('saveState').getAttribute('data-state'), 'dirty');
  await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const options = await page.locator('.settings-section.options').boundingBox();
  await page.screenshot({ ...output('save'), clip: { x: 0, y: options.y, width, height: height - options.y } });
}

async function scenario(browser, language, theme, screenshots = false) {
  const context = await browser.newContext({ locale: language, colorScheme: theme === 'light' ? 'light' : 'dark', serviceWorkers: 'block',
    ...(screenshots && { viewport: { width: 760, height: 760 }, deviceScaleFactor: 2 }) });
  try {
    const tool = new ByokTool({ env: { language }, Uri: { joinPath: path.join } }, { extensionPath: root, extensionUri: root });
    const html = await tool.html({ cspSource: origin, asWebviewUri: uri => `${origin}/${path.basename(uri)}` });
    const p = palettes[theme];
    const themeCss = screenshots ? guideThemeCss : `:root { --vscode-editor-background:${p.background}; --vscode-foreground:${p.foreground}; --vscode-settings-textInputBackground:${p.field}; --vscode-settings-dropdownBackground:rgb(90, 91, 92); --vscode-button-background:${p.button}; --vscode-textLink-foreground:rgb(11, 140, 221); --vscode-errorForeground:rgb(220, 60, 65); --vscode-settings-headerBorder:rgb(71, 72, 73); --vscode-contrastBorder:rgb(255, 238, 17); }`;
    const resources = new Map([['/', ['text/html', html]], ['/app.js', ['text/javascript', fs.readFileSync(path.join(root, 'media', 'app.js'))]],
      ['/style.css', ['text/css', themeCss + fs.readFileSync(path.join(root, 'media', 'style.css'), 'utf8')]]]);
    const problems = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url()); const resource = url.origin === origin && resources.get(url.pathname);
      if (!resource) { problems.push(`unexpected request: ${url}`); return route.abort(); }
      return route.fulfill({ contentType: resource[0], body: resource[1] });
    });
    await context.addInitScript(() => { window.messages = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message) }); });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') problems.push(msg.text()); });
    await page.goto(origin); await page.waitForFunction(() => window.messages.some(m => m.type === 'ready'));
    await page.evaluate(theme => document.body.classList.add('vscode-' + theme), theme);
    assert.equal((await page.locator('html').getAttribute('lang')).toLowerCase(), language.toLowerCase());
    if (screenshots) {
      await captureGuide(page, language);
      assert.deepEqual(problems, [], 'guide capture errors or unexpected requests');
      console.log(`Captured provider, model and save: ${language}`);
      return;
    }
    await emit(page, { type: 'busy', value: true });
    await emit(page, state);
    await emit(page, { type: 'busy', value: false });
    assert.deepEqual(problems, [], 'initializing the webview');
    const color = (selector, property) => page.locator(selector).first().evaluate((el, prop) => getComputedStyle(el)[prop], property);
    assert.equal(await color('#providers', 'backgroundColor'), 'rgb(90, 91, 92)');
    assert.equal(await color('footer', 'borderTopColor'), theme === 'high-contrast' ? 'rgb(255, 238, 17)' : 'rgb(71, 72, 73)');
    assert.equal(await color('.model-actions button', 'color'), 'rgb(11, 140, 221)');
    assert.equal(await color('.model-actions .danger', 'color'), 'rgb(220, 60, 65)');
    for (const width of widths) {
      try { await checkLayout(page, width, language !== 'en'); } catch (err) { throw new Error(`${language}/${theme}/${width}px: ${err.message}`, { cause: err }); }
    }
    await page.setViewportSize({ width: 320, height: 640 }); await crud(page, language !== 'en');
    assert.deepEqual(problems, [], 'page errors or unexpected requests');
    console.log(`PASS ${language}/${theme}: ${widths.join(',')}px + 320px CRUD`);
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, channel: process.env.CHROMIUM_PATH ? undefined : process.platform === 'win32' ? 'msedge' : undefined });
  console.log(`Chromium ${browser.version()}`);
  const screenshots = process.argv.includes('--screenshots');
  try {
    for (const language of ['en', 'zh-CN']) for (const theme of screenshots ? ['dark'] : Object.keys(palettes)) {
      await scenario(browser, language, theme, screenshots);
    }
  }
  finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
