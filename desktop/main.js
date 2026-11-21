'use strict';

const {
  app, BrowserWindow, Menu, dialog, ipcMain, shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = '物流报价';
const APP_ID = 'com.berg.logisticsquote';
const DEFAULT_SERVER = 'https://quote.byberg.store';
const RELEASES_API = 'https://api.github.com/repos/Berg-E5/logistics-quote/releases/latest';
const RELEASES_PREFIX = 'https://github.com/Berg-E5/logistics-quote/releases/';
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

let mainWindow = null;
let baseUrl = '';
let settings = null;
let logStream = null;
let setupWindow = null;
let setupResolver = null;
let updateCheckPromise = null;

app.setName(process.env.QUOTE_DESKTOP_USER_DATA ? `${APP_NAME} Dev` : APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
  app.setPath('userData', process.env.QUOTE_DESKTOP_USER_DATA
    ? path.resolve(process.env.QUOTE_DESKTOP_USER_DATA)
    : path.join(app.getPath('appData'), APP_NAME));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function writeLog(text) {
  if (!logStream) return;
  logStream.write(`[${new Date().toISOString()}] ${String(text).trimEnd()}\n`);
}

function initLogging() {
  fs.mkdirSync(logDir(), { recursive: true });
  logStream = fs.createWriteStream(path.join(logDir(), 'client.log'), { flags: 'a' });
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
  return { saved };
}

function persistSettings(saved) {
  saved.version = 1;
  const tmp = settingsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, settingsPath());
}

function markRemoteConnection(serverUrl) {
  settings.saved.connectionMode = 'remote';
  settings.saved.serverUrl = serverUrl;
  settings.saved.connectionConfiguredAt = new Date().toISOString();
  delete settings.saved.encryptedPassword;
  persistSettings(settings.saved);
}

function normalizeServerUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) throw new Error('请填写中央服务器地址');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'https://' + value;
  let parsed;
  try { parsed = new URL(value); }
  catch (e) { throw new Error('服务器地址格式不正确'); }
  if (parsed.protocol !== 'https:') {
    throw new Error('中央服务器必须使用 HTTPS 地址');
  }
  if (parsed.username || parsed.password) throw new Error('服务器地址不能包含账号密码');
  if (parsed.search || parsed.hash) throw new Error('服务器地址不能包含查询参数或锚点');
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new Error('客户端需要连接网站根地址，不要填写子目录');
  }
  return parsed.origin;
}

