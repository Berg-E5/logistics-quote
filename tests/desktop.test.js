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
  for (const file of ['setup.html', 'setup.js', 'preload.js', 'connection.html', 'connection.js']) {
    assert.ok(pkg.build.files.includes(file), `missing packaged file: ${file}`);
  }
});

test('桌面端保持渲染进程隔离并保护本机服务', () => {
  assert.match(main, /HOST: '127\.0\.0\.1'/);
  assert.match(main, /QUOTE_DATA_DIR/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /QUOTE_REGISTRATION_OPEN: '0'/);
  assert.match(main, /autoHideMenuBar: false/);
  assert.match(main, /setMenuBarVisibility\(true\)/);
});

test('桌面端不在本地保存管理员明文密码', () => {
  assert.doesNotMatch(main, /safeStorage/);
  assert.doesNotMatch(main, /settings\.password/);
  assert.doesNotMatch(main, /encryptedPassword = safeStorage/);
  assert.match(main, /adminSetupVersion = 1/);
});

test('首次启动支持本机管理员和中央服务器两种模式', () => {
  assert.match(main, /showAdminSetup/);
  assert.match(main, /\['add', value\.username, value\.password\]/);
  assert.match(main, /pending\.resolve\(null\)/);
  assert.match(main, /if \(!connection\) return/);
  assert.match(main, /verifyRemoteServer/);
  assert.match(main, /connectionMode = 'remote'/);
  assert.match(main, /body\.apiVersion/);
  assert.match(main, /apiVersion\) < 3/);
  assert.match(main, /function isAppUrl/);
  assert.match(main, /loadConnectionError/);
  assert.match(main, /connection:retry/);
  assert.match(main, /await waitForServer\(\);\s+if \(!connection\.existing\)/);
  assert.match(main, /设置登录方式/);
  assert.ok(fs.existsSync(path.join(desktop, 'setup.html')));
  const setupHtml = fs.readFileSync(path.join(desktop, 'setup.html'), 'utf8');
  const setupJs = fs.readFileSync(path.join(desktop, 'setup.js'), 'utf8');
  const preload = fs.readFileSync(path.join(desktop, 'preload.js'), 'utf8');
  assert.match(setupHtml, /id="username"/);
  assert.match(setupHtml, /id="serverUrl"/);
  assert.match(setupHtml, /data-mode="remote"/);
  assert.match(setupJs, /mode: 'remote'/);
  assert.match(setupJs, /quote\.byberg\.store/);
  assert.match(preload, /submit\(payload\)/);
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
  assert.equal(pkg.version, '1.4.0');
  assert.match(pkg.scripts.dist, /config\.electronDist=node_modules\/electron\/dist/);
  assert.ok(fs.existsSync(path.join(root, '.github', 'workflows', 'desktop.yml')));
});

test('桌面 Python 运行时和依赖都做完整性校验', () => {
  const prepare = fs.readFileSync(path.join(desktop, 'scripts', 'prepare-python.ps1'), 'utf8');
  const requirements = fs.readFileSync(path.join(root, 'deploy', 'python-requirements.txt'), 'utf8');
  assert.match(prepare, /SHA256\]::Create/);
  assert.match(prepare, /PythonZipSha256/);
  assert.match(prepare, /--require-hashes/);
  assert.match(prepare, /--only-binary=:all:/);
  assert.match(prepare, /ZipFile\]::ExtractToDirectory/);
  assert.doesNotMatch(prepare, /Expand-Archive/);
  assert.match(requirements, /openpyxl==3\.1\.5/);
  assert.match(requirements, /et_xmlfile==2\.0\.0/);
  assert.match(requirements, /defusedxml==0\.7\.1/);
  assert.match(requirements, /--hash=sha256:/);
});
