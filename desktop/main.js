'use strict';

const {
  app, BrowserWindow, Menu, dialog, safeStorage, session, shell, utilityProcess,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP_NAME = '物流报价';
const APP_ID = 'com.berg.logisticsquote';
const gotLock = app.requestSingleInstanceLock();

let mainWindow = null;
let serverProcess = null;
let baseUrl = '';
let settings = null;
let quitting = false;
let serverLogStream = null;
let sessionCookieHeader = '';

app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
  app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
}

if (!gotLock) {
  app.quit();
}

function appRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.resolve(__dirname, '..');
}

function dataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function writeLog(text) {
  if (!serverLogStream) return;
  serverLogStream.write(`[${new Date().toISOString()}] ${String(text).trimEnd()}\n`);
}

function loadSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch (e) { saved = {}; }

  let password = '';
  if (saved.encryptedPassword) {
    try {
      password = safeStorage.decryptString(Buffer.from(saved.encryptedPassword, 'base64'));
    } catch (e) {
      password = '';
    }
  }
  if (!password) {
    password = crypto.randomBytes(24).toString('base64url');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 凭据加密不可用，无法安全保存本地管理员凭据');
  }
  saved.encryptedPassword = safeStorage.encryptString(password).toString('base64');
  saved.version = 1;
  const tmp = settingsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, settingsPath());
  return { saved, password };
}

function saveWindowBounds(bounds) {
  if (!settings) return;
  settings.saved.window = bounds;
  const tmp = settingsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings.saved, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, settingsPath());
}

function pythonPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'python', 'python.exe');
  const bundled = path.join(__dirname, 'resources', 'python', 'python.exe');
  if (fs.existsSync(bundled)) return bundled;
  return process.env.QUOTE_PYTHON || 'python';
}

function serverEnvironment() {
  const env = {
    ...process.env,
    PORT: baseUrl ? new URL(baseUrl).port : process.env.PORT,
    HOST: '127.0.0.1',
    QUOTE_DATA_DIR: dataDir(),
    QUOTE_DESKTOP: '1',
    QUOTE_REGISTRATION_OPEN: '0',
    QUOTE_SUPPRESS_ADMIN_PASSWORD_LOG: '1',
    QUOTE_PYTHON: pythonPath(),
    ADMIN_PASSWORD: settings.password,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  if (app.isPackaged) env.NODE_ENV = 'production';
  return env;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startServer() {
  const root = appRoot();
  const entry = path.join(root, 'server', 'server.js');
  if (!fs.existsSync(entry)) throw new Error(`找不到本地服务: ${entry}`);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(logDir(), { recursive: true });
  serverLogStream = fs.createWriteStream(path.join(logDir(), 'server.log'), { flags: 'a' });

  serverProcess = utilityProcess.fork(entry, [], {
    cwd: root,
    env: serverEnvironment(),
    serviceName: 'LogisticsQuote Local Server',
    stdio: 'pipe',
  });
  serverProcess.stdout?.on('data', d => writeLog(String(d)));
  serverProcess.stderr?.on('data', d => writeLog(String(d)));
  serverProcess.on('exit', code => {
    serverProcess = null;
    writeLog(`server exited: ${code}`);
    if (!quitting && mainWindow) {
      dialog.showErrorBox(APP_NAME, `本地报价服务已停止（退出码 ${code}）。\n日志: ${path.join(logDir(), 'server.log')}`);
      app.quit();
    }
  });
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/api/version', { cache: 'no-store' });
      if (res.status < 500) return;
    } catch (e) { /* wait */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`本地服务未在 ${timeoutMs / 1000} 秒内启动`);
}

async function loginDesktop() {
  const res = await fetch(baseUrl + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: settings.password }),
  });
  if (!res.ok) return false;
  const raw = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie') || '';
  const pair = raw.split(';')[0];
  const index = pair.indexOf('=');
  if (index < 0) return false;
  const name = pair.slice(0, index);
  const value = pair.slice(index + 1);
  sessionCookieHeader = `${name}=${value}`;
  await session.defaultSession.cookies.set({
    url: baseUrl,
    name,
    value,
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
  });
  return true;
}

function stopServer() {
  if (!serverProcess) return Promise.resolve();
  const child = serverProcess;
  serverProcess = null;
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 2500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    try { child.kill(); } catch (e) { clearTimeout(timer); resolve(); }
  });
}

async function resetAdminPassword() {
  const root = appRoot();
  const cli = path.join(root, 'server', 'user.js');
  await stopServer();
  await new Promise((resolve, reject) => {
    const child = utilityProcess.fork(cli, ['passwd', 'admin', settings.password], {
      cwd: root,
      env: serverEnvironment(),
      serviceName: 'LogisticsQuote Password Reset',
      stdio: 'pipe',
    });
    let output = '';
    child.stdout?.on('data', d => { output += String(d); });
    child.stderr?.on('data', d => { output += String(d); });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`重置桌面管理员密码失败（${code}）: ${output}`));
    });
  });
}

async function ensureDesktopLogin() {
  await waitForServer();
  if (await loginDesktop()) return;
  if (fs.existsSync(path.join(dataDir(), 'users.json'))) {
    await resetAdminPassword();
    await startServerWithPort();
    await waitForServer();
    if (await loginDesktop()) return;
  }
  throw new Error('桌面客户端自动登录失败，请查看日志目录');
}

async function startServerWithPort() {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  startServer();
}

function externalUrl(url) {
  return /^https?:\/\//i.test(url) && !url.startsWith(baseUrl);
}

function createWindow() {
  const savedBounds = settings.saved.window || {};
  const win = new BrowserWindow({
    width: savedBounds.width || 1440,
    height: savedBounds.height || 900,
    x: savedBounds.x,
    y: savedBounds.y,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;
  win.setMenuBarVisibility(false);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseUrl)) win.loadURL(url);
    else if (externalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(baseUrl)) return;
    event.preventDefault();
    if (externalUrl(url)) shell.openExternal(url);
  });

  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    if (mainWindow) saveWindowBounds(mainWindow.getBounds());
  });
  win.on('closed', () => { mainWindow = null; });
  return win;
}

function installMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(dataDir()) },
        { label: '打开日志目录', click: () => shell.openPath(logDir()) },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新', role: 'reload' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        ...(app.isPackaged ? [] : [{ label: '开发者工具', role: 'toggleDevTools' }]),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: `关于${APP_NAME}`,
            message: APP_NAME,
            detail: `版本 ${app.getVersion()}\n数据目录: ${dataDir()}`,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function bootstrap() {
  settings = loadSettings();
  installMenu();
  await startServerWithPort();
  await ensureDesktopLogin();
  const win = createWindow();
  let initialPath = '/';
  try {
    const dataRes = await fetch(baseUrl + '/api/data', {
      cache: 'no-store',
      headers: sessionCookieHeader ? { Cookie: sessionCookieHeader } : {},
    });
    if (dataRes.status === 503) initialPath = '/admin';
  } catch (e) { /* 默认打开首页 */ }
  await win.loadURL(baseUrl + initialPath);
}

app.whenReady().then(bootstrap).catch(async error => {
  writeLog(error.stack || error.message);
  await stopServer();
  dialog.showErrorBox(APP_NAME, `${error.message}\n\n日志: ${path.join(logDir(), 'server.log')}`);
  app.quit();
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopServer().finally(() => app.quit());
});