async function verifyRemoteServer(serverUrl) {
  let res;
  try {
    res = await fetch(serverUrl + '/api/version', {
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    throw new Error(`无法连接中央服务器: ${e.message}`);
  }
  if (!res.ok) throw new Error(`中央服务器返回 HTTP ${res.status}`);
  let body;
  try { body = await res.json(); }
  catch (e) { throw new Error('填写的地址不是物流报价服务器'); }
  if (!body || !Number.isFinite(Number(body.rev))) {
    throw new Error('中央服务器版本信息不正确');
  }
  if (Number(body.apiVersion) < 3) {
    throw new Error('中央服务器版本过旧，请先升级服务器版');
  }
  return body;
}

function versionParts(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(a, b) {
  const av = versionParts(a);
  const bv = versionParts(b);
  if (!av || !bv) return 0;
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  }
  return 0;
}

function safeReleaseUrl(value) {
  const url = String(value || '');
  return url.startsWith(RELEASES_PREFIX) ? url : RELEASES_PREFIX.slice(0, -1);
}

function showMessageBox(options) {
  return mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

async function fetchLatestRelease() {
  let res;
  try {
    res = await fetch(RELEASES_API, {
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'LogisticsQuote-Desktop/' + app.getVersion(),
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    throw new Error(`无法检查更新：${e.message}`);
  }
  if (!res.ok) throw new Error(`GitHub 更新服务返回 HTTP ${res.status}`);
  const body = await res.json();
  const version = String(body.tag_name || '').replace(/^v/i, '');
  if (!versionParts(version)) throw new Error('GitHub 返回的版本号格式不正确');
  const assets = Array.isArray(body.assets) ? body.assets : [];
  const setup = assets.find(a => a && /^LogisticsQuote-Setup-.+-x64\.exe$/i.test(String(a.name || '')));
  return {
    version,
    htmlUrl: safeReleaseUrl(body.html_url),
    setupUrl: setup && String(setup.browser_download_url || '').startsWith(RELEASES_PREFIX)
      ? String(setup.browser_download_url)
      : null,
    checkedAt: new Date().toISOString(),
  };
}

async function checkForUpdates(options) {
  const opts = options || {};
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = (async () => {
    const cached = settings?.saved?.lastUpdateRelease;
    const cacheAge = Date.now() - Date.parse(settings?.saved?.lastUpdateCheckAt || 0);
    let latest = cached;
    if (opts.manual || !latest || !Number.isFinite(cacheAge) || cacheAge >= UPDATE_CHECK_MS) {
      latest = await fetchLatestRelease();
      settings.saved.lastUpdateCheckAt = latest.checkedAt;
      settings.saved.lastUpdateRelease = latest;
      persistSettings(settings.saved);
    }
    const current = app.getVersion();
    if (compareVersions(latest.version, current) <= 0) {
      if (opts.manual) {
        await showMessageBox({
          type: 'info', title: '检查更新',
          message: '当前已经是最新版本',
          detail: `当前版本：${current}\n最新版本：${latest.version}`,
        });
      }
      return { available: false, current, latest: latest.version };
    }
    if (!opts.manual && settings.saved.lastUpdatePromptVersion === latest.version) {
      return { available: true, suppressed: true, current, latest: latest.version };
    }
    const links = latest.setupUrl ? [latest.setupUrl, latest.htmlUrl] : [latest.htmlUrl];
    const result = await showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `${APP_NAME} ${latest.version} 已发布`,
      detail: `当前版本：${current}\n最新版本：${latest.version}\n\n将打开 GitHub 下载页；安装前请核对文件来源。`,
      buttons: ['打开下载页', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    settings.saved.lastUpdatePromptVersion = latest.version;
    persistSettings(settings.saved);
    if (result.response === 0) await shell.openExternal(links[0]);
    return {
      available: true, opened: result.response === 0,
      current, latest: latest.version, url: links[0],
    };
  })().catch(async error => {
    writeLog(`update check failed: ${error.stack || error.message}`);
    if (opts.manual) {
      await showMessageBox({
        type: 'warning', title: '检查更新失败', message: error.message,
      });
    }
    return { available: false, error: error.message };
  }).finally(() => {
    updateCheckPromise = null;
  });
  return updateCheckPromise;
}

function scheduleUpdateCheck() {
  setTimeout(() => { checkForUpdates({ manual: false }); }, 5000).unref?.();
}

function saveWindowBounds(bounds) {
  if (!settings) return;
  settings.saved.window = bounds;
  persistSettings(settings.saved);
}

function showServerSetup(options) {
  return new Promise((resolve, reject) => {
    const opts = options || {};
    if (setupWindow) {
      setupWindow.focus();
      resolve(null);
      return;
    }
    const win = new BrowserWindow({
      width: 600,
      height: 620,
      resizable: false,
      maximizable: false,
      minimizable: true,
      show: false,
      title: opts.purpose === 'switch' ? '连接设置' : '连接中央服务器',
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
        pending.resolve(null);
      }
    });
    win.loadFile(path.join(__dirname, 'setup.html'), {
      query: {
        forced: '1',
        purpose: opts.purpose || 'setup',
        serverUrl: opts.serverUrl || DEFAULT_SERVER,
      },
    });
  });
}

ipcMain.handle('admin-setup:submit', async (event, payload) => {
  const senderUrl = event.senderFrame?.url || '';
  if (!senderUrl.startsWith('file://')) {
    return { ok: false, error: '非法请求来源' };
  }
  if (!setupResolver) return { ok: false, error: '设置窗口已经关闭' };
  if (payload?.mode !== 'remote') {
    return { ok: false, error: '此客户端只允许连接中央服务器' };
  }
  try {
    const serverUrl = normalizeServerUrl(payload.serverUrl);
    await verifyRemoteServer(serverUrl);
    const pending = setupResolver;
    setupResolver = null;
    pending.resolve({ mode: 'remote', serverUrl });
    if (setupWindow) setupWindow.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.on('admin-setup:cancel', event => {
  if ((event.senderFrame?.url || '').startsWith('file://') && setupWindow) {
    setupWindow.close();
  }
});

async function loadConnectionError(win, message) {
  if (!win || win.isDestroyed()) return;
  await win.loadFile(path.join(__dirname, 'connection.html'), {
    query: {
      server: baseUrl || settings?.saved?.serverUrl || '',
      error: String(message || '连接失败'),
    },
  });
}

async function retryRemoteConnection() {
  if (!mainWindow || settings.saved.connectionMode !== 'remote' || !baseUrl) return;
  try {
    await verifyRemoteServer(baseUrl);
    await mainWindow.loadURL(baseUrl + '/');
  } catch (e) {
    await loadConnectionError(mainWindow, e.message);
  }
}

ipcMain.on('connection:retry', event => {
  if (!(event.senderFrame?.url || '').startsWith('file://')) return;
  retryRemoteConnection();
});

ipcMain.on('connection:settings', event => {
  if (!(event.senderFrame?.url || '').startsWith('file://')) return;
  changeConnection();
});

async function ensureCentralConnection() {
  if (settings.saved.connectionMode === 'remote' && settings.saved.serverUrl) {
    try {
      return {
        mode: 'remote',
        serverUrl: normalizeServerUrl(settings.saved.serverUrl),
        existing: true,
      };
    } catch (e) {
      writeLog(`invalid saved server URL: ${e.message}`);
    }
  }
  const value = await showServerSetup({
    purpose: 'setup',
    serverUrl: settings.saved.serverUrl || DEFAULT_SERVER,
  });
  if (!value) {
    app.quit();
    return null;
  }
  markRemoteConnection(value.serverUrl);
  return value;
}

async function changeConnection() {
  const value = await showServerSetup({
    purpose: 'switch',
    serverUrl: settings.saved.serverUrl || DEFAULT_SERVER,
  });
  if (!value) return;
  markRemoteConnection(value.serverUrl);
  app.relaunch();
  app.exit(0);
}

function isAppUrl(url) {
  try { return new URL(url).origin === new URL(baseUrl).origin; }
  catch (e) { return false; }
}

function isConnectionPage(url) {
  return url.startsWith('file://') && url.includes('/connection.html');
}

function externalUrl(url) {
  return /^https?:\/\//i.test(url) && !isAppUrl(url);
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
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;
  win.setMenuBarVisibility(true);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) win.loadURL(url);
    else if (externalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url) || isConnectionPage(url)) return;
    event.preventDefault();
    if (externalUrl(url)) shell.openExternal(url);
  });
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription,
    validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !/^https?:\/\//i.test(validatedURL)) return;
    if (settings?.saved?.connectionMode === 'remote') {
      loadConnectionError(win, `${errorDescription} (${errorCode})`);
    }
  });
  win.webContents.on('did-finish-load', () => {
    if (settings?.saved?.connectionMode === 'remote' && isAppUrl(win.webContents.getURL())) {
      win.setTitle(`${APP_NAME} · 中央服务器已连接`);
    } else if (settings?.saved?.connectionMode === 'remote'
        && isConnectionPage(win.webContents.getURL())) {
      win.setTitle(`${APP_NAME} · 服务器未连接`);
    } else {
      win.setTitle(APP_NAME);
    }
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
          label: '管理工作台',
          accelerator: 'CmdOrCtrl+2',
          click: () => { if (mainWindow) mainWindow.loadURL(baseUrl + '/admin/overview'); },
        },
        { type: 'separator' },
        { label: '打开日志目录', click: () => shell.openPath(logDir()) },
        { label: '服务器设置…', click: () => { changeConnection(); } },
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
            detail: `版本 ${app.getVersion()}\n服务器: ${settings?.saved?.serverUrl || '未设置'}`,
          }),
        },
        {
          label: '检查更新…',
          click: () => checkForUpdates({ manual: true }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function bootstrap() {
  settings = loadSettings();
  initLogging();
  installMenu();
  const connection = await ensureCentralConnection();
  if (!connection) return;
  baseUrl = connection.serverUrl;
  const win = createWindow();
  try {
    await verifyRemoteServer(baseUrl);
    await win.loadURL(baseUrl + '/');
  } catch (e) {
    await loadConnectionError(win, e.message);
  }
  scheduleUpdateCheck();
}

app.whenReady().then(bootstrap).catch(async error => {
  writeLog(error.stack || error.message);
  dialog.showErrorBox(APP_NAME, `${error.message}\n\n日志: ${path.join(logDir(), 'client.log')}`);
  app.quit();
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  app.quit();
});
