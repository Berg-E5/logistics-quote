/*
 * 用户与登录 —— 无第三方依赖, 用 Node 自带的 crypto。
 *
 * 用户库:  data/users.json   [{username, salt, hash, role, createdAt}]
 * 密钥:    data/secret.key   用来签发会话 cookie
 *
 * 密码用 scrypt 加盐哈希, 不可逆。
 * 会话是无状态的: cookie 里放 {用户, 过期时间}, 用 HMAC 签名, 服务重启也有效。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS = path.join(DATA_DIR, 'users.json');
const SECRET = path.join(DATA_DIR, 'secret.key');
const SESSION_HOURS = 12;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 读取签名密钥, 没有就生成 */
function getSecret() {
  ensureDir();
  if (fs.existsSync(SECRET)) {
    return fs.readFileSync(SECRET, 'utf8').trim();
  }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET, s, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(SECRET, 0o600); } catch (e) { /* Windows 忽略 */ }
  return s;
}

/** 密码哈希: scrypt + 随机盐 */
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt: s, hash: h };
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function loadUsers() {
  ensureDir();
  if (!fs.existsSync(USERS)) return [];
  try {
    const u = JSON.parse(fs.readFileSync(USERS, 'utf8'));
    return Array.isArray(u) ? u : [];
  } catch (e) {
    console.error('[users] users.json 解析失败:', e.message);
    return [];
  }
}

function saveUsers(users) {
  ensureDir();
  const tmp = USERS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), 'utf8');
  fs.renameSync(tmp, USERS);
  try { fs.chmodSync(USERS, 0o600); } catch (e) { /* Windows 忽略 */ }
}

function findUser(username) {
  const u = String(username || '').trim().toLowerCase();
  return loadUsers().find(x => x.username.toLowerCase() === u) || null;
}

/** 角色: admin = 站主 (能看所有用户), user = 普通用户 (只有自己的数据) */
function createUser(username, password, role) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_.\-]{2,32}$/.test(name)) {
    throw new Error('用户名只能用字母数字下划线点横线, 2-32 位');
  }
  if (!password || String(password).length < 8) {
    throw new Error('密码至少 8 位');
  }
  const users = loadUsers();
  if (findUser(name)) throw new Error('用户已存在: ' + name);
  const { salt, hash } = hashPassword(password);
  const u = {
    username: name, salt, hash,
    role: role || 'admin',
    createdAt: new Date().toISOString(),
  };
  users.push(u);
  saveUsers(users);
  return u;
}

/**
 * 公开注册 —— 新用户是普通角色, 数据为空, 需要自己上传价格表。
 * 不允许注册 admin 角色 (只有站主能指定)。
 */
function registerUser(username, password, confirm) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_.\-]{2,32}$/.test(name)) {
    throw new Error('用户名只能用字母数字下划线点横线, 2-32 位');
  }
  if (/^admin$/i.test(name)) throw new Error('这个用户名不能用');
  const pw = String(password || '');
  if (pw.length < 8) throw new Error('密码至少 8 位');
  if (pw.length > 128) throw new Error('密码太长了');
  if (confirm != null && String(confirm) !== pw) throw new Error('两次输入的密码不一样');
  if (findUser(name)) throw new Error('这个用户名已经被注册了');
  const u = createUser(name, pw, 'user');
  return { username: u.username, role: u.role, createdAt: u.createdAt };
}

function setPassword(username, password) {
  if (!password || String(password).length < 8) throw new Error('密码至少 8 位');
  const users = loadUsers();
  const u = users.find(x => x.username.toLowerCase() === String(username).toLowerCase());
  if (!u) throw new Error('用户不存在: ' + username);
  const { salt, hash } = hashPassword(password);
  u.salt = salt; u.hash = hash;
  u.changedAt = new Date().toISOString();
  saveUsers(users);
  return u;
}

function deleteUser(username) {
  const users = loadUsers();
  const i = users.findIndex(x => x.username.toLowerCase() === String(username).toLowerCase());
  if (i < 0) throw new Error('用户不存在: ' + username);
  if (users.length === 1) throw new Error('至少要留一个用户');
  const [u] = users.splice(i, 1);
  saveUsers(users);
  return u;
}

