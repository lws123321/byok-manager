'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDocument, parseGroups, upsertGroup, removeGroup } = require('../src/jsonc');
const { buildGroup, sanitizePreset, importCandidates, commitGroup, isSecretRef, safeError, validUrl, equal } = require('../src/core');
const ref = '${input:chat.lm.secret.local}';
const model = () => ({ id: 'test-model', name: 'Test', url: 'https://gateway.example/v1', contextWindow: 128000, maxOutputTokens: 8192, toolCalling: true, vision: false });
const group = () => ({ name: 'custom', vendor: 'customendpoint', apiType: 'responses', apiKey: ref, models: [model()] });
const form = (models = [model()]) => ({ name: 'custom', apiType: 'responses', defaultUrl: 'https://gateway.example/v1', modelsText: JSON.stringify(models) });

for (const [label, text, value] of [
  ['JSON', '{"a":[1,true,null,"中"]}', { a: [1, true, null, '中'] }],
  ['JSONC comments and trailing commas', '// head\n{"a":1,/* mid */ "b":[2,],}', { a: 1, b: [2] }],
  ['BOM and CRLF', '\ufeff[\r\n1,\r\n]', [1]],
  ['URL and comment markers in strings', '{"url":"https://x/a/*ok*/","quote":"\\\""}', { url: 'https://x/a/*ok*/', quote: '"' }],
  ['scientific numbers', '[1e3,-1.2E-3]', [1000, -0.0012]],
  ['prototype-safe properties', '{"__proto__":{"polluted":true}}', JSON.parse('{"__proto__":{"polluted":true}}')]
]) test('parse: ' + label, () => { assert.deepEqual(parseDocument(text).value, value); assert.equal({}.polluted, undefined); });

