'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeDataset(price) {
  return {
    countries: [{ name: '美国', label: '美国' }],
    groups: [{
      sheet: '测试渠道',
      country: '美国',
      zone: '-',
      line: '-',
      attr: '',
      mode: 'band',
      div: 6000,
      cur: 'USD',
      lead: '',
      limits: '',
    }],
    tiers: [{
      sheet: '测试渠道',
      country: '美国',
      zone: '-',
      line: '-',
      attr: '',
      mode: 'band',
      lo: 0,
      hi: 999,
      price,
      fee: 0,
      nextkg: null,
      first_kg: null,
      next_kg: null,
    }],
    rules: [],
    divRules: {},
    meta: {
      channels: 1,
      groups: 1,
      tiers: 1,
      countries: 1,
      countriesAll: 1,
    },
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(base, output) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/api/version');
      if (res.status < 500) return;
    } catch (e) { /* 继续等 */ }
    await sleep(80);
  }
  throw new Error('服务没有在 10 秒内启动\n' + output());
}

async function responseJson(res) {
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { /* 保留原文错误 */ }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${body ? JSON.stringify(body) : text}`);
  }
  return body;
}

async function createUser(base, adminCookie, username, password) {
  const res = await fetch(base + '/api/users', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  await responseJson(res);
}

async function login(base, username, password) {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  await responseJson(res);
  const raw = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  assert.ok(raw, '登录响应应带会话 cookie');
  return raw.split(';')[0];
}

async function getJson(base, pathname, cookie) {
  const res = await fetch(base + pathname, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return responseJson(res);
}

async function submitImport(base, cookie, marker, delay) {
  // 前四个字节是 zip 魔数；假管道从第 5 个字节开始读取标记和延时。
  const file = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(marker + delay, 'ascii'),
  ]);
  const res = await fetch(base + '/api/import-file', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: marker + '.xlsx', data: file.toString('base64') }),
  });
  return responseJson(res);
}

async function waitImport(base, cookie) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const job = await getJson(base, '/api/import-status', cookie);
    if (job.state === 'done') return job;
    if (job.state === 'failed') throw new Error(job.error || '导入失败');
    await sleep(50);
  }
  throw new Error('导入没有在 10 秒内完成');
}

test('管理员维护共享价格表且普通用户只读访问', { timeout: 30000 }, async t => {
  const repo = path.resolve(__dirname, '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-review-'));
  const scriptsDir = path.join(tempRoot, 'scripts');
  fs.cpSync(path.join(repo, 'server'), path.join(tempRoot, 'server'), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, 'run_pipeline.py'), `
import json
import sys
import time

raw = open(sys.argv[1], "rb").read()
marker = raw[4:5].decode("ascii")
delay = float(raw[5:].decode("ascii"))
time.sleep(delay)
price = {"A": 111, "B": 222}.get(marker, 333)
data = {
    "countries": [{"name": "美国", "label": "美国"}],
    "groups": [{
        "sheet": "测试渠道", "country": "美国", "zone": "-", "line": "-",
        "attr": "", "mode": "band", "div": 6000, "cur": "USD",
        "lead": "", "limits": ""
    }],
    "tiers": [{
        "sheet": "测试渠道", "country": "美国", "zone": "-", "line": "-",
        "attr": "", "mode": "band", "lo": 0, "hi": 999,
        "price": price, "fee": 0, "nextkg": None, "first_kg": None, "next_kg": None
    }],
    "rules": [],
    "divRules": {},
    "meta": {"channels": 1, "groups": 1, "tiers": 1, "countries": 1, "countriesAll": 1}
}
with open(sys.argv[2], "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False)
`, 'utf8');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(tempRoot, 'server', 'server.js')], {
    cwd: tempRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      ADMIN_PASSWORD: 'ReviewAdmin123',
      QUOTE_ADMIN_USERNAME: 'owner',
      QUOTE_FX_OFF: '1',
      QUOTE_IMPORT_CONCURRENCY: '2',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });

  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), sleep(3000)]);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  await waitForServer(base, () => output);

  const adminCookie = await login(base, 'owner', 'ReviewAdmin123');
  await createUser(base, adminCookie, 'userA', 'ReviewUser123');
  await createUser(base, adminCookie, 'userB', 'ReviewUser123');
  const cookieA = await login(base, 'userA', 'ReviewUser123');
  const cookieB = await login(base, 'userB', 'ReviewUser123');

  await submitImport(base, adminCookie, 'A', '0.1');
  await waitImport(base, adminCookie);

  const [dataA, dataB] = await Promise.all([
    getJson(base, '/api/data', cookieA),
    getJson(base, '/api/data', cookieB),
  ]);
  assert.equal(dataA.data.tiers[0].price, 111);
  assert.equal(dataB.data.tiers[0].price, 111);
  assert.equal(dataA.scope, 'owner');
  assert.equal(dataB.scope, 'owner');
  const sharedUsers = await getJson(base, '/api/users', adminCookie);
  const userARecord = sharedUsers.users.find(u => u.username === 'userA');
  assert.equal(userARecord.shared, true);
  assert.equal(userARecord.tiers, 1);

  const deniedImport = await fetch(base + '/api/import', {
    method: 'POST',
    headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: fakeDataset(222) }),
  });
  assert.equal(deniedImport.status, 403);
  const deniedUsers = await fetch(base + '/api/users', {
    headers: { Cookie: cookieA },
  });
  assert.equal(deniedUsers.status, 403);
  const deniedChanges = await fetch(base + '/api/changes', {
    headers: { Cookie: cookieA },
  });
  assert.equal(deniedChanges.status, 403);
  const deniedRates = await fetch(base + '/api/rates', {
    headers: { Cookie: cookieA },
  });
  assert.equal(deniedRates.status, 403);
  const deniedRegister = await fetch(base + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'selfRegister', password: 'ReviewUser123', confirm: 'ReviewUser123',
    }),
  });
  assert.equal(deniedRegister.status, 403);

  const tokenFile = path.join(tempRoot, 'data', 'admin.token');
  assert.equal(fs.existsSync(tokenFile), true, '服务启动时应自动生成管理令牌');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const tokenMe = await responseJson(await fetch(base + '/api/me', {
    headers: { 'x-admin-token': token },
  }));
  assert.equal(tokenMe.user, 'owner');
  assert.equal(tokenMe.role, 'admin');

  await responseJson(await fetch(base + '/api/import', {
    method: 'POST',
    headers: {
      'x-admin-token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ note: 'token scope test', data: fakeDataset(333) }),
  }));
  const adminData = await getJson(base, '/api/data', adminCookie);
  assert.equal(adminData.data.tiers[0].price, 333);
  assert.equal(fs.existsSync(path.join(tempRoot, 'data', 'users', 'api-token')), false);

  // 手工新增“首重续重”必须保留首重/续重参数，并且新渠道币种要与国家一致。
  await responseJson(await fetch(base + '/api/rates', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sheet: '首重测试', country: '美国', zone: '-', line: '-', attr: '',
      mode: 'firstnext', lo: 0, hi: 10, price: 20, fee: 3,
      first_kg: 0.5, next_kg: 0.5, nextkg: 8,
    }),
  }));
  const afterAdd = await getJson(base, '/api/data', cookieA);
  const fnTier = afterAdd.data.tiers.find(t => t.sheet === '首重测试');
  const fnGroup = afterAdd.data.groups.find(g => g.sheet === '首重测试');
  assert.equal(fnTier.first_kg, 0.5);
  assert.equal(fnTier.next_kg, 0.5);
  assert.equal(fnTier.nextkg, 8);
  assert.equal(fnGroup.mode, 'firstnext');
  assert.equal(fnGroup.currency, 'USD');

  // 客户端不能伪造改动记录里的操作者。
  await responseJson(await fetch(base + '/api/rates?by=userA', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sheet: '分段测试', country: '美国', zone: '-', line: '-', attr: '',
      mode: 'band', lo: 0, hi: 10, price: 10, fee: 0,
    }),
  }));
  const changes = await getJson(base, '/api/changes?kind=add&limit=5', adminCookie);
  assert.equal(changes.changes[0].by, 'owner');

  // 同方式重量段重叠必须拒绝，否则一个计费重会命中多条并重复收费。
  const overlapRes = await fetch(base + '/api/rates', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sheet: '分段测试', country: '美国', zone: '-', line: '-', attr: '',
      mode: 'band', lo: 5, hi: 20, price: 12, fee: 0,
    }),
  });
  assert.equal(overlapRes.status, 400);

  // 删除已锁定档位时，应同时清理孤儿锁。
  const rateRows = await getJson(base, '/api/rates?limit=5', adminCookie);
  const lockedId = rateRows.rows.find(r => r.sheet === '测试渠道').id;
  await responseJson(await fetch(base + '/api/rates/' + lockedId + '/lock', {
    method: 'PUT',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ locked: true }),
  }));
  const locksBefore = await getJson(base, '/api/locks', adminCookie);
  assert.equal(locksBefore.count, 1);

  const emptyData = fakeDataset(0);
  emptyData.tiers = [];
  emptyData.groups = [];
  emptyData.countries = [];
  await responseJson(await fetch(base + '/api/import', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'remove locked tier', data: emptyData }),
  }));
  const locksAfter = await getJson(base, '/api/locks', adminCookie);
  assert.equal(locksAfter.count, 0);

  const badJson = await fetch(base + '/api/rates/' + lockedId, {
    method: 'PUT',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(badJson.status, 400);

  // 改密码后旧会话立即失效，当前设备拿到新会话。
  const passwordRes = await fetch(base + '/api/password', {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword: 'ReviewAdmin123', newPassword: 'ReviewAdmin456' }),
  });
  await responseJson(passwordRes);
  const refreshedCookie = (passwordRes.headers.getSetCookie?.()[0]
    || passwordRes.headers.get('set-cookie')).split(';')[0];
  const oldMe = await getJson(base, '/api/me', adminCookie);
  const newMe = await getJson(base, '/api/me', refreshedCookie);
  assert.equal(oldMe.user, null);
  assert.equal(newMe.user, 'owner');

  // 显式退出会撤销该账号的所有无状态会话，抓包重放的旧 Cookie 也不能继续用。
  await responseJson(await fetch(base + '/api/logout', {
    method: 'POST',
    headers: { Cookie: refreshedCookie },
  }));
  const afterLogout = await getJson(base, '/api/me', refreshedCookie);
  assert.equal(afterLogout.user, null);
});
