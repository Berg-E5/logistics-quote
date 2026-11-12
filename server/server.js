/*
 * 物流报价网站 —— 后端服务 (Node 原生 http, 零第三方依赖)
 *
 * 路由:
 *   GET  /                      前端页面 (public/index.html)
 *   GET  /admin                 后台改价界面
 *   GET  /api/data              完整数据集 (前端同步用)
 *   GET  /api/version           只回版本号 (前端轮询用, 很轻)
 *   GET  /api/rates?sheet=&country=&q=   费率明细 (后台列表用, 需令牌)
 *   PUT  /api/rates/:id         改一条费率 (需令牌)
 *   POST /api/import            整表导入 (需令牌)
 *   GET  /api/changes?limit=&offset=&kind=&q=  变更日志 (需令牌)
 *
 * 环境变量:
 *   PORT        监听端口 (默认 8080)
 *   HOST        监听地址 (默认 127.0.0.1, 由 nginx 反代)
 *   QUOTE_TOKEN 管理令牌 (不给就用 data/admin.token)
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const db = require('./db');
const users = require('./users');

// ---- 整表导入 (异步任务) ----
// 服务器上脚本目录叫 scripts, 本地开发目录叫「脚本」—— 两个都认。
// (之前硬编码 scripts/, 本地跑导入直接 spawn ENOENT)
const SCRIPTS = (() => {
  for (const d of ['scripts', '脚本']) {
    const p = path.join(__dirname, '..', d);
    if (fs.existsSync(path.join(p, 'run_pipeline.py'))) return p;
  }
  return path.join(__dirname, '..', 'scripts');
})();
const UPLOAD_DIR = path.join(os.tmpdir(), 'quote-import');   // 用 os.tmpdir() 而不是硬编码 /tmp (Windows 下 /tmp 不是有效路径)
// 每个用户一个导入任务, 互不干扰
const importJobs = new Map();
function getJob(scope) {
  if (!importJobs.has(scope)) {
    importJobs.set(scope, { state: 'idle', log: [], startedAt: null, result: null, error: null });
  }
  return importJobs.get(scope);
}

// ---- 汇率: 服务端自动抓取 ----
const FX_FILE = path.join(__dirname, '..', 'data', 'fx.json');
// 脚本目录: 服务器上叫 scripts, 本地项目里叫 脚本 —— 两个都认
function findScript(name) {
  const cands = [
    path.join(__dirname, '..', 'scripts', name),
    path.join(__dirname, '..', '脚本', name),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0];
}
const FX_SCRIPT = findScript('fetch_fx.py');
const FX_INTERVAL_MS = 60 * 1000;            // 每 60 秒抓一次中行牌价 (牌价几分钟就变一次)
const FX_MIN_AGE_MS = 5 * 60 * 1000;         // 超过 5 分钟就算过期 (启动时立刻刷新)

function readFx() {
  try {
    if (!fs.existsSync(FX_FILE)) return null;
    return JSON.parse(fs.readFileSync(FX_FILE, 'utf8'));
  } catch (e) { return null; }
}

function fxAgeMs() {
  const j = readFx();
  if (!j || !j.updatedAt) return Infinity;
  const t = Date.parse(j.updatedAt);
  return isNaN(t) ? Infinity : Date.now() - t;
}

/** 抓一次汇率 (后台跑, 不阻塞请求) */
function refreshFx(reason) {
  const py = (process.env.QUOTE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
  console.log(`[fx] 开始刷新汇率 (${reason})`);
  const child = spawn(py, [FX_SCRIPT], { cwd: path.dirname(FX_SCRIPT) });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('error', e => {
    console.error('[fx] 刷新失败 (启动进程出错):', e.message);
  });
  child.on('close', code => {
    if (code === 0) {
      const j = readFx();
      console.log(`[fx] 汇率已更新: 取数日 ${j && j.date} · ${j && j.source}`
        + (j && j.publishedAt ? ` · 牌价发布 ${j.publishedAt}` : '')
        + (j && j.rates ? ` · USD ${j.rates['美国']}` : ''));
    } else {
      console.error('[fx] 刷新失败, 保留旧汇率:', out.slice(-300));
    }
  });
}

function startFxWatcher() {
  // QUOTE_FX_OFF=1 = **完全不自动抓**。
  // 之前只挡了「启动检查」, 定时任务照跑 —— 本地测试时等于每分钟去打扰一次中行,
  // 还把本地 data/fx.json 改掉。名字叫 OFF 就该真的关干净。
  if (process.env.QUOTE_FX_OFF === '1') {
    console.log('[fx] 自动刷新已关闭 (QUOTE_FX_OFF=1)');
    return;
  }
  if (fxAgeMs() > FX_MIN_AGE_MS) refreshFx('启动时数据过期');
  setInterval(() => refreshFx('定时任务'), FX_INTERVAL_MS);
  refreshFx('启动检查');
}

function startImport(scope, filePath) {
  const importJob = getJob(scope);
  if (importJob.state === 'running') {
    const e = new Error('已经有一个导入任务在跑了, 等它结束');
    e.status = 409;
    throw e;
  }
  importJob.state = 'running';
  importJob.log = [];
  importJob.result = null;
  importJob.error = null;
  importJob.startedAt = new Date().toISOString();
  importJob.file = path.basename(filePath);
  // ---- 进度条 ----
  importJob.step = 0;          // 当前第几步 (1 起)
  importJob.stepTotal = 0;     // 总步数, 第一次收到 STEP 标记才知道
  importJob.stepName = '';     // 当前步骤中文名
  importJob.stepDone = 0;      // 已完成的步骤数
  importJob.stepStartedAt = Date.now();
  importJob.progress = 0;      // 0~100, 含时间平滑
  importJob.stepWeights = [];  // 每步的权重 (pipeline 报上来)
  importJob.doneMs = 0;        // 已完成步骤实测耗时之和
  importJob.stepMs = 0;        // 当前步骤已用时
  const py = (process.env.QUOTE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
  const outJson = path.join(UPLOAD_DIR, 'result.json');
  const child = spawn(py, [path.join(SCRIPTS, 'run_pipeline.py'), filePath, outJson],
                      { cwd: SCRIPTS, env: Object.assign({}, process.env, {
                        PYTHONHASHSEED: '0' }) });
  const t0 = Date.now();
  const timer = setInterval(() => {
    importJob.elapsed = Math.round((Date.now() - t0) / 1000);
    importJob.log.push(`处理中 ${importJob.elapsed} 秒…`);
    if (importJob.log.length > 40) importJob.log.shift();
    // 时间平滑: 真实进度只在步骤边界跳变, 这里按「这一步预计多久」把进度条
    // 慢慢往前推, 封顶在本步结束时的位置 —— 免得进度条卡住不动像死了。
    if (importJob.stepTotal > 0 && importJob.step > 0) {
      const inStep = Date.now() - importJob.stepStartedAt;
      importJob.stepMs = inStep;
      // 已完成步骤的权重和
      let doneW = 0;
      for (let k = 0; k < importJob.step - 1; k++) doneW += (importJob.stepWeights[k] || 0);
      const curW = importJob.stepWeights[importJob.step - 1] || 0;
      // 「每单位权重多少毫秒」= 已完成步骤实测总耗时 / 已完成权重和
      // 第一个步骤没有历史, 用 1000ms/权重 兜底 (权重总和 100 -> 整次约 100 秒)
      const unitMs = doneW > 0 ? (importJob.doneMs || 0) / doneW : 1000;
      const expect = Math.max(1500, curW * unitMs);
      // 走完 90% 之后停下, 留 10% 等真实事件, 免得冲到头又掉回去
      const frac = Math.min(0.9, (inStep / expect) * 0.9);
      importJob.progress = Math.min(99, doneW + frac * curW);
    }
  }, 1000);

  // spawn 失败 (python 路径不对 / 磁盘满 / 权限) 时, 如果不挂 error handler,
  // node 会抛「Unhandled 'error' event」**整个服务退出** —— 线上一次导入失败
  // 就能把整站搞挂。必须兜住。
  child.on('error', e => {
    clearInterval(timer);
    importJob.state = 'failed';
    importJob.error = `无法启动抽取进程: ${e.message}`;
    importJob.log.push('! 启动失败: ' + e.message);
    console.error('[import] 启动抽取进程失败:', e.message);
  });
  child.stdout.on('data', d => {
    String(d).split('\n').filter(Boolean).forEach(l => {
      // 进度标记: [pipeline] STEP 3/7 抽取尺寸限制与附加费 w=10
      const m = l.match(/^\[pipeline\]\s+(STEP|DONE)\s+(\d+)\/(\d+)\s*(.*?)(?:\s+w=(\d+))?\s*$/);
      if (m) {
        const kind = m[1], idx = Number(m[2]), tot = Number(m[3]);
        const nm = (m[4] || '').trim();
        const w = Number(m[5]) || 0;
        importJob.stepTotal = tot;
        // 记下每一步的权重 (按顺序), 用来算累计百分比
        importJob.stepWeights[idx - 1] = w;
        const cum = n => {
          let sum = 0;
          for (let k = 0; k < n; k++) sum += (importJob.stepWeights[k] || 0);
          return sum;
        };
        if (kind === 'STEP') {
          importJob.step = idx;
          importJob.stepName = nm;
          importJob.stepStartedAt = Date.now();
          importJob.stepMs = 0;
          // 本步开始位置 = 前面所有步骤的权重和
          importJob.progress = Math.min(99, cum(idx - 1));
        } else {
          importJob.stepDone = idx;
          importJob.step = idx;
          importJob.stepMs = Date.now() - importJob.stepStartedAt;
          importJob.doneMs = (importJob.doneMs || 0) + importJob.stepMs;
          importJob.progress = Math.min(99, cum(idx));
        }
        return;
      }
      importJob.log.push(l.replace(/^\[pipeline\]\s*/, ''));
    });
    if (importJob.log.length > 60) importJob.log.shift();
  });
  child.stderr.on('data', d => {
    String(d).split('\n').filter(Boolean).forEach(l => {
      importJob.log.push('! ' + l);
    });
    if (importJob.log.length > 60) importJob.log.shift();
  });
  child.on('close', code => {
    clearInterval(timer);
    // 上传的 xlsx 有十几 MB, 用完就删, 不然每次导入都在 /tmp 攒一份
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    if (code !== 0) {
      importJob.state = 'failed';
      importJob.error = `抽取失败 (退出码 ${code}), 详见日志`;
      return;
    }
    try {
      const raw = fs.readFileSync(outJson, 'utf8');
      const data = JSON.parse(raw);
      const report = diffData(db.load(scope).data, data);
      const r = db.saveAll(scope, data, '网页整表导入', scope);
      importJob.state = 'done';
      importJob.progress = 100;
      importJob.stepDone = importJob.stepTotal || importJob.stepDone;
      importJob.result = {
        rev: r.rev, updatedAt: r.updatedAt,
        lockedPreserved: r.lockedPreserved || 0,
        locksMissing: r.locksMissing || 0,
        report,
      };
      importJob.log.push(`完成 · 数据版本 v${r.rev} · 锁定保留 ${r.lockedPreserved || 0} 档`);
      try { fs.unlinkSync(outJson); } catch (e) { /* ignore */ }
    } catch (e) {
      importJob.state = 'failed';
      importJob.error = '应用数据失败: ' + e.message;
    }
  });
}

/** 对比新旧数据集, 生成变化报告 */
function diffData(oldData, newData) {
  const key = t => [t.sheet, t.country, t.zone, t.line, t.attr || '', t.mode,
                     t.lo, t.hi].join('|');
  const oldM = new Map();
  for (const t of (oldData && oldData.tiers) || []) oldM.set(key(t), t);
  const newM = new Map();
  for (const t of (newData && newData.tiers) || []) newM.set(key(t), t);

  const changed = [], added = [], removed = [];
  for (const [k, t] of newM) {
    if (!oldM.has(k)) { added.push(t); continue; }
    const o = oldM.get(k);
    if (Number(o.price) !== Number(t.price) || Number(o.fee) !== Number(t.fee)) {
      changed.push({ tier: t, oldPrice: o.price, newPrice: t.price,
                     oldFee: o.fee, newFee: t.fee });
    }
  }
  for (const [k, t] of oldM) if (!newM.has(k)) removed.push(t);

  // 按渠道汇总
  const bySheet = {};
  for (const c of changed) {
    const s = c.tier.sheet;
    bySheet[s] = bySheet[s] || { changed: 0, added: 0, removed: 0 };
    bySheet[s].changed++;
  }
  for (const a of added) {
    const s = a.sheet;
    bySheet[s] = bySheet[s] || { changed: 0, added: 0, removed: 0 };
    bySheet[s].added++;
  }
  for (const r of removed) {
    const s = r.sheet;
    bySheet[s] = bySheet[s] || { changed: 0, added: 0, removed: 0 };
    bySheet[s].removed++;
  }

  const fmt = t => [t.sheet, t.country, t.zone === '-' ? '' : t.zone,
                    t.line === '-' ? '' : t.line, t.attr || '通用', t.mode,
                    `${t.lo}-${t.hi}kg`].filter(x => x && x !== '-').join(' / ');
  return {
    counts: { changed: changed.length, added: added.length, removed: removed.length },
    bySheet,
    changed: changed.slice(0, 300).map(c => ({
      label: fmt(c.tier), oldPrice: c.oldPrice, newPrice: c.newPrice,
      oldFee: c.oldFee, newFee: c.newFee })),
    added: added.slice(0, 300).map(t => ({ label: fmt(t), price: t.price, fee: t.fee })),
    removed: removed.slice(0, 300).map(t => ({ label: fmt(t), price: t.price, fee: t.fee })),
    truncated: changed.length > 300 || added.length > 300 || removed.length > 300,
  };
}

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendErr(res, code, msg) {
  sendJson(res, code, { error: String(msg) });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limit || 20 * 1024 * 1024)) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokenFrom(req, q) {
  const h = req.headers['x-admin-token'];
  if (h) return String(h);
  if (q && q.token) return String(q.token);
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

function clientIp(req) {
  // nginx 用 $proxy_add_x_forwarded_for: 客户端自带的头 + 真实 IP 拼在最后,
  // 所以取【最后一段】才是真实 IP; 取第一段会被客户端伪造。
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const parts = String(xf).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function cookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 当前登录用户 (会话 cookie); 令牌也认, 方便脚本调用 */
function currentUser(req, q) {
  const byCookie = users.readSession(cookies(req).quote_session);
  if (byCookie && users.findUser(byCookie)) return byCookie;
  if (db.checkToken(tokenFrom(req, q))) return 'api-token';
  return null;
}

/** 是不是管理员 (角色 admin) */
function isAdmin(req) {
  const u = currentUser(req, {});
  if (!u) return false;
  // 管理令牌 (data/admin.token, 只有 root 能读) 等同管理员
  if (u === 'api-token') return true;
  const rec = users.findUser(u);
  return !!(rec && rec.role === 'admin');
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // 静态资源要带 ETag + no-cache: 浏览器每次来问一次「变没变」, 变了才传新内容。
    // 之前用 max-age=300, 结果改完 UI 刷新页面看到的还是旧的, 排查半天。
    const etag = '"' + crypto.createHash('md5').update(buf).digest('hex').slice(0, 16) + '"';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'ETag': etag,
      'Cache-Control': ext === '.json' ? 'no-store' : 'no-cache',
    };
    if (res.req && res.req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] });
      return res.end();
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(parsed.pathname);
  const q = Object.fromEntries(parsed.searchParams.entries());

  try {
    // ---------- 公开 ----------
    // 已登录 -> 看自己的数据; 未登录 -> 看站主的 (公开页还能用)
    const viewer = currentUser(req, q);
    const scope = viewer || db.DEFAULT_SCOPE;

    if (pathname === '/api/data' && req.method === 'GET') {
      // 未登录不给数据 —— 前台必须登录才能看报价
      if (!viewer) return sendErr(res, 401, '请先登录后查看报价');
      const cur = db.loadView(scope);
      if (!cur.data) return sendErr(res, 503, '还没有导入数据');
      return sendJson(res, 200, {
        rev: cur.rev, updatedAt: cur.updatedAt, data: cur.data,
        scope, mine: true,
      });
    }

    if (pathname === '/api/version' && req.method === 'GET') {
      // 未登录只给版本号, 不暴露是谁的数据
      if (!viewer) {
        const c0 = db.load(db.DEFAULT_SCOPE);
        return sendJson(res, 200, { rev: c0.rev, updatedAt: c0.updatedAt });
      }
      const cur = db.load(scope);
      return sendJson(res, 200, {
        rev: cur.rev, updatedAt: cur.updatedAt, hasData: !!cur.data,
        scope, mine: true,
      });
    }

    // ---------- 登录 ----------
    // 汇率 (公开, 前端要用)
    if (pathname === '/api/fx' && req.method === 'GET') {
      // 汇率也是报价的一部分, 未登录不给
      if (!viewer) return sendErr(res, 401, '请先登录');
      const j = readFx();
      if (!j) return sendJson(res, 200, { ok: false, rates: {}, date: '' });
      return sendJson(res, 200, j);
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      let body;
      try { body = JSON.parse((await readBody(req, 8192)) || '{}'); }
      catch (e) { return sendErr(res, 400, '请求格式不对'); }
      const u = users.findUser(body.username);
      const ok = !!u && users.verifyPassword(body.password || '', u);

      if (!users.checkRate(ip)) {
        // IP 被锁了。只有管理员能用【正确的密码】进来 (顺便解锁这个 IP),
        // 否则管理员自己被锁在门外就没法给别人解封了。
        if (ok && u.role === 'admin') {
          users.clearFail(ip);
          console.log(`[login] 管理员 ${u.username} 用正确密码解锁了 IP ${ip}`);
        } else {
          return sendErr(res, 429, '登录失败次数过多, 请 5 分钟后再试, 或联系管理员在后台解封');
        }
      } else if (!ok) {
        users.noteFail(ip);
        return sendErr(res, 401, '用户名或密码不对');
      }
      users.clearFail(ip);
      const sess = users.makeSession(u.username);
      // nginx 终止 TLS 时会带 X-Forwarded-Proto: https
      const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
      const isHttps = proto ? proto === 'https' : (req.socket.encrypted === true);
      res.setHeader('Set-Cookie', users.cookieHeader(sess, 12 * 3600, isHttps));
      return sendJson(res, 200, { ok: true, user: u.username, role: u.role });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const proto0 = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
      const isHttps0 = proto0 ? proto0 === 'https' : (req.socket.encrypted === true);
      res.setHeader('Set-Cookie', users.cookieHeader('', 0, isHttps0));
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const u = currentUser(req, q);
      const rec = u ? users.findUser(u) : null;
      return sendJson(res, 200, {
        user: u || null,
        role: rec ? rec.role : null,
        createdAt: rec ? rec.createdAt : null,
      });
    }

    if (pathname === '/api/password' && req.method === 'POST') {
      const u = currentUser(req, q);
      if (!u) return sendErr(res, 401, '请先登录');
      if (u === 'api-token') return sendErr(res, 400, '令牌不能改密码, 请用用户名登录');
      let body;
      try { body = JSON.parse((await readBody(req, 8192)) || '{}'); }
      catch (e) { return sendErr(res, 400, '请求格式不对'); }
      const me = users.findUser(u);
      if (!users.verifyPassword(body.oldPassword || '', me)) {
        return sendErr(res, 401, '原密码不对');
      }
      try {
        users.setPassword(u, body.newPassword || '');
      } catch (e) { return sendErr(res, 400, e.message); }
      return sendJson(res, 200, { ok: true });
    }

    // ---------- 注册 (公开) ----------
    if (pathname === '/api/register' && req.method === 'POST') {
      const ip = clientIp(req);
      if (!users.checkRegRate(ip)) {
        return sendErr(res, 429, '这个 IP 注册太频繁了, 一小时后再试');
      }
      let body;
      try { body = JSON.parse((await readBody(req, 8192)) || '{}'); }
      catch (e) { return sendErr(res, 400, '请求格式不对'); }
      try {
        const u = users.registerUser(body.username, body.password, body.confirm);
        users.noteRegistration(ip);
        console.log(`[register] 新用户 ${u.username} (${clientIp(req)})`);
        // 注册完直接给会话, 免得再输一次
        const sess = users.makeSession(u.username);
        const proto = req.headers['x-forwarded-proto'];
        const isHttps = proto ? proto.split(',')[0].trim() === 'https'
          : (req.socket.encrypted === true);
        res.setHeader('Set-Cookie', users.cookieHeader(sess, 12 * 3600, isHttps));
        return sendJson(res, 200, { ok: true, user: u.username });
      } catch (e) {
        return sendErr(res, 400, e.message);
      }
    }

    // ---------- 管理接口 ----------
    if (pathname.startsWith('/api/') && pathname !== '/api/data' && pathname !== '/api/version'
        && pathname !== '/api/login' && pathname !== '/api/logout' && pathname !== '/api/me'
        && pathname !== '/api/password' && pathname !== '/api/register'
        && pathname !== '/api/fx' && pathname !== '/api/users'
        && !pathname.startsWith('/api/users/')
        && pathname !== '/api/rate-locks'
        && !pathname.startsWith('/api/rate-locks/')) {
      if (!currentUser(req, q)) {
        return sendErr(res, 401, '请先登录');
      }
    }


    if (pathname === '/api/rates' && req.method === 'GET') {
      const cur = db.loadView(scope);
      if (!cur.data) return sendErr(res, 503, '还没有导入数据');
      const tiers = cur.data.tiers || [];
      const s = (q.sheet || '').toLowerCase();
      const c = (q.country || '').toLowerCase();
      const kw = (q.q || '').toLowerCase();
      const at = (q.attr || '').toLowerCase();
      const out = tiers.filter(t => {
        if (s && !String(t.sheet).toLowerCase().includes(s)) return false;
        if (c && !String(t.country).toLowerCase().includes(c)) return false;
        if (at === '__general__') {
          if (String(t.attr || '') !== '') return false;
        } else if (at && String(t.attr || '').toLowerCase() !== at) {
          return false;
        }
        if (kw) {
          const blob = [t.sheet, t.country, t.zone, t.line, t.attr, t.mode]
            .join(' ').toLowerCase();
          if (!blob.includes(kw)) return false;
        }
        return true;
      });
      // 分页: 默认前 500 条, 避免一次传太大
      const limit = Math.min(Math.max(Number(q.limit || 500) || 500, 1), 5000);
      const offset = Math.max(Number(q.offset || 0) || 0, 0);
      // 锁定状态存在 locks.json 里 (整表导入会重写 rates.json, 所以这里实时 join,
      // 否则管理员刷新页面就看不出哪些档被锁了)
      const lockMap = db.loadLocks(scope);
      // 把所属渠道组的体积重除数一起带上 (后台表格要看, 且前端要知道改一处影响几档)
      const ruleMap = db.buildRuleMap(cur.data.rules);
      const divByKey = new Map();
      const tierCnt = new Map();
      for (const g of (cur.data.groups || [])) {
        const k = db.divKey(g);
        const info = db.divInfo(g, ruleMap);
        divByKey.set(k, { div: info.div, src: info.src, uncertain: info.uncertain });
      }
      for (const tt of tiers) {
        const k = db.divKeyOfTier(tt);
        tierCnt.set(k, (tierCnt.get(k) || 0) + 1);
      }
      const enrich = (t) => {
        const k = db.divKeyOfTier(t);
        const di = divByKey.get(k) || { div: null, src: '', uncertain: true };
        return {
          ...t,
          locked: !!lockMap[t.id],
          divKey: k,
          div: di.div,
          divSrc: di.src,
          divUncertain: di.uncertain,
          divTiers: tierCnt.get(k) || 0,
        };
      };

      // 分组模式: 按渠道分组, 分页按「组」算。
      // 1170 条档位摊平了要翻 100 多页; 按渠道分组后一屏能看到所有渠道。
      if (q.group === '1') {
        const gmap = new Map();
        for (const t of out) {
          if (!gmap.has(t.sheet)) gmap.set(t.sheet, []);
          gmap.get(t.sheet).push(enrich(t));
        }
        const sheets = [...gmap.keys()].sort();
        const gpage = sheets.slice(offset, offset + limit);
        const groups = gpage.map(name => {
          const rows = gmap.get(name);
          return {
            sheet: name,
            count: rows.length,
            locked: rows.filter(r => r.locked).length,
            countries: [...new Set(rows.map(r => r.country))].length,
            minPrice: Math.min.apply(null, rows.map(r => Number(r.price) || 0)),
            rows,
          };
        });
        // 全量渠道聚合 (不分页) —— 前端顶部要画「渠道分布条」,
        // 一眼看出 23 个渠道哪个大哪个小, 点一下能筛那个渠道。
        // **用未过滤的 tiers 算**, 不是 out —— 分布条是全局概览,
        // 不能因为当前筛了某个渠道就只剩一根柱子。
        const sumMap = new Map();
        for (const t of tiers) {
          if (!sumMap.has(t.sheet)) sumMap.set(t.sheet, []);
          sumMap.get(t.sheet).push(t);
        }
        const summary = [...sumMap.keys()].sort().map(name => {
          const rows = sumMap.get(name);
          const prices = rows.map(r => Number(r.price) || 0).filter(x => x > 0);
          return {
            sheet: name,
            count: rows.length,
            locked: rows.filter(r => r.locked).length,
            countries: [...new Set(rows.map(r => r.country))].length,
            minPrice: prices.length ? Math.min.apply(null, prices) : 0,
            maxPrice: prices.length ? Math.max.apply(null, prices) : 0,
            avgPrice: prices.length
              ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100 : 0,
          };
        });
        return sendJson(res, 200, {
          rev: cur.rev, total: out.length, totalGroups: sheets.length,
          groups, summary, offset, limit,
        });
      }

      const page = out.slice(offset, offset + limit).map(enrich);
      return sendJson(res, 200, {
        rev: cur.rev, total: out.length,
        rows: page,
        offset, limit,
      });
    }

    // ---------- 体积重除数 (体积数) ----------
    if (pathname === '/api/divs' && req.method === 'GET') {
      try {
        const rows = db.listDivs(scope);
        return sendJson(res, 200, { rows, total: rows.length });
      } catch (e) {
        return sendErr(res, 400, e.message);
      }
    }

    if (pathname === '/api/divs' && req.method === 'PUT') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); }
      catch (e) { return sendErr(res, 400, '请求格式不对'); }
      try {
        // div=null / '' 表示恢复自动取值
        const r = db.setDiv(scope, body.key, body.div, body.by || scope);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendErr(res, 400, e.message);
      }
    }

    if (pathname.startsWith('/api/rates/') && req.method === 'PUT'
        && !pathname.endsWith('/lock')) {
      const id = pathname.slice('/api/rates/'.length);
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const r = db.updateRate(scope, id, body, q.by || scope);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendErr(res, 400, e.message);
      }
    }

    if (pathname === '/api/import' && req.method === 'POST') {
      const raw = await readBody(req, 60 * 1024 * 1024);
      let payload;
      try { payload = JSON.parse(raw); } catch (e) { return sendErr(res, 400, 'JSON 解析失败: ' + e.message); }
      const data = payload.data || payload;
      if (!data || !Array.isArray(data.tiers)) return sendErr(res, 400, '缺少 tiers');
      db.ensureIds(data);
      const r = db.saveAll(scope, data, payload.note || '整表导入', q.by || scope);
      console.log(`[import] rev=${r.rev} tiers=${data.tiers.length}` +
                  ` lockedPreserved=${r.lockedPreserved || 0}` +
                  ` locksMissing=${r.locksMissing || 0}`);
      return sendJson(res, 200, { ok: true, ...r });
    }

    // ---- 整表导入: 上传报价表 ----
    if (pathname === '/api/import-file' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 60 * 1024 * 1024)) || '{}');
      if (!body.data) return sendErr(res, 400, '没收到文件内容');
      const name = String(body.filename || 'quote.xlsx').replace(/[^\w.\-一-龥]/g, '_');
      if (!/\.xlsx$/i.test(name)) return sendErr(res, 400, '只支持 .xlsx 文件');
      try {
        if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const file = path.join(UPLOAD_DIR, 'upload-' + Date.now() + '-' + name);
        fs.writeFileSync(file, Buffer.from(body.data, 'base64'));
        startImport(scope, file);
        return sendJson(res, 200, { ok: true, started: true });
      } catch (e) {
        return sendErr(res, e.status || 500, e.message);
      }
    }

    if (pathname === '/api/import-status' && req.method === 'GET') {
      const job = getJob(scope);
      return sendJson(res, 200, {
        state: job.state,
        startedAt: job.startedAt,
        file: job.file,
        log: job.log.slice(-25),
        error: job.error,
        result: job.result,
        // ---- 进度条 ----
        progress: Math.round(job.progress || 0),
        step: job.step || 0,
        stepTotal: job.stepTotal || 0,
        stepName: job.stepName || '',
        stepDone: job.stepDone || 0,
        elapsed: job.elapsed || 0,
        stepMs: job.stepMs || 0,
      });
    }

    // 锁定 / 解锁某个费率档 (整表推送时不覆盖)
    if (pathname.startsWith('/api/rates/') && pathname.endsWith('/lock') && req.method === 'PUT') {
      const id = pathname.slice('/api/rates/'.length, -'/lock'.length);
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const r = db.setLock(scope, id, body.locked !== false, q.by || scope);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendErr(res, 400, e.message);
      }
    }

    if (pathname === '/api/locks' && req.method === 'GET') {
      const locks = db.loadLocks(scope);
      return sendJson(res, 200, { count: Object.keys(locks).length, locks });
    }

    // 新增一条费率档 (手工加渠道 / 补漏的档位)
    if (pathname === '/api/rates' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const r = db.addRate(scope, body, q.by || scope);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendErr(res, 400, e.message);
      }
    }

    if (pathname === '/api/changes' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(q.limit || 100) || 100, 1), 1000);
      const offset = Math.max(Number(q.offset || 0) || 0, 0);
      const filter = { kind: q.kind || '', q: q.q || '', since: q.since || '' };
      return sendJson(res, 200, {
        changes: db.readChanges(scope, limit, offset, filter),
        total: db.countChanges(scope, filter),
        offset, limit,
      });
    }

    // ---------- 用户管理 (仅管理员) ----------
    if (pathname === '/api/users' && req.method === 'GET') {
      if (!isAdmin(req)) return sendErr(res, 403, '只有管理员能看用户列表');
      const list = users.listUsers().map(u => {
        const p = db.ratesPath(u.username);
        let tiers = 0, rev = 0, hasData = false;
        try {
          if (fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            tiers = ((raw.data && raw.data.tiers) || []).length;
            rev = raw.rev || 0;
            hasData = true;
          }
        } catch (e) { /* ignore */ }
        return { ...u, tiers, rev, hasData };
      });
      return sendJson(res, 200, { users: list });
    }

    if (pathname === '/api/users' && req.method === 'POST') {
      if (!isAdmin(req)) return sendErr(res, 403, '只有管理员能新增用户');
      let body;
      try { body = JSON.parse((await readBody(req, 8192)) || '{}'); }
      catch (e) { return sendErr(res, 400, '请求格式不对'); }
      const role = body.role === 'admin' ? 'admin' : 'user';
      try {
        const u = users.createUser(body.username, body.password, role);
        console.log(`[users] 管理员新增用户 ${u.username} (${role})`);
        return sendJson(res, 200, { ok: true, user: u.username, role: u.role });
      } catch (e) {
        return sendErr(res, 400, e.message);
      }
    }

    if (pathname.startsWith('/api/users/') && req.method === 'DELETE') {
      if (!isAdmin(req)) return sendErr(res, 403, '只有管理员能删除用户');
      const name = decodeURIComponent(pathname.slice('/api/users/'.length));
      if (!name) return sendErr(res, 400, '缺少用户名');
      if (name.toLowerCase() === 'admin') return sendErr(res, 400, 'admin 账号不能删除');
      const me = currentUser(req, q);
      if (name === me) return sendErr(res, 400, '不能删除当前登录的账号');
      try {
        const u = users.deleteUser(name);
        // 连同这个人的数据一起清掉
        const dir = db.scopeDir(u.username);
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (e) { console.error('[users] 删数据目录失败:', e.message); }
        console.log(`[users] 管理员删除用户 ${u.username}`);
        return sendJson(res, 200, { ok: true, user: u.username });
      } catch (e) {
        return sendErr(res, 400, e.message);
      }
    }

    // ---------- 登录/注册限流: 被锁的 IP (仅管理员) ----------
    if (pathname === '/api/rate-locks' && req.method === 'GET') {
      if (!isAdmin(req)) return sendErr(res, 403, '只有管理员能看锁定列表');
      return sendJson(res, 200, { locks: users.listRateLocks() });
    }

    if (pathname === '/api/rate-locks' && req.method === 'DELETE') {
      if (!isAdmin(req)) return sendErr(res, 403, '只有管理员能解封');
      const r = users.clearAllRates();
      console.log(`[rate] 管理员解封全部 IP (${r.cleared} 条)`);
      return sendJson(res, 200, { ok: true, ...r });
    }

    if (pathname.startsWith('/api/rate-locks/') && req.method === 'DELETE') {
      if (!isAdmin(req)) return sendErr(res, 403, '只有管理员能解封');
      const ip = decodeURIComponent(pathname.slice('/api/rate-locks/'.length));
      if (!ip) return sendErr(res, 400, '缺少 IP');
      const r = users.unlockRate(ip);
      console.log(`[rate] 管理员解封 IP ${ip}`);
      return sendJson(res, 200, { ok: true, ...r });
    }

    if (pathname === '/api/token-check' && req.method === 'GET') {
      return sendJson(res, 200, { ok: db.checkToken(tokenFrom(req, q)) });
    }

    // ---------- 静态 ----------
    if (pathname === '/admin' || pathname === '/admin/') {
      return serveStatic(res, path.join(__dirname, 'admin.html'));
    }
    if (pathname === '/admin/changes' || pathname === '/admin/changes/') {
      return serveStatic(res, path.join(__dirname, 'changes.html'));
    }
    if (pathname === '/admin/users' || pathname === '/admin/users/') {
      return serveStatic(res, path.join(__dirname, 'users.html'));
    }
    // 仪表条 / 渠道分布条的样式, 后台三个页面共用一份
    if (pathname === '/dash.css') { return serveStatic(res, path.join(__dirname, 'dash.css')); }
    // data_v2.js 里是全量价格。登录了按该用户的数据给, 没登录只给空壳 ——
    // 用空壳而不是 401, 是因为 <script src> 是同步加载的, 401 会让整页脚本挂掉,
    // 连登录按钮都用不了。空壳让页面外壳正常跑, 登录后 reload 就有数据了。
    if (pathname === '/data_v2.js' || pathname === '/data_v2.js/') {
      if (!viewer) {
        const stub = 'window.DATA = null;\n';
        res.writeHead(200, {
          'Content-Type': MIME['.js'],
          'Content-Length': Buffer.byteLength(stub),
          'Cache-Control': 'no-store',
        });
        return res.end(stub);
      }
      const cur = db.load(scope);
      if (cur.data) {
        const body = 'window.DATA = ' + JSON.stringify(cur.data) + ';\n';
        res.writeHead(200, {
          'Content-Type': MIME['.js'],
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        return res.end(body);
      }
    }
    let p = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.join(PUBLIC, path.normalize(p).replace(/^([/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(403); res.end('403'); return;
    }
    return serveStatic(res, filePath);
  } catch (e) {
    console.error('[error]', req.method, pathname, e);
    sendErr(res, 500, e.message);
  }
});

server.listen(PORT, HOST, () => {
  // 旧版是全局一份数据, 现在按用户分开 —— 把旧的挪到 admin 名下
  try { db.migrateLegacy(); }
  catch (e) { console.error('[startup] 迁移旧数据失败:', e.message); }

  // 首次启动自动建一个 admin 用户
  try {
    if (users.listUsers().length === 0) {
      const pw = process.env.ADMIN_PASSWORD || (require('crypto').randomBytes(9).toString('base64url'));
      users.createUser('admin', pw, 'admin');
      console.log('=============================================');
      console.log(' 已创建管理员账号:');
      console.log('   用户名: admin');
      console.log('   密码  : ' + pw);
      console.log('   (改密码: node server/user.js passwd admin)');
      console.log('=============================================');
    }
  } catch (e) {
    console.error('[startup] 建管理员失败:', e.message);
  }

  // 启动时补齐费率 id (保证后台能按 id 改价) —— 逐个用户扫一遍
  try {
    for (const u of users.listUsers()) {
      const cur0 = db.load(u.username);
      if (cur0.data && (cur0.data.tiers || []).some(t => !t.id)) {
        db.ensureIds(cur0.data);
        db.saveAll(u.username, cur0.data, '补齐费率 id', 'system');
        console.log(`[startup] 已补齐 ${u.username} 的费率 id`);
      }
    }
  } catch (e) {
    console.error('[startup] 补 id 失败:', e.message);
  }
  // 汇率自动刷新
  try { startFxWatcher(); }
  catch (e) { console.error('[fx] 启动汇率刷新失败:', e.message); }

  const cur = db.load(db.DEFAULT_SCOPE);
  console.log(`物流报价服务 已启动  http://${HOST}:${PORT}`);
  console.log(`  站主数据: ${cur.data ? (cur.data.tiers || []).length + ' 条费率' : '未导入'}` +
              `  rev=${cur.rev}`);
  const ul = users.listUsers();
  console.log(`  用户数: ${ul.length}  (管理: node server/user.js list)`);
  console.log(`  公开注册: 开启 (新用户数据为空, 需自己上传价格表)`);
  console.log(`  后台: http://${HOST}:${PORT}/admin`);
});
