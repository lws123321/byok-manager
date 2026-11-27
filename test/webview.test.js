'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../media/app.js'), 'utf8');
const markup = fs.readFileSync(require.resolve('../media/index.html'), 'utf8');

// Drive the production message and DOM listeners without a browser or extension host.
class Element extends EventTarget {
  constructor(tag, doc) { super(); this.tag = tag; this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.value = ''; this.checked = false; this.textContent = ''; this.dataset = {}; }
  append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  add(option) { this.append(option); }
  contains(child) { for (; child; child = child.parentElement) if (child === this) return true; return false; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches?.(selector) ? [child] : []), ...(child.querySelectorAll?.(selector) || [])]);
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const name = part.trim().replace('[open]', ''), matches = name[0] === '#' ? this.id === name.slice(1)
        : name.split('.').every((value, index) => !value || value === (index ? this.className : this.tag));
      return matches && (!part.includes('[open]') || this.open);
    });
  }
  querySelector(tag) { return this.querySelectorAll(tag)[0] || null; }
  focus() { this.focused = true; this.doc.activeElement = this; }
  setAttribute(key, value) { this[key] = value; }
  showModal() { this.opener = this.doc.activeElement; this.open = true; this.focus(); }
  close() { this.open = false; this.opener?.focus(); this.fire('close'); }
  fire(type, properties = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), properties);
    Object.defineProperty(event, 'target', { value: this });
    if (type === 'click' && !this.disabled && ['button', 'summary'].includes(this.tag)) this.focus();
    for (let n = this; n; n = n.parentElement) { n.dispatchEvent(event); if (event.cancelBubble || type === 'close') break; }
    if (type === 'click' && this.tag === 'summary' && !event.defaultPrevented) this.parentElement.open = !this.parentElement.open;
    return event;
  }
}
function webview(lang = 'en') {
  const document = new Element('document'); document.documentElement = { lang }; document.body = document;
  const fields = new Map(), parents = [document];
  // Use the shipped control hierarchy: nested disclosures, modal openers and bubbling matter here.
  for (const [, close, tag, attrs] of markup.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
    if (close) { parents.pop(); continue; }
    const element = new Element(tag, document); parents.at(-1).append(element);
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (id) { element.id = id; fields.set(id, element); }
    element.checked = element.defaultChecked = /\schecked\b/.test(attrs);
    if (!['input', 'meta', 'link', 'br'].includes(tag)) parents.push(element);
  }
  const get = id => fields.get(id);
  document.getElementById = get; document.createElement = tag => new Element(tag, document);
  let receive, parses = 0, serializations = 0;
  const posts = [];
  vm.runInNewContext(app, {
    URL,
    window: { addEventListener(_, callback) { receive = data => callback({ data }); } },
    document,
    Option: class { constructor(text, value) { Object.assign(this, { text, value }); } },
    acquireVsCodeApi: () => ({ postMessage: message => posts.push(message) }),
    JSON: { parse(text) { parses++; return JSON.parse(text); }, stringify(...args) { serializations++; return JSON.stringify(...args); } }
  });
  const state = (overrides = {}) => receive({ type: 'state', env: {}, groups: [{ name: 'local', count: 0, hasKey: true }], selected: 'local', draft: { name: 'local', apiType: 'responses', defaultUrl: '', modelsText: '[]' }, ...overrides });
  const done = () => receive({ type: 'busy', value: false });
  state(); done();
  return { document, get, receive, state, done, posts, work: () => [parses, serializations], status: () => get('saveState').textContent };
}

test('discovery requires a click; URL, protocol, and key changes never request models', () => {
  const w = webview(), url = w.get('defaultUrl'), protocol = w.get('apiType'), discover = w.get('discoverModels');
  url.value = 'https://gateway.example/v1';
  for (const event of ['paste', 'input', 'change', 'blur']) url.fire(event);
  protocol.value = 'chat-completions'; protocol.fire('change');
  w.receive({ type: 'key', pending: true });
  w.get('noAuth').checked = true; w.get('noAuth').fire('change');
  w.get('name').value = 'not-for-discovery'; w.get('mergeText').value = 'not-for-discovery';
  assert.deepEqual(w.posts.map(m => m.type), ['ready']);
  discover.fire('click'); discover.fire('click');
  assert.deepEqual(JSON.parse(JSON.stringify(w.posts.slice(1))), [{ type: 'discoverModels', form: {
    defaultUrl: url.value, apiType: protocol.value, modelsText: '[]', noAuth: true
  } }]);
  assert.equal(discover.disabled, true);
  w.done(); assert.equal(discover.disabled, false); assert.equal(discover.focused, true);
});

