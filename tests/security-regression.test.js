'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const serverEntry = path.join(root, 'server', 'server.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return res;
    } catch (e) { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

function waitForExit(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error('process did not exit')), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test('损坏的账号和价格存储不会被当成空数据覆盖', () => {
  const dataDir = tempDir('quote-corrupt-store-');
  process.env.QUOTE_DATA_DIR = dataDir;
  const users = require('../server/users');
  const db = require('../server/db');

  const usersFile = path.join(dataDir, 'users.json');
  fs.writeFileSync(usersFile, '{broken users', 'utf8');
  assert.throws(() => users.loadUsers(), err => err.code === 'USERS_STORE_CORRUPT');
  assert.equal(fs.readFileSync(usersFile, 'utf8'), '{broken users');

  const secretFile = path.join(dataDir, 'secret.key');
  fs.writeFileSync(secretFile, 'broken-secret', 'utf8');
  assert.throws(() => users.getSecret(), err => err.code === 'SESSION_SECRET_CORRUPT');

  const ratesFile = db.ratesPath('admin');
  fs.mkdirSync(path.dirname(ratesFile), { recursive: true });
  fs.writeFileSync(ratesFile, '{broken rates', 'utf8');
  assert.throws(() => db.load('admin'), err => err.code === 'RATES_STORE_CORRUPT');
  assert.equal(fs.readFileSync(ratesFile, 'utf8'), '{broken rates');

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('损坏账号库时服务拒绝启动', async t => {
  const dataDir = tempDir('quote-fail-closed-');
  fs.writeFileSync(path.join(dataDir, 'users.json'), '{broken users', 'utf8');
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      QUOTE_DATA_DIR: dataDir,
      QUOTE_FX_OFF: '1',
      QUOTE_SUPPRESS_ADMIN_PASSWORD_LOG: '1',
      ADMIN_PASSWORD: 'ReviewAdmin123',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += String(d); });
  t.after(() => {
    if (child.exitCode == null) child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const code = await waitForExit(child);
  assert.notEqual(code, 0);
  assert.match(stderr, /关键数据初始化失败|USERS_STORE_CORRUPT|账号库损坏/);
});

test('安全响应头和跨站写入拦截生效', async t => {
  const dataDir = tempDir('quote-security-headers-');
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      QUOTE_DATA_DIR: dataDir,
      QUOTE_FX_OFF: '1',
      QUOTE_SUPPRESS_ADMIN_PASSWORD_LOG: '1',
      ADMIN_PASSWORD: 'ReviewAdmin123',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += String(d); });
  t.after(() => {
    if (child.exitCode == null) child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const version = await waitForServer(base + '/api/version', child);
  assert.equal(version.status, 200);
  assert.match(version.headers.get('content-security-policy') || '', /object-src 'none'/);
  assert.match(version.headers.get('permissions-policy') || '', /camera=\(\)/);

  const blocked = await fetch(base + '/api/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
    },
    body: JSON.stringify({ username: 'admin', password: 'ReviewAdmin123' }),
  });
  assert.equal(blocked.status, 403);
  assert.match(await blocked.text(), /跨站写入/);
  assert.equal(stderr.includes('关键数据初始化失败'), false);
});

test('CLI 使用 QUOTE_DATA_DIR 中的管理令牌', async t => {
  const dataDir = tempDir('quote-cli-data-');
  fs.writeFileSync(path.join(dataDir, 'admin.token'), 'review-token', 'utf8');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(root, 'server', 'user.js'), 'locks'], {
    cwd: root,
    env: {
      ...process.env,
      QUOTE_DATA_DIR: dataDir,
      QUOTE_URL: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', d => { output += String(d); });
  child.stderr.on('data', d => { output += String(d); });
  const code = await waitForExit(child);
  assert.notEqual(code, 0);
  assert.doesNotMatch(output, /找不到管理令牌/);
  assert.match(output, /连不上服务/);
});

test('导入预览和后台日志采用安全默认值', () => {
  const server = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'server', 'admin.html'), 'utf8');
  assert.match(server, /QUOTE_IMPORT_CONCURRENCY \|\| '1'/);
  assert.match(server, /QUOTE_IMPORT_PREVIEW_MINUTES \|\| '30'/);
  assert.match(server, /expirePreviewIfNeeded/);
  assert.doesNotMatch(admin, /v-html="(?:welLog|impLog)"/);
});
