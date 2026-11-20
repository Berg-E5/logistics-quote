'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('HTML 内联 JavaScript 语法正确', () => {
  const files = [
    'index.html',
    'public/index.html',
    'server/admin.html',
    'server/overview.html',
    'server/workspaces.html',
    'server/security.html',
    'server/imports.html',
    'server/changes.html',
    'server/users.html',
    'desktop/setup.html',
    'desktop/connection.html',
  ];
  for (const relative of files) {
    const html = fs.readFileSync(path.join(root, relative), 'utf8');
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    for (let i = 0; i < scripts.length; i++) {
      assert.doesNotThrow(
        () => new vm.Script(scripts[i][1], { filename: `${relative}#inline-${i + 1}` }),
        `${relative} inline script ${i + 1} 语法错误`,
      );
    }
  }
});