test('discovery stays disabled with no endpoint or Messages, including after host reload and unlock', () => {
  const w = webview(), discover = w.get('discoverModels');
  assert.equal(discover.disabled, true); discover.fire('click');
  for (const [apiType, defaultUrl, disabled] of [['messages', 'https://gateway.example', true], ['responses', '  ', true], ['responses', 'https://gateway.example', false]]) {
    w.receive({ type: 'busy', value: true, operation: 'refresh' });
    w.state({ draft: { name: 'local', apiType, defaultUrl, modelsText: '[]' } });
    assert.equal(discover.disabled, true); discover.fire('click');
    w.done(); assert.equal(discover.disabled, disabled); assert.equal(w.get('discoveryHint').hidden, !disabled); if (disabled) discover.fire('click');
  }
  assert.deepEqual(w.posts.map(m => m.type), ['ready']);
});

test('selected discoveries are editable drafts, without inferred metadata or a save', () => {
  const w = webview(), draft = { name: 'local', apiType: 'responses', defaultUrl: 'https://gateway.example', modelsText: '[]' };
  w.state({ draft }); w.get('searchModels').value = 'old filter'; w.get('discoverModels').fire('click');
  const text = '[{"id":"external-model"}]'; w.receive({ type: 'models', text }); w.done();
  assert.equal(w.get('modelsText').value, text); assert.match(w.status(), /unsaved/i);
  assert.equal(w.get('searchModels').value, '');
  const row = w.get('modelList').children[0].children.find(n => n.tag === 'tbody').children[0];
  row.children[4].children[0].fire('click');
  assert.equal(w.get('modelDialog').open, true); assert.equal(w.get('editId').value, 'external-model');
  for (const field of ['editContext', 'editOutput', 'editThinking']) assert.equal(w.get(field).value, '');
  w.get('editContext').value = '4096'; w.get('editOutput').value = '1024'; w.get('editTool').checked = true;
  w.get('modelForm').fire('submit');
  assert.equal(w.get('modelDialog').open, false);
  assert.deepEqual(JSON.parse(w.get('modelsText').value), [{ id: 'external-model', name: 'external-model', contextWindow: 4096, maxOutputTokens: 1024, toolCalling: true, vision: false }]);
  assert.deepEqual(w.posts.map(m => m.type), ['ready', 'discoverModels']);
});

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

test('switch sends only dirty state; cancellation keeps the selected group and edits', () => {
  const w = webview(), button = w.get('switchGroup');
  button.fire('click'); button.fire('click');
  assert.deepEqual(w.posts.slice(1).map(m => ({ ...m })), [{ type: 'switchGroup', dirty: false }]);
  w.done(); assert.equal(button.focused, true);
  w.get('name').value = 'draft target'; w.get('name').fire('input');
  button.fire('click'); w.done();
  assert.deepEqual({ ...w.posts.at(-1) }, { type: 'switchGroup', dirty: true });
  assert.equal(w.get('groupName').textContent, 'local'); assert.equal(w.get('name').value, 'draft target');
  w.get('refresh').fire('click'); assert.deepEqual({ ...w.posts.at(-1) }, { type: 'refresh', name: 'local' });
});

test('drafts show their origin and live model count, independent of search or a same-name saved group', () => {
  const w = webview(), draft = { name: 'local', apiType: 'responses', defaultUrl: '', modelsText: '[{"id":"one"},{"id":"two"}]' };
  for (const [draftKind, origin] of [['new', /new/i], ['import', /import/i], ['preset', /preset/i]]) {
    w.state({ selected: draftKind === 'preset' ? 'local' : '', draftKind, draft });
    assert.match(w.get('groupKind').textContent, origin); assert.equal(w.get('groupName').textContent, 'local');
    w.get('searchModels').value = 'one'; w.get('searchModels').fire('input');
    assert.equal(w.get('groupCount').textContent, '2 models');
    w.receive({ type: 'models', text: '[]' }); assert.equal(w.get('groupCount').textContent, '0 models');
    w.get('modelsText').value = '['; w.get('modelsText').fire('input'); assert.doesNotMatch(w.get('groupCount').textContent, /\d/);
    assert.equal(w.get('saveState').dataset.state, 'dirty');
    w.get('refresh').fire('click'); assert.equal(w.posts.at(-1).name, draftKind === 'preset' ? 'local' : null); w.done();
  }
});

