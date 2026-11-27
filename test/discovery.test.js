'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { gzipSync } = require('node:zlib');
const { setLocale } = require('../src/i18n');
const { modelsUrl, fetchModels, DiscoveryError } = require('../src/discovery');

const origin = 'https://fixture.invalid';
const key = 'test-only-fixture-token';
const fromJson = (value, credential) => fetchModels(origin, credential, { fetchImpl: async () => Response.json(value) });

async function loopback(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('makes one GET, with ambient credentials omitted; ignores paging links', async () => {
  for (const credential of [undefined, key]) {
    const calls = [];
    const result = await fetchModels(origin + '/v1/responses', credential, { fetchImpl: async (url, options) => {
      calls.push({ url, options }); return Response.json({ data: [{ id: 'plain' }], next: 'https://other.invalid' });
    } });
    assert.deepEqual(result, [{ id: 'plain' }]); assert.equal(calls.length, 1);
    const [{ url, options }] = calls; const headers = new Headers(options.headers);
    assert.equal(url, origin + '/v1/models'); assert.equal(options.method, 'GET');
    assert.ok(['manual', 'error'].includes(options.redirect)); assert.equal(options.credentials, 'omit');
    assert.equal(headers.get('authorization'), credential ? `Bearer ${key}` : null);
    assert.equal(headers.has('cookie'), false); assert.equal(options.body, undefined);
  }
});

test('only copies recognized, explicitly typed model metadata; first duplicate wins', async () => {
  const good = { id: 'vendor/model:latest', name: '模型', contextWindow: 4096, maxInputTokens: 3072,
    maxOutputTokens: 1024, toolCalling: false, vision: true, thinking: false };
  const data = [{ ...good, url: origin, requestHeaders: { authorization: key }, apiType: 'messages',
    ['__proto__']: { suspicious: true }, constructor: { bad: key } }, { id: good.id, name: 'duplicate' },
    { id: 'minimal', contextWindow: '100', maxOutputTokens: 0, maxInputTokens: 1.1, toolCalling: 'true',
      vision: [], thinking: 1, supported_parameters: ['tools'] },
    { id: 'snake', context_length: 1000, max_input_tokens: 700, max_output_tokens: 300 },
    { id: 'invalid-int', contextWindow: 2 ** 53, maxInputTokens: -2, maxOutputTokens: null },
    null, [], 'invalid', {}, { id: '' }];
  assert.deepEqual(await fromJson({ data }, key), [good, { id: 'minimal' },
    { id: 'snake', contextWindow: 1000, maxInputTokens: 700, maxOutputTokens: 300 }, { id: 'invalid-int' }]);
});

test('rejects key echoes, control characters, bidi overrides and picker codicons in identifiers or names', async () => {
  const unsafe = ['prefix' + key, 'line\n', 'line\u0085', 'right\u202eleft', '\u2067isolate', '$(warning)'];
  assert.deepEqual(await fromJson({ data: unsafe.flatMap((text, i) => [{ id: text }, { id: `m${i}`, name: text }]) }, key),
    unsafe.map((_, i) => ({ id: `m${i}` })));
});

test('no request is made for unsafe destinations, invalid keys, or pre-aborted signals', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return Response.json({ data: [] }); };
  await assert.rejects(fetchModels('http://fixture.invalid', key, { fetchImpl }));
  for (const bad of ['a\rb', 'a\nb', '${input:chat.lm.secret.fake}']) await assert.rejects(fetchModels(origin, bad, { fetchImpl }));
  await assert.rejects(fetchModels(origin, key, { fetchImpl, signal: AbortSignal.abort(new Error(key)) }), /cancel/i);
  assert.equal(calls, 0);
});

test('loopback server receives bearer only at the originally requested URL, never the redirect target', async t => {
  const requests = [];
  const url = await loopback(t, (req, res) => {
    requests.push([req.method, req.url, req.headers.authorization]);
    if (req.url === '/v1/models') res.writeHead(307, { Location: '/next' }).end();
    else res.end('{"data":[]}');
  });
  await assert.rejects(fetchModels(url, key));
  assert.deepEqual(requests, [['GET', '/v1/models', 'Bearer ' + key]]);
});

test('never trusts even a transport error with the discovery error type', async () => {
  const raw = new DiscoveryError(401); raw.message = key; raw.cause = new Error(origin);
  await assert.rejects(fetchModels(origin, key, { fetchImpl: async () => { throw raw; } }),
    error => error instanceof DiscoveryError && error !== raw && !error.message.includes(key) && !error.cause);
});

