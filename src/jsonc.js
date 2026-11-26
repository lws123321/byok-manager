'use strict';
const { tr } = require('./i18n');

// Small strict JSONC parser: supports comments, BOM and trailing commas.
// Retains source offsets so unrelated provider groups and comments can be preserved.
// Error messages intentionally never echo input (it may contain credentials).
function parseDocument(text) {
  if (typeof text !== 'string' || text.length > 4 * 1024 * 1024) {
    throw new Error(tr("配置必须是小于 4 MB 的文本。", "Configuration must be text under 4 MB."));
  }
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  function fail(message) {
    const lines = text.slice(0, i).split('\n');
    throw new Error(`${tr("JSONC 第 ", "JSONC line ")}${lines.length}${tr(" 行、第 ", ", column ")}${lines.at(-1).length + 1}${tr(" 列：", ": ")}${message}`);
  }
  function skip() {
    for (;;) {
      while (i < text.length && /[\t\r\n ]/.test(text[i])) i++;
      if (text.slice(i, i + 2) === '//') {
        i += 2;
        while (i < text.length && text[i] !== '\n') i++;
      } else if (text.slice(i, i + 2) === '/*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail(tr("块注释没有结束。", "Unterminated block comment."));
        i = end + 2;
      } else return;
    }
  }
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') {
        try { return { value: JSON.parse(text.slice(start, i)), start, end: i }; }
        catch { fail(tr("字符串或转义字符无效。", "Invalid string or escape sequence.")); }
      }
    }
    fail(tr("字符串没有结束。", "Unterminated string."));
  }
  function value(depth = 0) {
    if (depth > 100) fail(tr("嵌套超过 100 层。", "Nesting exceeds 100 levels."));
    skip();
    const start = i;
    if (text[i] === '"') return string();
    if (text[i] === '[') {
      i++; skip(); const children = [];
      if (text[i] !== ']') {
        for (;;) {
          children.push(value(depth + 1)); skip();
          if (text[i] === ']') break;
          if (text[i++] !== ',') fail(tr("数组元素之间需要逗号。", "Expected comma between array elements."));
          skip(); if (text[i] === ']') break;
        }
      }
      if (text[i++] !== ']') fail(tr("数组没有结束。", "Unterminated array."));
      return { value: children.map(n => n.value), start, end: i, children };
    }
    if (text[i] === '{') {
      i++; skip(); const out = {}; const seen = new Set();
      if (text[i] !== '}') {
        for (;;) {
          if (text[i] !== '"') fail(tr("属性名需要双引号。", "Property names must use double quotes."));
          const key = string().value;
          if (seen.has(key)) fail(tr("存在重复属性，请先消除歧义。", "Duplicate property; resolve the ambiguity first."));
          seen.add(key); skip();
          if (text[i++] !== ':') fail(tr("属性后需要冒号。", "Expected colon after property."));
          const child = value(depth + 1);
          Object.defineProperty(out, key, { value: child.value, enumerable: true, writable: true, configurable: true });
          skip(); if (text[i] === '}') break;
          if (text[i++] !== ',') fail(tr("属性之间需要逗号。", "Expected comma between properties."));
          skip(); if (text[i] === '}') break;
        }
      }
      if (text[i++] !== '}') fail(tr("对象没有结束。", "Unterminated object."));
      return { value: out, start, end: i };
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!match) fail(tr("缺少值或值格式不正确。", "Missing or invalid value."));
    i += match[0].length;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) fail(tr("数字超出支持范围。", "Number exceeds supported range."));
    return { value: parsed, start, end: i };
  }
  const root = value(); skip();
  if (i !== text.length) fail(tr("根节点之后存在多余内容。", "Unexpected content after root value."));
  return root;
}

function parseGroups(text) {
  const root = parseDocument(text);
  if (!Array.isArray(root.value)) throw new Error(tr("模型配置的根节点必须是数组。", "The model configuration root must be an array."));
  const seen = new Set();
  for (const group of root.value) {
    if (!group || typeof group !== 'object' || Array.isArray(group) ||
        typeof group.name !== 'string' || typeof group.vendor !== 'string') {
      throw new Error(tr("每个模型组都必须包含 name 和 vendor。", "Each model group must include name and vendor."));
    }
    const key = JSON.stringify([group.vendor, group.name]);
    if (seen.has(key)) throw new Error(tr("配置中存在同名、同 vendor 的模型组，请先处理重复项。", "Duplicate groups with the same name and vendor. Resolve duplicates first."));
    seen.add(key);
  }
  return root;
}

function upsertGroup(text, group) {
  const root = parseGroups(text);
  const index = root.value.findIndex(g => g.vendor === group.vendor && g.name === group.name);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = JSON.stringify(group, null, '\t').replace(/\n/g, eol + '\t');
  if (index >= 0) {
    const node = root.children[index];
    return text.slice(0, node.start) + body + text.slice(node.end);
  }
  if (!root.children.length) {
    const end = root.end - 1;
    return text.slice(0, end) + eol + '\t' + body + eol + text.slice(end);
  }
  const last = root.children.at(-1);
  // Put the new value immediately after the last object, before any trailing
  // comma/comments. Both trailing-comma and no-trailing-comma input stay valid.
  return text.slice(0, last.end) + ',' + eol + '\t' + body + text.slice(last.end);
}

function removeGroup(text, vendor, name) {
  const root = parseGroups(text);
  const index = root.value.findIndex(g => g.vendor === vendor && g.name === name);
  if (index < 0) return text;
  const node = root.children[index];
  if (root.children.length === 1) {
    return text.slice(0, root.start + 1) + text.slice(root.end - 1);
  }
  if (index < root.children.length - 1) {
    return text.slice(0, node.start) + text.slice(root.children[index + 1].start);
  }
  // Keep the trailing text, including a possible comma: it becomes the previous
  // element's trailing comma. The comma before the removed element is removed.
  const prev = root.children[index - 1];
  return text.slice(0, prev.end) + text.slice(node.end);
}

module.exports = { parseDocument, parseGroups, upsertGroup, removeGroup };