test('failed reload keeps the edited form; a cancelled save reports cancellation without hiding host errors', () => {
  const w = webview(); w.get('name').value = 'local edits'; w.get('name').fire('input');
  w.get('refresh').fire('click'); w.state({ selected: '', draftKind: 'new', error: 'Read failed' }); w.done();
  assert.equal(w.get('name').value, 'local edits'); assert.equal(w.get('groupName').textContent, 'local');
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
    assert.equal(w.get('connectionEditor').open, draftKind !== 'existing');
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
  w.get('refresh').fire('click');
  w.receive({ type: 'notice', kind: 'error', text: 'Reload failed' }); w.done();
  assert.equal(w.get('groupName').textContent, 'local'); assert.equal(w.get('name').value, 'edited');
  assert.match(w.get('keyStatus').textContent, /pending save/i);
  assert.equal(w.get('apply').disabled, true);
  assert.equal(w.get('saveState').dataset.state, 'dirty');
  w.get('refresh').fire('click'); w.state(); w.done();
  assert.equal(w.get('apply').disabled, false); assert.equal(w.get('saveState').dataset.state, 'clean');
});

test('key actions follow the exact trimmed save target, pending entry, then no-auth override', () => {
  const w = webview(), name = w.get('name'), status = w.get('keyStatus'), enter = w.get('setKey'), clear = w.get('clearKey');
  w.state({ groups: [{ name: 'local', count: 0, hasKey: false }, { name: 'Other', count: 0, hasKey: true }] });
  for (const [value, reusable] of [['Other', true], ['other', false], [' Other ', true], ['', false], ['local', false], ['Other', true]]) {
    name.value = value; name.fire('input'); assert.match(enter.textContent, reusable ? /replace/i : /enter/i);
    assert.match(status.textContent, reusable ? /reuse/i : /no .*reference|enter/i); assert.equal(clear.hidden, true);
  }
  w.receive({ type: 'key', pending: true }); assert.match(status.textContent, /pending save/i); assert.equal(clear.hidden, false);
  w.get('noAuth').checked = true; w.get('noAuth').fire('change'); assert.match(status.textContent, /without an API key/i);
  assert.equal(enter.disabled, true); assert.equal(enter.hidden, true);
  w.get('noAuth').checked = false; w.get('noAuth').fire('change'); assert.match(status.textContent, /pending save/i);
  clear.fire('click'); assert.equal(enter.disabled, true);
  w.receive({ type: 'key', pending: false }); w.done(); assert.equal(clear.hidden, true); assert.equal(enter.focused, true);
  assert.match(status.textContent, /reuse/i); assert.match(enter.textContent, /replace/i);
});

test('empty saved groups disable switching but leave New and Reload available', () => {
  const w = webview(); w.state({ groups: [], selected: '', draftKind: 'new' });
  assert.equal(w.get('switchGroup').disabled, true); assert.equal(w.get('new').disabled, false); assert.equal(w.get('refresh').disabled, false);
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
  const [edit, more] = cells[4].children;
  assert.equal(edit.textContent, 'Edit'); assert.equal(more?.tag, 'details'); assert.equal(more.className, 'row-more');
  const [summary, actions] = more.children;
  assert.equal(summary.tag, 'summary'); assert.match(summary.textContent, /More/); assert.equal(actions.className, 'row-more-actions');
  const [copy, remove] = actions.children;
  more.open = true; copy.fire('click'); assert.equal(more.open, false);
  assert.equal(w.get('editId').value, ''); assert.equal(w.get('editName').value, name); w.get('cancelEditor').fire('click');
  assert.equal(w.document.activeElement, summary);
  more.open = true; remove.fire('click'); assert.equal(w.get('deleteDialog').open, true);
  assert.equal(more.open, false); w.get('cancelDelete').fire('click'); assert.deepEqual(JSON.parse(w.get('modelsText').value), models);
  more.open = true; remove.fire('click'); w.get('confirmDelete').fire('click'); assert.deepEqual(JSON.parse(w.get('modelsText').value), [models[0]]);
  assert.equal(w.document.activeElement, w.get('searchModels'));
});

