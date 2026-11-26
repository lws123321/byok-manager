'use strict';
// Loaded by the real Extension Development Host, not the Node unit-test runner.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const pkg = require('../package.json');
const execute = (...args) => vscode.commands.executeCommand(...args);
const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
const managers = () => tabs().filter(tab => tab.input instanceof vscode.TabInputWebview && tab.label === 'BYOK Manager');

async function until(check, description) {
  const end = Date.now() + 15000;
  do { if (check()) return; await delay(100); } while (Date.now() < end);
  throw new Error(`${description}; tabs=${JSON.stringify(tabs().map(t => [t.label, t.input?.viewType, t.isActive]))}`);
}

exports.run = async () => {
  const result = process.env.BYOK_HOST_SMOKE_RESULT;
  assert.ok(result, 'Use the isolated run-host-smoke launcher');
  try {
    if (process.env.BYOK_TEST_INSTALLED_IDS) {
      const ids = JSON.parse(process.env.BYOK_TEST_INSTALLED_IDS);
      assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
      const instances = ids.map(id => vscode.extensions.getExtension(id));
      assert.ok(instances.every(ext => ext?.packageJSON.version === pkg.version));
      const commands = new Set(), views = new Set();
      const installedTabs = new Map();
      for (const ext of instances) {
        const manifest = ext.packageJSON, container = manifest.contributes.viewsContainers.activitybar[0];
        const [view] = manifest.contributes.views[container.id];
        assert.ok(!views.has(view.id)); views.add(view.id);
        await execute(`workbench.view.extension.${container.id}`);
        await execute(`${view.id}.focus`);
        await until(() => ext.isActive, 'sidebar should activate its own installed edition');
        for (const {command} of manifest.contributes.commands) {
          assert.ok(!commands.has(command), `colliding command: ${command}`);
          commands.add(command); assert.ok((await vscode.commands.getCommands(true)).includes(command));
        }
        const open = manifest.contributes.commands.find(c => c.command.endsWith('.open'));
        const isManager = t => t.input instanceof vscode.TabInputWebview && t.input.viewType === `mainThreadWebview-${container.id}`;
        assert.equal(tabs().filter(isManager).length, 0, 'sidebar alone must not open the manager');
        await execute(open.command);
        await until(() => tabs().some(t => t.isActive && isManager(t)), 'edition command should open its own editor');
        installedTabs.set(open.command, tabs().find(isManager));
        await execute(open.command);
        assert.equal(tabs().filter(isManager).length, 1);
      }
      for (const [open, tab] of installedTabs) {
        await execute(open);
        await until(() => tabs().some(t => t === tab && t.isActive), 'open must reveal the existing edition tab');
      }
      assert.equal(new Set([...installedTabs.values()].map(t => t.input.viewType)).size, 2);
      fs.writeFileSync(result, JSON.stringify({passed: true, vscode: vscode.version, installedEditions: 2, version: pkg.version, distinctManagers: 2}));
      return;
    }
    const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
    assert.ok(ext && path.relative(path.resolve(__dirname, '..'), ext.extensionPath) === '', 'testing the current checkout');
    const [container] = pkg.contributes.viewsContainers.activitybar;
    const [view] = pkg.contributes.views[container.id];
    await execute(`workbench.view.extension.${container.id}`);
    await execute(`${view.id}.focus`);
    await until(() => ext.isActive, 'focusing the sidebar should activate the extension');
    assert.equal(managers().length, 0, 'sidebar alone must not create an editor');
    for (const id of ['byokManager.open', 'byokManager.openGuide', 'byokManager.restore', 'byokManager.diagnose']) {
      assert.ok((await vscode.commands.getCommands(true)).includes(id), `missing ${id}`);
    }
    // Exercise the actual tree action, not just its command registration.
    await execute('list.focusFirst');
    await execute('list.select');
    await until(() => managers().length === 1, 'activating the first sidebar action should create the manager');
    const first = managers()[0];
    await execute('byokManager.diagnose');
    await until(() => vscode.window.activeTextEditor?.document.getText().includes(pkg.version), 'diagnostics must open a versioned report');
    await execute(`${view.id}.focus`);
    await execute('byokManager.open');
    await until(() => managers()[0]?.isActive, 'second open should reveal manager');
    assert.equal(managers().length, 1, 'second open created a duplicate editor');
    assert.equal(managers()[0], first, 'original tab was replaced');
    for (let i = 0; i < 2; i++) {
      await execute('byokManager.openGuide');
      // Getting Started has no dedicated public TabInput type. The install UI smoke
      // additionally checks the native category, localized step DOM and real CTA.
      await until(() => tabs().some(t => t.isActive && (t.label === 'Welcome' || t.label.includes(pkg.displayName)) &&
        !t.input), 'guide should open a native walkthrough tab');
      if (i === 0) await execute('workbench.action.closeActiveEditor');
    }
    fs.writeFileSync(result, JSON.stringify({ passed: true, vscode: vscode.version, extension: pkg.version, view: view.id,
      focusCalls: 2, openCalls: 2, guideOpens: 2, locale: vscode.env.language,
      managerTabs: managers().length, sameTab: true, diagnostics: true }));
  } catch (error) {
    fs.writeFileSync(result, JSON.stringify({ passed: false, error: error.stack })); throw error;
  }
};
