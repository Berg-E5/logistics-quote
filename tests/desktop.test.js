'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const desktop = path.join(root, 'desktop');
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const main = fs.readFileSync(path.join(desktop, 'main.js'), 'utf8');
const setupHtml = fs.readFileSync(path.join(desktop, 'setup.html'), 'utf8');
const setupJs = fs.readFileSync(path.join(desktop, 'setup.js'), 'utf8');
const preload = fs.readFileSync(path.join(desktop, 'preload.js'), 'utf8');

test('Windows 客户端是只包含远程界面的轻量安装包', () => {
  assert.equal(pkg.version, '1.5.0');
  assert.equal(pkg.build.extraResources, undefined);
  assert.doesNotMatch(pkg.scripts.start, /prepare:python/);
  assert.doesNotMatch(pkg.scripts.dist, /prepare:python/);
  assert.equal(pkg.build.win.icon, 'assets/icon.ico');
  assert.ok(fs.existsSync(path.join(desktop, 'assets', 'icon.ico')));
  for (const file of ['setup.html', 'setup.js', 'preload.js', 'connection.html', 'connection.js']) {
    assert.ok(pkg.build.files.includes(file), `missing packaged file: ${file}`);
  }
  assert.equal(fs.existsSync(path.join(desktop, 'scripts', 'prepare-python.ps1')), false);
});

test('渲染进程保持隔离且没有本地服务启动路径', () => {
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.doesNotMatch(main, /utilityProcess|QUOTE_DATA_DIR|QUOTE_REGISTRATION_OPEN|startServerWithPort/);
  assert.doesNotMatch(main, /runAdminCli|本地管理员服务|本机模式/);
  assert.match(main, /autoHideMenuBar: false/);
  assert.match(main, /setMenuBarVisibility\(true\)/);
});

test('首次启动和后续设置只允许连接中央服务器', () => {
  assert.match(main, /function ensureCentralConnection/);
  assert.match(main, /此客户端只允许连接中央服务器/);
  assert.match(main, /payload\?\.mode !== 'remote'/);
  assert.match(main, /中央服务器必须使用 HTTPS 地址/);
  assert.doesNotMatch(main, /pending\.resolve\(\{ mode: 'local'/);
  assert.match(main, /DEFAULT_SERVER = 'https:\/\/quote\.byberg\.store'/);
  assert.match(main, /serverUrl: settings\.saved\.serverUrl \|\| DEFAULT_SERVER/);
  assert.match(main, /verifyRemoteServer/);
  assert.match(main, /connection:retry/);
  assert.match(main, /服务器设置/);
  assert.match(setupHtml, /强制服务器模式/);
  assert.match(setupHtml, /id="serverUrl"/);
  assert.doesNotMatch(setupHtml, /id="username"|本机独立|高级：本机/);
  assert.match(setupJs, /mode: 'remote'/);
  assert.doesNotMatch(setupJs, /mode: 'local'|localReady|username|password/);
  assert.match(preload, /submit\(payload\)/);
});

test('客户端不在本地保存管理员凭据', () => {
  assert.doesNotMatch(main, /safeStorage/);
  assert.doesNotMatch(main, /settings\.password/);
  assert.doesNotMatch(main, /adminSetupVersion/);
  assert.match(main, /delete settings\.saved\.encryptedPassword/);
});

test('后台和桌面菜单都提供前台报价入口', () => {
  assert.match(main, /label: '前台报价'/);
  const adminCommon = fs.readFileSync(path.join(root, 'public', 'admin-common.js'), 'utf8');
  assert.match(adminCommon, /href="\/"><span class="sb-sym">↗<\/span><span>打开前台报价/);
  for (const file of ['admin.html', 'changes.html', 'users.html']) {
    const html = fs.readFileSync(path.join(root, 'server', file), 'utf8');
    assert.match(html, /<AppSidebar/);
  }
});

test('客户端安全检查更新且不静默安装未签名包', () => {
  assert.match(main, /RELEASES_API/);
  assert.match(main, /checkForUpdates/);
  assert.match(main, /compareVersions/);
  assert.match(main, /shell\.openExternal/);
  assert.doesNotMatch(main, /electron-updater|autoUpdater\.quitAndInstall/);
  assert.match(main, /检查更新/);
  assert.match(pkg.scripts.dist, /config\.electronDist=node_modules\/electron\/dist/);
  assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'desktop.yml')));
});