for (const text of ['{"a":1,"a":2}', '{"a":}', '[1,,2]', '01', '1e999', '{} garbage', '/* never', '"unterminated', '[NaN]', '{a:1}', '[1 2]', '{"x":"\\q"}']) {
  test('reject invalid JSONC: ' + text.slice(0, 12), () => assert.throws(() => parseDocument(text)));
}
test('parser does not echo secret-like input in errors', () => assert.throws(() => parseDocument('{"key":sk-superprivatevalue}'), e => !e.message.includes('superprivate')));
test('groups require valid array and unique identity', () => {
  assert.throws(() => parseGroups('{}')); assert.throws(() => parseGroups('[{}]'));
  assert.throws(() => parseGroups(JSON.stringify([group(), group()])));
});
test('upsert preserves unrelated comments and providers', () => {
  const before = '// root\n[\n// keep\n{"name":"other","vendor":"openai","settings":{"x":1}},\n' + JSON.stringify(group()) + ', // tail\n]\n';
  const next = upsertGroup(before, { ...group(), models: [{ ...model(), name: 'Updated' }] });
  assert.ok(next.startsWith('// root\n[\n// keep\n{"name":"other","vendor":"openai","settings":{"x":1}},\n'));
  assert.ok(next.endsWith(', // tail\n]\n'));
  assert.equal(parseGroups(next).value[1].models[0].name, 'Updated');
});
for (const base of ['[]', '[/* blank */]', '[{"name":"old","vendor":"a"}]', '[{"name":"old","vendor":"a"}, // trailing\n]', '\ufeff[\r\n{"name":"old","vendor":"a"}\r\n]']) {
  test('append handles array punctuation: ' + base.slice(0, 18), () => {
    const next = upsertGroup(base, group());
    assert.equal(parseGroups(next).value.at(-1).name, 'custom');
  });
}
for (let index = 0; index < 3; index++) test('remove group at index ' + index, () => {
  const groups = ['a', 'b', 'c'].map(name => ({ name, vendor: 'customendpoint' }));
  const text = '// hi\n' + JSON.stringify(groups, null, 2).replace(/\n\]$/, ', // end\n]');
  const next = removeGroup(text, 'customendpoint', groups[index].name);
  assert.deepEqual(parseGroups(next).value, groups.filter((_, i) => i !== index));
});
test('remove sole group and absent group', () => {
  assert.deepEqual(parseGroups(removeGroup('[{"name":"a","vendor":"x"},]', 'x', 'a')).value, []);
  assert.equal(removeGroup('[]', 'x', 'a'), '[]');
});
test('build preserves model options and provider settings', () => {
  const m = { ...model(), supportsReasoningEffort: ['low', 'custom'], modelOptions: { temperature: null } };
  const built = buildGroup(form([m]), { ...group(), settings: { 'test-model': { reasoningEffort: 'high' } } });
  assert.deepEqual(built.group.models[0], m); assert.ok(built.group.settings);
  assert.equal(built.group.apiKey, undefined);
});
test('default URL fills missing URLs but not existing per-model URLs', () => {
  const a = model(); delete a.url;
  const b = { ...model(), id: 'different', url: 'https://second.example/v2' };
  const result = buildGroup(form([a, b])).group;
  assert.equal(result.models[0].url, 'https://gateway.example/v1');
  assert.equal(result.models[1].url, 'https://second.example/v2');
});
test('stateless applies only to Responses models', () => {
  const input = form([model(), { ...model(), id: 'chat', apiType: 'chat-completions' }]); input.stateless = true;
  const result = buildGroup(input).group.models;
  assert.equal(result[0].statefulResponses, false); assert.equal(result[1].statefulResponses, undefined);
});
test('group-level discovery URL is not accidentally retained', () => assert.equal(buildGroup(form(), { url: 'https://discovery.example' }).group.url, undefined));
test('maxInputTokens-only model works', () => { const m = model(); delete m.contextWindow; m.maxInputTokens = 100000; assert.ok(buildGroup(form([m]))); });
for (const patch of [
  { id: '' }, { maxOutputTokens: 0 }, { maxOutputTokens: 128000 }, { maxInputTokens: 128000 },
  { toolCalling: 'true' }, { vision: null }, { thinking: 'high' }, { apiType: 'bogus' },
  { supportsReasoningEffort: 'high' }, { contextWindow: -1 }, { url: 'ftp://example.com' },
  { url: 'https://user:pass@example.com/v1' }, { url: 'https://example.com/?key=bad' },
  { url: 'https://example.com/#secret' }, { url: 'https://example.com/v1/messages' }
]) test('reject bad model: ' + JSON.stringify(patch), () => assert.throws(() => buildGroup(form([{ ...model(), ...patch }]))));
test('reject duplicate models and empty list', () => { assert.throws(() => buildGroup(form([model(), model()]))); assert.throws(() => buildGroup(form([]))); });
test('plaintext model credential rejected; apiKey placeholder allowed', () => {
  assert.throws(() => buildGroup(form([{ ...model(), requestHeaders: { Authorization: 'Bearer private' } }])));
  assert.ok(buildGroup(form([{ ...model(), requestHeaders: { Authorization: 'Bearer ${apiKey}' } }])));
});
test('remote HTTP produces warning; loopback does not', () => {
  assert.equal(buildGroup(form([{ ...model(), url: 'http://lan.example/v1' }])).warnings.length, 1);
  assert.equal(buildGroup(form([{ ...model(), url: 'http://127.0.0.1:8000/v1' }])).warnings.length, 0);
});
test('preset removes secrets AND all custom headers but preserves token limits', () => {
  const g = group(); g.models[0].requestHeaders = { 'x-unusual-private-credential': 'private' };
  const exported = sanitizePreset(g);
  assert.equal(exported.apiKey, undefined); assert.equal(exported.models[0].requestHeaders, undefined);
  assert.equal(exported.models[0].maxOutputTokens, 8192);
  const imported = importCandidates(JSON.stringify(g))[0]; assert.equal(imported.apiKey, undefined);
  assert.ok(buildGroup(form(imported.models), imported));
});
test('import rejects unsupported vendors', () => assert.throws(() => importCandidates('[{"name":"x","vendor":"openai","models":[]}]')));
test('secret ref recognition and error redaction', () => {
  assert.ok(isSecretRef(ref)); assert.ok(!isSecretRef('sk-private'));
  assert.equal(safeError(new Error('failed PRIVATE sk-12345678'), ['PRIVATE']), 'failed [REDACTED] [REDACTED]');
});
test('canonical comparison ignores property order but not array order', () => {
  assert.ok(equal({ a: 1, b: 2 }, { b: 2, a: 1 })); assert.ok(!equal([1, 2], [2, 1])); assert.ok(equal(undefined, undefined));
});