test('connection opens for a new draft, collapses after choosing a saved group, and never toggles on draft edits', () => {
  const w = webview(), editor = w.get('connectionEditor'), url = w.get('defaultUrl');
  assert.equal(Boolean(editor.open), false);
  w.get('new').fire('click'); w.receive({ type: 'busy', value: true, operation: 'new' });
  w.state({ selected: '', draftKind: 'new', draft: { name: 'custom', apiType: 'messages', defaultUrl: '', modelsText: '[]' } }); w.done();
  assert.equal(editor.open, true); assert.equal(w.get('groupName').textContent, 'custom');
  assert.equal(w.get('connectionEndpoint').textContent, 'Not set');
  w.get('noAuth').checked = true; w.get('noAuth').fire('change'); assert.equal(w.get('connectionCredential').textContent, 'No key needed');
  w.get('noAuth').checked = false; w.get('noAuth').fire('change'); assert.equal(w.get('connectionCredential').textContent, 'No key reference');
  w.get('apiType').value = 'responses'; w.get('apiType').fire('change'); assert.equal(w.get('connectionProtocol').textContent, 'Responses');
  url.focus(); url.value = 'https://user:SECRET@gateway.example:444/v1/SECRET?key=SECRET#SECRET'; url.fire('input');
  assert.doesNotMatch(w.get('connectionEndpoint').textContent, /SECRET|user:/); assert.equal(w.document.activeElement, url);
  url.value = 'https://gateway.example:444/v1'; url.fire('input'); assert.match(w.get('connectionEndpoint').textContent, /gateway\.example:444/);
  w.receive({ type: 'key', pending: true }); assert.match(w.get('connectionCredential').textContent, /pending/i);
  assert.equal(editor.open, true); editor.open = false; editor.fire('toggle');
  w.receive({ type: 'models', text: '[{"id":"model"}]' }); assert.equal(editor.open, false);
  assert.equal(w.get('defaultUrl').value, url.value); assert.match(w.get('connectionCredential').textContent, /pending/i);
  editor.open = true; editor.fire('toggle');
  w.get('switchGroup').fire('click'); w.done(); assert.equal(editor.open, true); // picker cancelled
  w.get('switchGroup').fire('click'); w.receive({ type: 'busy', value: true, operation: 'switchGroup' });
  w.state({ draftKind: 'existing', groups: [{ name: 'A', hasKey: true }], selected: 'A', draft: { name: 'A', apiType: 'chat-completions', defaultUrl: '', modelsText: '[{"id":"a","url":"https://one.example"},{"id":"b","url":"https://two.example"}]' } }); w.done();
  assert.equal(editor.open, false); assert.equal(w.get('groupName').textContent, 'A');
  assert.match(w.get('connectionEndpoint').textContent, /per.model|multiple/i); assert.equal(w.get('connectionProtocol').textContent, 'Chat Completions');
  assert.match(w.get('connectionCredential').textContent, /reference|reus/i); assert.equal(w.get('modelCount').textContent, '2');
  assert.deepEqual(w.posts.map(m => m.type), ['ready', 'new', 'switchGroup', 'switchGroup']);
});

test('effort levels are native disclosures and only explicitly supported capabilities are listed', () => {
  const w = webview('zh-cn');
  w.receive({ type: 'models', text: '[{"id":"m","vision":true,"supportsReasoningEffort":["low","high"]},{"id":"n"}]' });
  const rows = w.get('modelList').querySelector('tbody').children, cap = rows[0].children[3], effort = cap.querySelector('details');
  assert.equal(cap.children[0].textContent, '视觉'); assert.equal(effort?.className, 'model-effort');
  assert.equal(effort.children[0].tag, 'summary'); assert.match(effort.children[0].textContent, /档/); assert.match(effort.children[1].textContent, /low.*high/);
  assert.equal(rows[1].children[3].children[0].textContent, '—'); assert.equal(rows[1].children[3].querySelector('details'), null);
  assert.equal(rows[1].children[4].querySelector('summary').textContent, '更多…');
});

test('tools and row actions dismiss locally without trapping Escape or stealing focus after a host task', () => {
  const w = webview(), tools = w.get('modelTools'), summary = tools.querySelector('summary');
  summary.fire('click'); assert.equal(tools.open, true);
  w.get('advanced').querySelector('summary').fire('click');
  w.get('modelsText').focus(); const escape = w.get('modelsText').fire('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true); assert.equal(w.get('advanced').open, false); assert.equal(tools.open, true);
  assert.equal(w.document.activeElement, w.get('advanced').querySelector('summary'));
  w.get('validate').fire('click'); assert.equal(tools.open, false); assert.equal(w.posts.at(-1).type, 'validate');
  const connection = w.get('connectionEditor').querySelector('summary'); connection.fire('click'); w.done();
  assert.equal(w.document.activeElement, connection);
  w.get('defaultUrl').focus(); w.get('defaultUrl').fire('keydown', { key: 'Escape' });
  assert.equal(w.get('connectionEditor').open, false); assert.equal(w.document.activeElement, connection);
  w.receive({ type: 'models', text: '[{"id":"a"}]' });
  const more = w.get('modelList').querySelector('details.row-more'), rowSummary = more.querySelector('summary');
  rowSummary.fire('click'); assert.equal(more.open, true);
  more.querySelector('button').fire('keydown', { key: 'Escape' }); assert.equal(more.open, false); assert.equal(w.document.activeElement, rowSummary);
  rowSummary.fire('click'); w.get('searchModels').focus(); w.get('searchModels').fire('click');
  assert.equal(more.open, false); assert.equal(w.document.activeElement, w.get('searchModels'));
  assert.equal(w.get('searchModels').fire('keydown', { key: 'Escape' }).defaultPrevented, false);
});