function listUsers() {
  return loadUsers().map(u => ({
    username: u.username, role: u.role, createdAt: u.createdAt, changedAt: u.changedAt,
  }));
}

// ---------------- 会话 (无状态, HMAC 签名 cookie) ----------------

function sign(payload) {
  const secret = getSecret();
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** 生成会话 cookie 值 */
function makeSession(username) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
  }), 'utf8').toString('base64url');
  return payload + '.' + sign(payload);
}

/** 校验 cookie, 返回用户名或 null */
function readSession(cookieValue) {
  if (!cookieValue) return null;
  const s = String(cookieValue);
  const i = s.lastIndexOf('.');
  if (i < 0) return null;
  const payload = s.slice(0, i);
  const sig = s.slice(i + 1);
  const want = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj.u;
  } catch (e) {
    return null;
  }
}

/**
 * 生成 Set-Cookie 头。
 * secure: 站点实际是 https 时传 true (nginx 终止 TLS, 这里按 X-Forwarded-Proto 判断);
 *         本地 http 调试时传 false, 否则浏览器不会回传 Secure cookie。
 */
function cookieHeader(value, maxAgeSec, secure) {
  const parts = [
    `quote_session=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure === undefined) secure = process.env.COOKIE_SECURE !== '0';
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ---------------- 登录限流 ----------------

const attempts = new Map();     // ip -> {count, until}
const registrations = new Map(); // ip -> {count, until}  注册限流: 1 小时最多 5 个

/** 注册频率限制: 同一 IP 1 小时内最多注册 5 个账号 */
function checkRegRate(ip) {
  const a = registrations.get(ip);
  if (!a) return true;
  if (a.until && Date.now() > a.until) { registrations.delete(ip); return true; }
  return a.count < 5;
}

function noteRegistration(ip) {
  const a = registrations.get(ip) || { count: 0, until: 0 };
  a.count++;
  if (a.count >= 5) a.until = Date.now() + 60 * 60 * 1000;
  registrations.set(ip, a);
}

function checkRate(ip) {
  const a = attempts.get(ip);
  if (!a) return true;
  // 注意: until 为 0 表示「还没锁」, 不能用 Date.now() > until 判断 ——
  // 那样每��次检查都会把计数器清掉, 限流等于没有。
  if (a.until && Date.now() > a.until) { attempts.delete(ip); return true; }
  return a.count < 8;
}

function noteFail(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count++;
  if (a.count >= 8) a.until = Date.now() + 5 * 60 * 1000;    // 锁 5 分钟
  attempts.set(ip, a);
}

function clearFail(ip) { attempts.delete(ip); }

/* ---------------- 被锁的 IP (只有管理员能看/解封) ---------------- */

/**
 * 列出当前被锁的 IP。
 * kind: 'login' = 登录失败被锁, 'register' = 注册太频繁被锁
 */
function listRateLocks() {
  const now = Date.now();
  const out = [];
  const push = (map, kind) => {
    for (const [ip, a] of map) {
      if (!a.until || a.until <= now) continue;
      out.push({
        ip, kind, count: a.count,
        until: new Date(a.until).toISOString(),
        remainSec: Math.ceil((a.until - now) / 1000),
      });
    }
  };
  push(attempts, 'login');
  push(registrations, 'register');
  return out.sort((a, b) => a.until < b.until ? -1 : 1);
}

/** 解封一个 IP (两种类型都清掉) */
function unlockRate(ip) {
  const hadLogin = attempts.delete(ip);
  const hadReg = registrations.delete(ip);
  return { ip, cleared: hadLogin || hadReg };
}

/** 全部解封 */
function clearAllRates() {
  const n = attempts.size + registrations.size;
  attempts.clear();
  registrations.clear();
  return { cleared: n };
}

module.exports = {
  createUser, registerUser, setPassword, deleteUser, listUsers, findUser, verifyPassword,
  hashPassword, loadUsers, saveUsers,
  makeSession, readSession, cookieHeader,
  checkRate, noteFail, clearFail,
  checkRegRate, noteRegistration,
  listRateLocks, unlockRate, clearAllRates,
  getSecret, USERS, DATA_DIR,
};
