'use strict';

const {
  app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, session, shell, utilityProcess,
} = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

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
let setupWindow = null;
let setupResolver = null;
let bootstrapping = true;

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

function readSettingsFile() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch (e) { saved = {}; }
  return saved;
}

function loadSettings() {
  const saved = readSettingsFile();
  let password = '';
  if (saved.encryptedPassword) {
    try {
      password = safeStorage.decryptString(Buffer.from(saved.encryptedPassword, 'base64'));
    } catch (e) {
      password = '';
    }
  }
  return { saved, password };
}

function persistSettings(saved) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 凭据加密不可用，无法安全保存本地管理员凭据');
  }
  saved.version = 1;
  const tmp = settingsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, settingsPath());
}

function saveAdminPassword(password) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 凭据加密不可用，无法安全保存本地管理员凭据');
  }
  settings.password = password;
  settings.saved.encryptedPassword = safeStorage.encryptString(password).toString('base64');
  settings.saved.adminSetupVersion = 1;
  settings.saved.adminSetupAt = new Date().toISOString();
  persistSettings(settings.saved);
}

function saveWindowBounds(bounds) {
  if (!settings) return;
  settings.saved.window = bounds;
  persistSettings(settings.saved);
}

function adminUserExists() {
  const usersFile = path.join(dataDir(), 'users.json');
  if (!fs.existsSync(usersFile)) return false;
  try {
    const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    return Array.isArray(users) && users.some(u => String(u.username || '').toLowerCase() === 'admin');
  } catch (e) {
    return false;
  }
}

function serverEnvironment() {
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    QUOTE_DATA_DIR: dataDir(),
    QUOTE_DESKTOP: '1',
    QUOTE_REGISTRATION_OPEN: '0',
    QUOTE_SUPPRESS_ADMIN_PASSWORD_LOG: '1',
    QUOTE_PYTHON: pythonPath(),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  const port = baseUrl ? new URL(baseUrl).port : process.env.PORT;
  if (port) env.PORT = String(port);
  if (settings?.password) env.ADMIN_PASSWORD = settings.password;
  if (app.isPackaged) env.NODE_ENV = 'production';
  return env;
}

function pythonPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'python', 'python.exe');
  const bundled = path.join(__dirname, 'resources', 'python', 'python.exe');
  if (fs.existsSync(bundled)) return bundled;
  return process.env.QUOTE_PYTHON || 'python';
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

function runAdminCli(args, serviceName) {
  const root = appRoot();
  const cli = path.join(root, 'server', 'user.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: {
        ...serverEnvironment(),
        ELECTRON_RUN_AS_NODE: '1',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', d => { output += String(d); });
    child.stderr.on('data', d => { output += String(d); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(output);
      else reject(new Error(`管理员账户操作失败（${code}）: ${output.trim()}`));
    });
  });
}

async function resetAdminPassword() {
  await stopServer();
  await runAdminCli(['passwd', 'admin', settings.password], 'LogisticsQuote Password Reset');
}

function showAdminSetup(reset) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 560,
      height: 640,
      resizable: false,
      maximizable: false,
      minimizable: true,
      show: false,
      title: reset ? '重置管理员密码' : '创建管理员账户',
      icon: path.join(__dirname, 'assets', 'icon.ico'),
      backgroundColor: '#0b1220',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    setupWindow = win;
    setupResolver = { resolve, reject };
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      setupWindow = null;
      if (setupResolver) {
        const pending = setupResolver;
        setupResolver = null;
        pending.reject(new Error('管理员账户设置已取消'));
      }
    });
    win.loadFile(path.join(__dirname, 'setup.html'), {
      query: { mode: reset ? 'reset' : 'create' },
    });
  });
}

ipcMain.handle('admin-setup:submit', (event, payload) => {
  const senderUrl = event.senderFrame?.url || '';
  if (!senderUrl.startsWith('file://')) {
    return { ok: false, error: '非法请求来源' };
  }
  const password = String(payload?.password || '');
  const confirmPassword = String(payload?.confirmPassword || '');
  if (password.length < 8) return { ok: false, error: '密码至少 8 位' };
  if (password.length > 128) return { ok: false, error: '密码不能超过 128 位' };
  if (password !== confirmPassword) return { ok: false, error: '两次输入的密码不一致' };
  if (!setupResolver) return { ok: false, error: '设置窗口已经关闭' };
  const pending = setupResolver;
  setupResolver = null;
  pending.resolve({ password });
  if (setupWindow) setupWindow.close();
  return { ok: true };
});

ipcMain.on('admin-setup:cancel', event => {
  if ((event.senderFrame?.url || '').startsWith('file://') && setupWindow) {
    setupWindow.close();
  }
});

async function ensureAdminAccount() {
  const hasAdmin = adminUserExists();
  const setupComplete = Number(settings.saved.adminSetupVersion || 0) >= 1;
  if (hasAdmin && settings.password && setupComplete) return;

  if (hasAdmin && (!settings.password || !setupComplete)) {
    while (true) {
      const value = await showAdminSetup(true);
      try {
        await runAdminCli(['passwd', 'admin', value.password], 'LogisticsQuote Admin Password Reset');
        saveAdminPassword(value.password);
        return;
      } catch (e) {
        dialog.showErrorBox(APP_NAME, e.message);
      }
    }
  }

  if (!hasAdmin && settings.password && setupComplete) {
    await runAdminCli(['add', 'admin', settings.password], 'LogisticsQuote Admin Creation');
    return;
  }

  while (true) {
    const value = await showAdminSetup(false);
    try {
      await runAdminCli(['add', 'admin', value.password], 'LogisticsQuote Admin Creation');
      saveAdminPassword(value.password);
      return;
    } catch (e) {
      dialog.showErrorBox(APP_NAME, e.message);
    }
  }
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
        {
          label: '前台报价',
          accelerator: 'CmdOrCtrl+1',
          click: () => { if (mainWindow) mainWindow.loadURL(baseUrl + '/'); },
        },
        {
          label: '后台管理',
          accelerator: 'CmdOrCtrl+2',
          click: () => { if (mainWindow) mainWindow.loadURL(baseUrl + '/admin'); },
        },
        { type: 'separator' },
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
  await ensureAdminAccount();
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
  bootstrapping = false;
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

app.on('window-all-closed', () => {
  if (bootstrapping) return;
  app.quit();
});

app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopServer().finally(() => app.quit());
});
