'use strict';
// VS Code's UI language is fixed for the lifetime of an extension host.
let chinese = false;
function setLocale(locale) { chinese = /^zh(?:-|$)/i.test(locale || ''); }
function isChinese() { return chinese; }
function tr(zh, en) { return chinese ? zh : en; }
module.exports = { setLocale, isChinese, tr };