test('status and network errors are localized and do not carry bodies, URLs, status text, causes or keys', async t => {
  t.after(() => setLocale('en'));
  for (const locale of ['en', 'zh-cn']) {
    setLocale(locale);
    for (const status of [401, 403, 404, 429, 500, 302, 0]) {
      let calls = 0;
      await assert.rejects(fetchModels(origin, key, { fetchImpl: async () => {
        calls++; if (!status) throw new Error(origin + key);
        return new Response('raw-body ' + key, { status, statusText: 'private detail' });
      } }), error => {
        assert.doesNotMatch(error.message, /fixture\.invalid|test-only|raw-body|private detail/);
        assert.equal(error.cause, undefined);
        if (locale === 'zh-cn') assert.match(error.message, /[\u4e00-\u9fff]/);
        if ([401, 403, 404, 429].includes(status)) assert.match(error.message, new RegExp(String(status)));
        return true;
      }); assert.equal(calls, 1);
    }
  }
});

test('malformed envelopes, invalid JSON/UTF-8 and excessive item count fail with safe errors', async () => {
  for (const data of ['null', '[]', '{}', '{"data":{}}', key, new Uint8Array([123, 255, 125]),
    JSON.stringify({ data: Array(10001).fill(null) })]) {
    await assert.rejects(fetchModels(origin, key, { fetchImpl: async () => new Response(data) }), error =>
      !/test-only|fixture\.invalid|JSON at position|Unexpected token/.test(error.message));
  }
  assert.deepEqual(await fromJson({ data: [] }), []);
});

test('decompressed bytes are limited even if the compressed Content-Length is small', async t => {
  const compressed = gzipSync(JSON.stringify({ data: [], padding: 'x'.repeat(2 ** 21) }));
  const url = await loopback(t, (_, res) => res.writeHead(200, {
    'Content-Encoding': 'gzip', 'Content-Type': 'application/json', 'Content-Length': compressed.length
  }).end(compressed));
  await assert.rejects(fetchModels(url), /large|limit/i);
});

test('cancelling while reading aborts transport and cancels a stalled response body', async () => {
  const controller = new AbortController(); let transportSignal, ready, cancelled = false;
  const reading = new Promise(resolve => { ready = resolve; });
  const pending = fetchModels(origin, key, { signal: controller.signal, fetchImpl: async (_, options) => {
    transportSignal = options.signal;
    return new Response(new ReadableStream({ pull() { ready(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  } });
  await reading; controller.abort(new Error(key)); await assert.rejects(pending, /cancel/i);
  assert.ok(transportSignal.aborted); assert.ok(cancelled);
});

test('one deadline spans headers and a stalled body, even when the injected transport ignores abort', async t => {
  let timer, transportSignal, ready; const reading = new Promise(resolve => { ready = resolve; });
  const clock = t.mock.method(globalThis, 'setTimeout', (fn, ms) => { assert.ok(ms > 0 && ms <= 30000); timer = fn; return 1; });
  const pending = fetchModels(origin, undefined, { fetchImpl: async (_, options) => {
    transportSignal = options.signal;
    return new Response(new ReadableStream({ pull() { ready(); } }, { highWaterMark: 0 }));
  } });
  await reading; assert.equal(clock.mock.callCount(), 1); timer();
  await assert.rejects(pending, /timed out/i); assert.ok(transportSignal.aborted);
});

test('derives an idempotent models URL without discarding the provider prefix', () => {
  for (const [base, expected] of [
    [origin, origin + '/v1/models'], [origin + '/', origin + '/v1/models'],
    [origin + '/tenant/api/', origin + '/tenant/api/models'],
    [origin + '/tenant/models/', origin + '/tenant/models'],
    [origin + '/tenant/v1/chat/completions', origin + '/tenant/v1/models'],
    [origin + '/tenant/v1/responses/', origin + '/tenant/v1/models'],
    [origin + '/responses', origin + '/models'],
    ['http://127.0.0.1:8000', 'http://127.0.0.1:8000/v1/models'],
    ['http://LOCALHOST:80/api', 'http://localhost/api/models'],
    ['http://[::1]:1100', 'http://[::1]:1100/v1/models']
  ]) {
    assert.equal(modelsUrl(base), expected);
    assert.equal(modelsUrl(expected), expected);
  }
});

test('rejects unsafe URL spellings before WHATWG URL normalization, without echoing input', () => {
  for (const input of [null, {}, 'relative', 'file:///tmp', 'http://fixture.invalid',
    'http://localhost.', 'http://localhost.fixture.invalid', 'http://127.1', 'http://127.0.0.2',
    'http://2130706433', 'http://0177.0.0.1', 'http://%6cocalhost', 'http://[0:0:0:0:0:0:0:1]',
    'https://fixture.invalid:bad', 'https://@fixture.invalid', 'https://user:pass@fixture.invalid',
    'https:////fixture.invalid', 'https:/fixture.invalid', 'https://fixture.invalid\\path',
    ...['?', '#', '?secret', '/#', '/api//child', '/a/../b', '/%2e/', '/%2f', '/%5C', '/%252f',
      '/%0a', '/api\n', '/\u202efoo', '/v1/messages/', '/v1/%6dessages'].map(suffix => origin + suffix)
  ]) assert.throws(() => modelsUrl(input), error => error instanceof Error &&
    !/fixture\.invalid|user:pass|secret|127\.1/i.test(error.message));
});
