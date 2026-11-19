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
  for (const file of ['setup.html', 'setup.js', 'preload.js']) {
    assert.ok(pkg.build.files.includes(file), `missing packaged file: ${file}`);
  }
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
  assert.match(main, /env\.ADMIN_PASSWORD = settings\.password/);
  assert.match(main, /adminSetupVersion = 1/);
});

test('首次启动要求用户创建管理员账户', () => {
  assert.match(main, /showAdminSetup/);
  assert.match(main, /\['add', 'admin', value\.password\]/);
  assert.match(main, /创建管理员账户/);
  assert.ok(fs.existsSync(path.join(desktop, 'setup.html')));
});

test('后台和桌面菜单都提供前台报价入口', () => {
  assert.match(main, /label: '前台报价'/);
  const adminCommon = fs.readFileSync(path.join(root, 'public', 'admin-common.js'), 'utf8');
  assert.match(adminCommon, /href="\/"><span>前台报价/);
  for (const file of ['admin.html', 'changes.html', 'users.html']) {
    const html = fs.readFileSync(path.join(root, 'server', file), 'utf8');
    assert.match(html, /href:'\/', text:'前台报价'/);
  }
});
