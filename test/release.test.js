'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { releaseManifest } = require('../scripts/release');
const { setLocale, tr } = require('../src/i18n');
const pkg = require('../package.json');
test('release requires a real publisher and preserves local metadata', () => {
  for (const p of ['', 'asong-local', 'bad publisher', 'x;cmd']) assert.throws(() => releaseManifest(pkg,p));
  const output=releaseManifest(pkg,'example-dev','https://github.com/example-dev/byok-manager');
  assert.equal(output.publisher,'example-dev'); assert.equal(output.repository.url,'https://github.com/example-dev/byok-manager');
  assert.equal(pkg.publisher,'asong-local'); assert.equal(output.name,'byok-manager');
});
test('release rejects credential-bearing and non-HTTPS repository URLs', () => {
  for (const u of ['http://example.com/a','https://user:pass@example.com/a','https://example.com/a?token=abc','https://example.com/a#x']) assert.throws(()=>releaseManifest(pkg,'example-dev',u));
});
test('localized package metadata keys and UI IDs match',()=>{
  const en=require('../package.nls.json'), zh=require('../package.nls.zh-cn.json');
  assert.deepEqual(Object.keys(en).sort(),Object.keys(zh).sort());
  const ids=file=>Array.from(fs.readFileSync(path.join(__dirname,'../media',file),'utf8').matchAll(/\bid="([^"]+)"/g),m=>m[1]).sort();
  assert.deepEqual(ids('index.html'),ids('index.zh-cn.html'));
  setLocale('zh-cn');assert.equal(tr('中文','English'),'中文');setLocale('fr');assert.equal(tr('中文','English'),'English');
});
