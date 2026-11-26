'use strict';
const { tr } = require('./i18n');
const crypto = require('node:crypto');
const { parseDocument, parseGroups, upsertGroup, removeGroup } = require('./jsonc');
const VENDOR = 'customendpoint';
const TEMP_PREFIX = '__asong_byok_tmp_';
const API_TYPES = new Set(['responses', 'chat-completions', 'messages']);
const SECRET_REFERENCE = /^\$\{input:chat\.lm\.secret\.[^{}\s]+\}$/;
const isSecretRef = v => typeof v === 'string' && SECRET_REFERENCE.test(v);
const clone = value => JSON.parse(JSON.stringify(value));
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function equal(a, b) { return canonical(a) === canonical(b); }
function validUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(tr("每个模型都需要接口地址，或填写公共地址用于补全。", "Every model needs an endpoint URL or a shared default URL."));
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error(tr("接口地址不是有效 URL。", "Endpoint is not a valid URL.")); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error(tr("接口地址只支持 HTTP / HTTPS。", "Only HTTP / HTTPS endpoints are supported."));
  if (url.username || url.password || url.hash || url.search) {
    throw new Error(tr("接口地址不得携带用户名、密码、查询参数或片段。密钥请通过专用按钮录入。", "Endpoint URLs cannot contain usernames, passwords, query parameters or fragments. Enter keys using the dedicated button."));
  }
  return url.toString().replace(/\/$/, '');
}
function positiveInt(n, label) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}${tr("必须是大于 0 的整数。", " must be a positive integer.")}`);
}
function assertNoInlineSecrets(value) {
  if (Array.isArray(value)) return value.forEach(assertNoInlineSecrets);
  if (!value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (/^(api[-_]?key|authorization|proxy-authorization|x-api-key|token|access_token|secret|password)$/i.test(key)) {
      if (typeof v === 'string' && (v === '' || v.includes('${apiKey}'))) continue;
      throw new Error(tr("模型 JSON 含可能的明文凭据。请改用“录入 API Key”，请求头可使用 ${apiKey} 占位符。", "Model JSON may contain plaintext credentials. Use Enter API Key; request headers may use the ${apiKey} placeholder."));
    }
    assertNoInlineSecrets(v);
  }
}
function sanitizePreset(value) {
  if (Array.isArray(value)) return value.map(sanitizePreset);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, v] of Object.entries(value)) {
    // Drop all headers, not only common Authorization names; vendor-specific
    // credential headers must not be silently exported.
    if (/api[-_]?key|authorization|secret|password|requestHeaders/i.test(key) || /^(?:access[-_]?|refresh[-_]?|auth[-_]?)?token$/i.test(key)) continue;
    if (key === 'range' || key === 'modelsRange') continue;
    Object.defineProperty(result, key, { value: sanitizePreset(v), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function publicGroup(group) {
  const out = clone(group);
  delete out.apiKey; delete out.range; delete out.modelsRange;
  return out;
}
function buildGroup(form, template = {}) {
  if (!form || typeof form !== 'object') throw new Error(tr("表单数据无效。", "Invalid form data."));
  const name = typeof form.name === 'string' ? form.name.trim() : '';
  if (!name || name.length > 128 || /[\x00-\x1f\x7f]/.test(name) || name.startsWith(TEMP_PREFIX)) {
    throw new Error(tr("模型组名称不能为空、不能包含控制字符或使用工具保留前缀，且不能超过 128 字符。", "Group name must be nonempty, at most 128 characters, without control characters or a reserved prefix."));
  }
  if (!API_TYPES.has(form.apiType)) throw new Error(tr("请选择有效 API 协议。", "Select a valid API protocol."));
  const raw = parseDocument(form.modelsText).value;
  if (!Array.isArray(raw) || !raw.length || raw.length > 300) throw new Error(tr("models 必须是包含 1～300 个模型的数组。", "models must be an array containing 1–300 models."));
  const defaultUrl = form.defaultUrl?.trim() ? validUrl(form.defaultUrl) : undefined;
  const ids = new Set(); const warnings = [];
  const models = raw.map((source, index) => {
    const label = `${tr("第 ", "Model ")}${index + 1}${tr(" 个模型：", ": ")}`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(label + tr("需要对象。", "An object is required."));
    const model = clone(source);
    if (typeof model.id !== 'string' || !model.id.trim() || /[\x00-\x1f\x7f]/.test(model.id)) throw new Error(label + tr("id 无效。", "Invalid id."));
    model.id = model.id.trim();
    if (ids.has(model.id)) throw new Error(label + tr("id 重复。", "Duplicate id."));
    ids.add(model.id);
    if (typeof model.name !== 'string' || !model.name.trim()) model.name = model.id;
    model.url = validUrl(model.url || defaultUrl);
    if (model.apiType !== undefined && !API_TYPES.has(model.apiType)) throw new Error(label + tr("apiType 无效。", "Invalid apiType."));
    for (const flag of ['toolCalling', 'vision']) {
      if (typeof model[flag] !== 'boolean') throw new Error(label + flag + tr(" 必须为 true 或 false。", " must be true or false."));
    }
    for (const flag of ['thinking', 'adaptiveThinking', 'streaming', 'statefulResponses', 'zeroDataRetentionEnabled']) {
      if (model[flag] !== undefined && typeof model[flag] !== 'boolean') throw new Error(label + flag + tr(" 必须为布尔值。", " must be a boolean."));
    }
    positiveInt(model.maxOutputTokens, label + 'maxOutputTokens');
    if (model.contextWindow === undefined && model.maxInputTokens === undefined) throw new Error(label + tr("需要 contextWindow 或 maxInputTokens。", "contextWindow or maxInputTokens is required."));
    if (model.contextWindow !== undefined) {
      positiveInt(model.contextWindow, label + 'contextWindow');
      if (model.contextWindow <= model.maxOutputTokens) throw new Error(label + tr("contextWindow 必须大于 maxOutputTokens。", "contextWindow must exceed maxOutputTokens."));
    }
    if (model.maxInputTokens !== undefined) positiveInt(model.maxInputTokens, label + 'maxInputTokens');
    if (model.contextWindow !== undefined && model.maxInputTokens !== undefined && model.maxInputTokens + model.maxOutputTokens > model.contextWindow) {
      throw new Error(label + tr("输入与输出上限之和大于 contextWindow，请消除冲突。", "Input plus output limits exceed contextWindow. Resolve the conflict."));
    }
    if (model.supportsReasoningEffort !== undefined &&
        (!Array.isArray(model.supportsReasoningEffort) || !model.supportsReasoningEffort.every(e => typeof e === 'string' && !!e.trim()))) {
      throw new Error(label + tr("supportsReasoningEffort 必须是字符串数组。", "supportsReasoningEffort must be an array of strings."));
    }
    const apiType = model.apiType || form.apiType;
    const explicit = model.url.endsWith('/responses') ? 'responses' : model.url.endsWith('/chat/completions') ? 'chat-completions' : model.url.endsWith('/messages') ? 'messages' : null;
    if (explicit && explicit !== apiType) throw new Error(label + tr("URL 路径和 API 协议不一致。", "URL path and API protocol do not match."));
    if (form.stateless === true && apiType === 'responses') model.statefulResponses = false;
    const url = new URL(model.url);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      warnings.push(tr("存在非本机 HTTP 地址，使用时凭据和对话不受 TLS 加密保护。", "A non-local HTTP endpoint is present. Credentials and chats are not protected by TLS."));
    }
    assertNoInlineSecrets(model);
    return model;
  });
  const group = { ...publicGroup(template), name, vendor: VENDOR, apiType: form.apiType, models };
  // Group-level URL in newer providers enables automatic model discovery; this
  // tool uses explicit models and must not silently invoke that separate mode.
  delete group.url;
  return { group, warnings: [...new Set(warnings)] };
}
function importCandidates(text) {
  const value = parseDocument(text).value;
  const list = Array.isArray(value) ? value : [value];
  const groups = list.filter(g => g && g.vendor === VENDOR && Array.isArray(g.models));
  if (!groups.length) throw new Error(tr("文件中没有 customendpoint 模型组。请导入完整模型组对象或 chatLanguageModels.json 数组。", "No customendpoint group found. Import a full group object or a chatLanguageModels.json array."));
  return groups.map(g => {
    // Imported secret references are machine-local and must never be trusted.
    const result = sanitizePreset(g);
    result.vendor = VENDOR;
    return result;
  });
}
// Append only models. Preserve existing rows; never import a source group's key.
function mergeModels(form, incomingText, replace = false) {
  const current = parseDocument(form.modelsText).value;
  if (!Array.isArray(current)) throw new Error(tr("当前模型必须是数组。", "Current models must be an array."));
  const source = parseDocument(incomingText).value;
  const isGroup = item => item && typeof item === 'object' && Array.isArray(item.models);
  const items = Array.isArray(source) ? source : [source];
  const incoming = [];
  for (const item of items) {
    if (isGroup(item)) {
      for (const model of item.models) {
        if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error(tr("模型必须是对象。", "Model must be an object."));
        incoming.push(sanitizePreset({ ...model, ...(model.apiType === undefined && item.apiType !== undefined ? { apiType: item.apiType } : {}), ...(model.url === undefined && item.url !== undefined ? { url: item.url } : {}) }));
      }
    } else {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(tr("模型必须是对象。", "Model must be an object."));
      incoming.push(sanitizePreset(item));
    }
  }
  if (!incoming.length || incoming.length > 300) throw new Error(tr("一次追加 1～300 个模型。", "Append 1–300 models at a time."));
  // Validate new models and normalize their identifiers before matching.
  const normalized = buildGroup({ ...form, modelsText: JSON.stringify(incoming), stateless: false }).group.models;
  const output = clone(current); const index = new Map();
  output.forEach((m,i)=>{ if (!m || typeof m.id !== 'string' || index.has(m.id.trim())) throw new Error(tr("当前列表存在缺失或重复 ID，请先修复。", "Current list has missing or duplicate IDs. Fix them first.")); index.set(m.id.trim(),i); });
  let added=0, updated=0, skipped=0;
  for (const m of normalized) {
    if(index.has(m.id)) {
      if(replace===true) { output[index.get(m.id)]=m; updated++; } else skipped++;
    } else { index.set(m.id,output.length);output.push(m);added++; }
  }
  if(output.length>300) throw new Error(tr("合并后不能超过 300 个模型。", "The merged list cannot exceed 300 models."));
  return { models: output, added, updated, skipped };
}
function safeError(error, secrets = []) {
  let text = error instanceof Error ? error.message : tr("操作失败。", "Operation failed.");
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]').slice(0, 1500);
}

/**
 * io.read() -> { text }, io.write(expectedText, nextText), io.addGroup(group).
 * The caller must back up and confirm before entry. New API keys go ONLY to
 * VS Code's native secret-aware command, NEVER into file edits.
 * The temporary model group has no models: it cannot trigger model requests.
 */
async function commitGroup(io, group, { apiKey, reuseReference, noAuth = false } = {}) {
  const before = await io.read();
  const beforeRoot = parseGroups(before.text);
  const finalGroup = publicGroup(group);
  let tmpName; let stageText = before.text;
  try {
    if (apiKey) {
      if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey.trim()) || isSecretRef(apiKey)) {
        throw new Error(tr("请输入真实 API Key，而不是密钥引用或多行文本。", "Enter an actual API key, not a secret reference or multiline text."));
      }
      tmpName = TEMP_PREFIX + crypto.randomUUID();
      await io.addGroup({ name: tmpName, vendor: VENDOR, apiKey: apiKey.trim(), models: [] });
      const after = await io.read(); stageText = after.text;
      const afterRoot = parseGroups(after.text);
      const temporary = afterRoot.value.find(g => g.vendor === VENDOR && g.name === tmpName);
      if (!temporary || !isSecretRef(temporary.apiKey)) throw new Error(tr("原生密钥写入结果不符合预期；已停止，未提交目标模型组。", "Unexpected native secret result. Stopped before committing the target group."));
      const others = afterRoot.value.filter(g => g !== temporary);
      if (!equal(others, beforeRoot.value)) throw new Error(tr("写入过程中配置被其他窗口修改；已停止，避免覆盖其他改动。", "Configuration changed in another window during the write. Stopped to avoid overwriting other changes."));
      finalGroup.apiKey = temporary.apiKey;
    } else if (!noAuth) {
      if (!isSecretRef(reuseReference)) throw new Error(tr("没有可复用的本机密钥引用，请先录入 API Key；无认证接口需显式勾选。", "No reusable local key reference. Enter an API key or explicitly select an unauthenticated endpoint."));
      finalGroup.apiKey = reuseReference;
    }
    const next = upsertGroup(before.text, finalGroup);
    parseGroups(next);
    await io.write(stageText, next);
    stageText = next;
    const saved = await io.read();
    if (!equal(parseGroups(saved.text).value, parseGroups(next).value)) throw new Error(tr("写入后的配置校验失败，请查看备份，不要重复点击写入。", "Post-write validation failed. Check the backup; do not repeat the write."));
    return { group: finalGroup, text: saved.text, previousText: before.text };
  } catch (error) {
    let recoveryNote = '';
    try {
      const current = await io.read();
      const parsed = parseGroups(current.text);
      const hasTemp = tmpName && parsed.value.some(g => g.vendor === VENDOR && g.name === tmpName);
      if (hasTemp) {
        const remaining = parsed.value.filter(g => !(g.vendor === VENDOR && g.name === tmpName));
        const next = equal(remaining, beforeRoot.value) ? before.text : removeGroup(current.text, VENDOR, tmpName);
        await io.write(current.text, next);
        recoveryNote = tr(" 临时模型组已清理。", " Temporary group cleaned up.");
      } else if (current.text === stageText && stageText !== before.text) {
        await io.write(current.text, before.text);
        recoveryNote = tr(" 已恢复本次写入前的模型配置。", " Pre-write model configuration restored.");
      }
    } catch {
      recoveryNote = tr(" 自动恢复未完成，请从“恢复备份”检查；不要手动删除凭据数据库。", " Automatic recovery incomplete. Check Restore Backup; do not manually delete the credentials database.");
    }
    throw new Error(safeError(error, [apiKey]) + recoveryNote);
  }
}
module.exports = { VENDOR, TEMP_PREFIX, isSecretRef, clone, equal, digest, validUrl, buildGroup,
  publicGroup, sanitizePreset, importCandidates, mergeModels, safeError, commitGroup };
