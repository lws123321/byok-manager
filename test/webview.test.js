'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../media/app.js'), 'utf8');

// Drive the production message and DOM listeners without a browser or extension host.
class Element extends EventTarget {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.value = ''; this.checked = false; this.textContent = ''; this.dataset = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  add(option) { this.append(option); }
  setAttribute(key, value) { this[key] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  fire(type) { this.dispatchEvent(new Event(type)); }
}
function webview() {
  const fields = new Map(), get = id => {
    if (!fields.has(id)) {
      const field = new Element();
      field.defaultChecked = field.checked = id === 'applyRecommendedSettings';
      fields.set(id, field);
    }
    return fields.get(id);
  };
  let receive, parses = 0, serializations = 0;
  const posts = [];
  vm.runInNewContext(app, {
    window: { addEventListener(_, callback) { receive = data => callback({ data }); } },
    document: { documentElement: { lang: 'en' }, getElementById: get, createElement: tag => new Element(tag), querySelectorAll: () => [...fields.values()] },
    Option: class { constructor(text, value) { Object.assign(this, { text, value }); } },
    acquireVsCodeApi: () => ({ postMessage: message => posts.push(message) }),
    JSON: { parse(text) { parses++; return JSON.parse(text); }, stringify(...args) { serializations++; return JSON.stringify(...args); } }
  });
  const state = (overrides = {}) => receive({ type: 'state', env: {}, groups: [], selected: 'local', draft: { name: 'local', apiType: 'responses', defaultUrl: '', modelsText: '[]' }, ...overrides });
  const done = () => receive({ type: 'busy', value: false });
  state(); done();
  return { get, receive, state, done, posts, work: () => [parses, serializations], status: () => get('saveState').textContent };
}

test('draft compares actual values with loaded values, including pending key and save options', () => {
  const w = webview(), name = w.get('name'), option = w.get('stateless');
  const clean = w.status(); assert.match(clean, /No unsaved changes/i);
  name.value = 'changed'; name.fire('input'); assert.match(w.status(), /Unsaved changes/i);
  name.value = 'local'; name.fire('input'); assert.equal(w.status(), clean);
  option.checked = true; option.fire('change'); assert.notEqual(w.status(), clean);
  w.receive({ type: 'key', pending: true }); option.checked = false; option.fire('change'); assert.notEqual(w.status(), clean);
  w.receive({ type: 'key', pending: false }); assert.equal(w.status(), clean);
});

test('saving locks immediately; cancellation, error, and unrelated operations do not commit the draft', () => {
  const w = webview(); w.get('name').value = 'draft'; w.get('name').fire('input'); const dirty = w.status();
  w.get('apply').fire('click'); w.get('apply').fire('click'); assert.equal(w.posts.filter(m => m.type === 'apply').length, 1);
  assert.match(w.status(), /saving/i); assert.equal(w.get('restore').disabled, true);
  w.done(); assert.equal(w.status(), dirty);
  w.get('apply').fire('click'); w.receive({ type: 'notice', kind: 'error', text: 'Save failed' }); w.done();
  assert.equal(w.get('notice').textContent, 'Save failed'); assert.match(w.status(), /unsaved/i);
  w.receive({ type: 'busy', value: true, operation: 'restore' }); w.get('apply').fire('click'); assert.equal(w.posts.filter(m => m.type === 'apply').length, 2); assert.doesNotMatch(w.status(), /saving/i);
  w.done(); w.get('apply').fire('click'); w.state(); w.done(); assert.match(w.status(), /No unsaved changes/i);
});

test('unsaved imports and new drafts are not disk baselines; cancelling group selection restores selection', () => {
  const w = webview(); w.get('providers').value = ''; w.get('providers').fire('change'); w.done(); assert.equal(w.get('providers').value, 'local');
  for (const draftKind of ['import', 'new']) {
    w.state({ selected: '', draftKind }); assert.match(w.status(), /unsaved/i); assert.doesNotMatch(w.status(), /No unsaved/i);
  }
  w.state(); assert.match(w.status(), /No unsaved changes/i);
});

test('failed reload keeps the edited form; a cancelled save reports cancellation without hiding host errors', () => {
  const w = webview(); w.get('name').value = 'local edits'; w.get('name').fire('input');
  w.get('refresh').fire('click'); w.state({ selected: '', draftKind: 'new', error: 'Read failed' }); w.done();
  assert.equal(w.get('name').value, 'local edits'); assert.equal(w.get('providers').value, 'local');
  assert.equal(w.get('notice').textContent, 'Read failed'); assert.equal(w.get('apply').disabled, true);
  w.state(); w.get('name').value = 'retry'; w.get('name').fire('input');
  w.get('apply').fire('click'); w.done(); assert.match(w.get('notice').textContent, /cancel/i);
  w.get('apply').fire('click'); w.receive({ type: 'notice', kind: 'error', text: 'Write failed' }); w.done();
  assert.equal(w.get('notice').textContent, 'Write failed');
});

for (const draftKind of ['existing', 'new', 'import', 'preset']) {
  test(`${draftKind} draft resets save options before computing dirty state`, () => {
    const w = webview();
    const defaults = { noAuth: false, stateless: false, applyRecommendedSettings: true, overwriteRecommendedSettings: false };
    for (const [id, value] of Object.entries(defaults)) {
      w.get(id).checked = !value; w.get(id).fire('change');
    }
    w.receive({ type: 'busy', value: true, operation: draftKind === 'existing' ? 'refresh' : draftKind === 'preset' ? 'editionPreset' : draftKind });
    w.state({ selected: draftKind === 'existing' ? 'other' : '', draftKind }); w.done();
    for (const [id, value] of Object.entries(defaults)) assert.equal(w.get(id).checked, value, id);
    assert.equal(w.get('saveState').dataset.state, draftKind === 'existing' ? 'clean' : 'dirty');
    if (draftKind === 'existing') {
      w.get('applyRecommendedSettings').checked = false; w.get('applyRecommendedSettings').fire('change');
      assert.equal(w.get('saveState').dataset.state, 'dirty');
      w.get('applyRecommendedSettings').checked = true; w.get('applyRecommendedSettings').fire('change');
      assert.equal(w.get('saveState').dataset.state, 'clean');
    }
  });
}

test('reload error notice blocks saving but preserves edits, selection, and pending key until a successful reload', () => {
  const w = webview();
  w.get('name').value = 'edited'; w.get('name').fire('input');
  w.receive({ type: 'key', pending: true });
  w.get('providers').value = 'other'; w.get('providers').fire('change');
  w.receive({ type: 'notice', kind: 'error', text: 'Reload failed' }); w.done();
  assert.equal(w.get('providers').value, 'local'); assert.equal(w.get('name').value, 'edited');
  assert.match(w.get('keyStatus').textContent, /pending save/i);
  assert.equal(w.get('apply').disabled, true);
  assert.equal(w.get('saveState').dataset.state, 'dirty');
  w.get('refresh').fire('click'); w.state(); w.done();
  assert.equal(w.get('apply').disabled, false); assert.equal(w.get('saveState').dataset.state, 'clean');
});

test('key status describes actual credential choice, including no-auth taking precedence', () => {
  const w = webview(); w.receive({ type: 'key', pending: true });
  w.get('noAuth').checked = true; w.get('noAuth').fire('change'); assert.match(w.get('keyStatus').textContent, /without an API key/i);
  w.get('noAuth').checked = false; w.get('noAuth').fire('change'); assert.match(w.get('keyStatus').textContent, /pending save/i);
});

test('edition auxiliary default applies only to available models and respects a manual choice on preset reload', () => {
  const w = webview();
  const draft = { name: 'sample', apiType: 'responses', defaultUrl: '', modelsText: JSON.stringify([{ id: 'alpha' }, { id: 'beta' }]), auxiliaryModel: 'beta' };
  w.state({ selected: '', draftKind: 'preset', draft });
  assert.equal(w.get('auxiliaryModel').value, 'beta');
  assert.equal(w.get('saveState').dataset.state, 'dirty');
  for (const choice of ['alpha', '']) {
    w.get('auxiliaryModel').value = choice; w.get('auxiliaryModel').fire('change');
    w.receive({ type: 'busy', value: true, operation: 'editionPreset' });
    w.state({ selected: '', draftKind: 'preset', draft }); w.done();
    assert.equal(w.get('auxiliaryModel').value, choice);
  }
  w.state({ selected: '', draftKind: 'preset', draft: { ...draft, auxiliaryModel: 'missing' } });
  assert.equal(w.get('auxiliaryModel').value, '');
});

test('native table retains column labels and full identifiers; filtered delete requires confirmation', () => {
  const w = webview(), id = 'x'.repeat(250), name = '<long & text>'.repeat(25);
  const models = [{ id: 'first' }, { id, name }];
  w.receive({ type: 'models', text: JSON.stringify(models) }); const before = w.work();
  w.get('searchModels').value = id; w.get('searchModels').fire('input');
  const table = w.get('modelList').children[0]; assert.equal(table.tag, 'table'); assert.equal(table.className, 'model-table');
  const head = table.children.find(n => n.tag === 'thead').children[0], rows = table.children.find(n => n.tag === 'tbody').children;
  assert.equal(head.tag, 'tr'); assert.ok(head.children.every(h => h.tag === 'th' && h.scope === 'col'));
  assert.equal(rows.length, 1); const cells = rows[0].children;
  assert.deepEqual(cells.map(n => n.className), ['model-body', 'model-protocol', 'model-meta', 'model-cap', 'model-actions']);
  assert.ok(cells.every((c, i) => c.tag === 'td' && (c.dataset.label || c['data-label']) === head.children[i].textContent));
  assert.deepEqual(cells[0].children.map(n => n.title), [name, id]); assert.deepEqual(w.work(), before);
  const remove = cells[4].children.find(b => b.textContent === 'Delete'); remove.fire('click'); assert.equal(w.get('deleteDialog').open, true);
  w.get('cancelDelete').fire('click'); assert.deepEqual(JSON.parse(w.get('modelsText').value), models);
  remove.fire('click'); w.get('confirmDelete').fire('click'); assert.deepEqual(JSON.parse(w.get('modelsText').value), [models[0]]);
});