function memoryIO(initial, options = {}) {
  let text = initial; const written = []; const calls = [];
  return {
    get text() { return text; }, get written() { return written; }, get calls() { return calls; },
    read: async () => ({ text }),
    write: async (expected, next) => {
      if (options.failWrite) { options.failWrite = false; throw new Error('disk write failed'); }
      assert.equal(text, expected); text = next; written.push(next);
    },
    addGroup: async payload => {
      calls.push(payload);
      if (options.failBeforeAdd) throw new Error('native failed');
      const tmp = { ...payload, apiKey: options.plaintext ? payload.apiKey : '${input:chat.lm.secret.new}' };
      const arr = parseGroups(text).value; arr.push(tmp);
      if (options.concurrent) arr[0].concurrent = true;
      text = JSON.stringify(arr, null, '\t');
      if (options.failAfterAdd) throw new Error('native failed after save');
    }
  };
}
test('new key uses native add, never file edit, and preserves outside comments', async () => {
  const initial = '// keep\n' + JSON.stringify([group()]); const io = memoryIO(initial);
  await commitGroup(io, { ...group(), models: [{ ...model(), name: 'new' }] }, { apiKey: 'actual-private-key' });
  const saved = parseGroups(io.text).value;
  assert.equal(saved.length, 1); assert.equal(saved[0].apiKey, '${input:chat.lm.secret.new}');
  assert.equal(io.calls[0].apiKey, 'actual-private-key'); assert.deepEqual(io.calls[0].models, []);
  assert.ok(io.written.every(t => !t.includes('actual-private-key'))); assert.ok(io.text.startsWith('// keep'));
});
test('reuse key never calls native secret writer and does not double encrypt', async () => {
  const io = memoryIO(JSON.stringify([group()]));
  await commitGroup(io, group(), { reuseReference: ref });
  assert.equal(io.calls.length, 0); assert.equal(parseGroups(io.text).value[0].apiKey, ref);
});
test('no-auth is explicit and removes old reference', async () => {
  const io = memoryIO(JSON.stringify([group()])); await commitGroup(io, group(), { noAuth: true });
  assert.equal(parseGroups(io.text).value[0].apiKey, undefined);
});
test('new installation supports first group and no preexisting key', async () => {
  const io = memoryIO('[]'); await commitGroup(io, group(), { apiKey: 'first-real-key' });
  assert.equal(parseGroups(io.text).value.length, 1);
});
test('missing key stops without writes', async () => {
  const io = memoryIO('[]'); await assert.rejects(() => commitGroup(io, group()));
  assert.equal(io.written.length, 0); assert.equal(io.calls.length, 0);
});
for (const key of [ref, 'bad\nkey']) test('reject bad API key input', async () => {
  const io = memoryIO('[]'); await assert.rejects(() => commitGroup(io, group(), { apiKey: key })); assert.equal(io.calls.length, 0);
});
for (const option of ['failBeforeAdd', 'failAfterAdd', 'failWrite', 'plaintext']) test('native failure recovery: ' + option, async () => {
  const initial = '// original\n' + JSON.stringify([group()]); const io = memoryIO(initial, { [option]: true });
  await assert.rejects(() => commitGroup(io, group(), { apiKey: 'PRIVATE' }));
  assert.equal(io.text, initial); assert.ok(io.written.every(t => !t.includes('PRIVATE')));
});
test('concurrent edits are retained while temporary group is cleaned', async () => {
  const io = memoryIO(JSON.stringify([group()]), { concurrent: true });
  await assert.rejects(() => commitGroup(io, group(), { apiKey: 'PRIVATE' }), /其他窗口|another window/);
  const result = parseGroups(io.text).value; assert.equal(result.length, 1); assert.equal(result[0].concurrent, true); assert.equal(result[0].apiKey, ref);
});

const { mergeModels } = require('../src/core');
test('visual merge appends models and preserves existing fields and order', () => {
  const old = {...model(), extra:{keep:1}, requestHeaders:{'X-Business':'keep'}};
  const newModel = {...model(), id:'new-id', supportsReasoningEffort:['low','xhigh'], extra:{custom:2}};
  const result = mergeModels(form([old]), JSON.stringify(newModel));
  assert.deepEqual(result.models,[old,newModel]); assert.equal(result.added,1);
});
test('visual merge skips duplicates by default, replace only when explicit', () => {
  const old = model(); const changed = {...old,name:'changed'};
  assert.deepEqual(mergeModels(form([old]), JSON.stringify([changed])).models,[old]);
  const result=mergeModels(form([old]), JSON.stringify([changed]),true);
  assert.deepEqual(result.models,[changed]); assert.equal(result.updated,1);
});
test('visual merge preserves source protocol and drops imported keys and headers', () => {
  const incoming={...group(),apiType:'chat-completions',models:[{...model(),id:'new',apiKey:'secret-value',requestHeaders:{'X-Private':'hidden'}}]};
  const result=mergeModels(form(),JSON.stringify(incoming));
  assert.equal(result.models[1].apiType,'chat-completions'); assert.equal(result.models[1].apiKey,undefined); assert.equal(result.models[1].requestHeaders,undefined);
});
test('visual merge supports JSONC and leaves current drafts intact on error', () => {
  const draft=form(); const before=draft.modelsText;
  assert.equal(mergeModels(draft,'// model\n'+JSON.stringify({...model(),id:'new'})).added,1);
  assert.throws(()=>mergeModels(draft,'[{}]')); assert.equal(draft.modelsText,before);
});
test('visual merge rejects duplicate incoming IDs, invalid specifications and >300 rows', () => {
  assert.throws(()=>mergeModels(form(),JSON.stringify([model(),model()])));
  assert.throws(()=>mergeModels(form(),JSON.stringify({...model(),contextWindow:1})));
  const rows=Array.from({length:300},(_,i)=>({...model(),id:'id'+i}));
  assert.throws(()=>mergeModels(form(rows),JSON.stringify(model())));
});
test('visual merge adds to an empty draft and supports group arrays', () => {
  const result=mergeModels(form([]),JSON.stringify([group(),{...group(),models:[{...model(),id:'second'}]}]));
  assert.equal(result.models.length,2); assert.equal(result.added,2);
});

test('visual merge respects explicitly supplied source group URL', () => {
  const m={...model(),id:'remote'};delete m.url;
  const result=mergeModels(form(),JSON.stringify({...group(),url:'https://other.example/v1',models:[m]}));
  assert.equal(result.models[1].url,'https://other.example/v1');
});
