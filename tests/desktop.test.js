'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const desktop = path.join(root, 'desktop');
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const main = fs.readFileSync(path.join(desktop, 'main.js'), 'utf8');

test('Electron 桌面配置会携带 Web、Node 和 Python 资源', () => {
  const resources = pkg.build.extraResources.map(x => x.to);
  for (const target of ['app/server', 'app/public', 'app/scripts', 'python']) {
    assert.ok(resources.includes(target), `missing extra resource: ${target}`);
  }
  assert.equal(pkg.build.win.icon, 'assets/icon.ico');
  assert.ok(fs.existsSync(path.join(desktop, 'assets', 'icon.ico')));
});

test('桌面窗口只使用本地服务并保持渲染进程隔离', () => {
  assert.match(main, /HOST: '127\.0\.0\.1'/);
  assert.match(main, /QUOTE_DATA_DIR/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /QUOTE_REGISTRATION_OPEN: '0'/);
});

test('桌面管理员凭据使用 safeStorage 加密', () => {
  assert.match(main, /safeStorage\.encryptString/);
  assert.match(main, /safeStorage\.decryptString/);
  assert.match(main, /ADMIN_PASSWORD: settings\.password/);
});
