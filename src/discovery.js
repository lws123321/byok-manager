'use strict';
const { tr } = require('./i18n');

const unsafeText = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const messages = {
  url: ['模型发现地址无效。请使用 HTTPS，或使用本机回环 HTTP 地址。', 'Invalid discovery endpoint. Use HTTPS or an exact loopback HTTP address.'],
  list: ['服务未返回有效的模型列表。', 'The service did not return a valid model list.'],
  size: ['模型列表超出大小限制。', 'The model list exceeds the size limit.'],
  key: ['API Key 无效。', 'Invalid API key.'],
  cancelled: ['模型发现已取消。', 'Model discovery cancelled.'],
  timeout: ['模型发现请求超时。', 'Model discovery timed out.'],
  401: ['身份验证失败 (401)。请检查 API Key。', 'Authentication failed (401). Check the API key.'],
  403: ['无权读取模型列表 (403)。', 'Access to the model list was denied (403).'],
  404: ['未找到模型列表 (404)。请检查接口地址。', 'Model list not found (404). Check the endpoint.'],
  429: ['请求过于频繁 (429)。请稍后再试。', 'Too many requests (429). Try again later.'],
  request: ['无法请求模型列表。', 'Could not request the model list.']
};
class DiscoveryError extends Error {
  constructor(code) {
    const safe = (typeof code === 'number' || typeof code === 'string') && Object.hasOwn(messages, code) ? code : 'request';
    super(tr(...messages[safe]));
    this.code = safe;
  }
}
function invalidUrl() { return new DiscoveryError('url'); }

function modelsUrl(defaultUrl) {
  if (typeof defaultUrl !== 'string' || /[\s?#\\]/u.test(defaultUrl) || unsafeText.test(defaultUrl)) throw invalidUrl();
  const parts = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(defaultUrl);
  if (!parts || /[@%]/.test(parts[2])) throw invalidUrl();
  // URL normalizes numeric IPv4 aliases and alternate IPv6 spellings before exposing hostname.
  if (parts[1].toLowerCase() === 'http' && !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(parts[2])) throw invalidUrl();
  const path = parts[3] || '/';
  if (path.includes('//') || /%(?:2f|5c|25)/i.test(path)) throw invalidUrl();
  let url, decoded;
  try { url = new URL(defaultUrl); decoded = decodeURIComponent(path); } catch { throw invalidUrl(); }
  if (unsafeText.test(decoded) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded)) throw invalidUrl();
  const segments = url.pathname.split('/').slice(1);
  if (segments.at(-1) === '') segments.pop();
  const last = decodeURIComponent(segments.at(-1) || '');
  if (last === 'messages') throw invalidUrl();
  if (!segments.length) segments.push('v1');
  else if (last === 'responses' || last === 'models') segments.pop();
  else if (last === 'completions' && decodeURIComponent(segments.at(-2) || '') === 'chat') segments.splice(-2);
  segments.push('models');
  url.pathname = '/' + segments.join('/');
  return url.href;
}

const MAX_BYTES = 1024 * 1024;
const MAX_ITEMS = 1000;
const TIMEOUT_MS = 10000;
const tokenFields = {
  contextWindow: ['contextWindow', 'context_window', 'context_length'],
  maxInputTokens: ['maxInputTokens', 'max_input_tokens'],
  maxOutputTokens: ['maxOutputTokens', 'max_output_tokens']
};
function safeLabel(value, key) {
  return typeof value === 'string' && value.length <= 256 && value.trim() &&
    !unsafeText.test(value) && !value.includes('$(') && !(key && value.includes(key));
}
function invalidList() { return new DiscoveryError('list'); }
function sizeLimit() { return new DiscoveryError('size'); }

function parseModels(bytes, key) {
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalidList(); }
  if (!Array.isArray(payload?.data)) throw invalidList();
  if (payload.data.length > MAX_ITEMS) throw sizeLimit();
  const result = [], seen = new Set();
  for (const entry of payload.data) {
    if (!entry || !Object.hasOwn(entry, 'id') || !safeLabel(entry.id, key)) continue;
    const id = entry.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const model = { id };
    if (Object.hasOwn(entry, 'name') && safeLabel(entry.name, key)) model.name = entry.name.trim();
    for (const [field, aliases] of Object.entries(tokenFields)) {
      const values = aliases.filter(alias => Object.hasOwn(entry, alias)).map(alias => entry[alias]);
      const [value] = values;
      if (Number.isSafeInteger(value) && value > 0 && values.every(v => v === value)) model[field] = value;
    }
    for (const flag of ['toolCalling', 'vision', 'thinking']) {
      if (Object.hasOwn(entry, flag) && typeof entry[flag] === 'boolean') model[flag] = entry[flag];
    }
    result.push(model);
  }
  return result;
}

async function readBody(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw sizeLimit();
  if (!response.body) throw invalidList();
  const reader = response.body.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = new Uint8Array(0), length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      const next = length + value.byteLength;
      if (next > MAX_BYTES) throw sizeLimit();
      // Fetch delivers decompressed bytes, not necessarily the advertised Content-Length.
      if (next > bytes.length) {
        const grown = new Uint8Array(Math.min(MAX_BYTES, Math.max(next, 4096, bytes.length * 2)));
        grown.set(bytes); bytes = grown;
      }
      bytes.set(value, length); length = next;
    }
    return bytes.subarray(0, length);
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

async function fetchModels(url, key, { signal, fetchImpl = globalThis.fetch } = {}) {
  const destination = modelsUrl(url);
  const headers = { Accept: 'application/json' };
  if (key != null && key !== '') {
    if (typeof key !== 'string' || !/^[\x21-\x7e]+$/.test(key) || key.includes('${')) {
      throw new DiscoveryError('key');
    }
    headers.Authorization = 'Bearer ' + key;
  }
  const controller = new AbortController();
  const cancelled = () => new DiscoveryError('cancelled');
  if (signal?.aborted) throw cancelled();
  let stop;
  const interrupted = new Promise((_, reject) => { stop = error => { reject(error); controller.abort(); }; });
  const cancel = () => stop(cancelled());
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop(new DiscoveryError('timeout')), TIMEOUT_MS);
  async function request() {
    const response = await fetchImpl(destination, {
      method: 'GET', headers, credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: controller.signal
    });
    controller.signal.throwIfAborted();
    if (response.redirected || !response.ok) throw new DiscoveryError(response.status);
    const bytes = await readBody(response, controller.signal);
    controller.signal.throwIfAborted();
    return parseModels(bytes, key);
  }
  try { return await Promise.race([request(), interrupted]); }
  catch (error) {
    controller.abort();
    // Reconstruct the error from a known code; never return an exception from the transport.
    throw new DiscoveryError(error instanceof DiscoveryError ? error.code : 'request');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

module.exports = { modelsUrl, fetchModels, DiscoveryError };
