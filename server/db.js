/*
 * 报价数据存储 —— 纯 JSON 文件, 零依赖。多用户: 每个用户一份数据。
 *
 * 目录:
 *   data/users.json         用户库 (见 users.js)
 *   data/users/<用户名>/     该用户的数据
 *       rates.json          当前生效的完整数据集
 *       locks.json          锁定档位 (手工改的价, 整表推送时不覆盖)
 *       changelog.jsonl     变更日志 (一行一条 JSON)
 *   data/admin.token        后台管理令牌 (首次启动自动生成)
 *   data/fx.json            汇率 (全站共用, 与用户无关)
 *
 * 写入用「临时文件 + rename」保证原子性, 进程崩溃不会留下半个文件。
 *
 * scope 就是用户名。DEFAULT_SCOPE 是站点主人 (admin) 的账号,
 * 匿名访问 /api/data 时回落到这里, 保证公开页还能用。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const TOKEN_FILE = path.join(DATA_DIR, 'admin.token');
const DEFAULT_SCOPE = 'admin';

function ensureDir(dir) {
  const d = dir || DATA_DIR;
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/** 用户名 -> 安全的目录名 */
function sanitizeScope(scope) {
  const s = String(scope || '').trim();
  return /^[A-Za-z0-9_.\-]{2,32}$/.test(s) ? s : DEFAULT_SCOPE;
}

function scopeDir(scope) { return path.join(USERS_DIR, sanitizeScope(scope)); }
function ratesPath(scope) { return path.join(scopeDir(scope), 'rates.json'); }
function locksPath(scope) { return path.join(scopeDir(scope), 'locks.json'); }
function changelogPath(scope) { return path.join(scopeDir(scope), 'changelog.jsonl'); }
/** 人工改过的体积重除数 (独立存, 整表导入不会冲掉) */
function divsPath(scope) { return path.join(scopeDir(scope), 'divs.json'); }

/** 原子写: 先写 .tmp 再 rename */
function atomicWrite(file, text) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 旧版是全局一份 (data/rates.json 等), 现在按用户分开。
 * 首次启动把旧文件挪到 admin 的目录里。只做一次, 幂等。
 */
function migrateLegacy() {
  ensureDir(DATA_DIR);
  ensureDir(USERS_DIR);
  const pairs = [
    [path.join(DATA_DIR, 'rates.json'), ratesPath(DEFAULT_SCOPE)],
    [path.join(DATA_DIR, 'locks.json'), locksPath(DEFAULT_SCOPE)],
    [path.join(DATA_DIR, 'changelog.jsonl'), changelogPath(DEFAULT_SCOPE)],
  ];
  for (const [from, to] of pairs) {
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      ensureDir(path.dirname(to));
      fs.renameSync(from, to);
      console.log('[db] 旧数据已迁移到 ' + to);
    }
  }
}

/** 读取当前数据集; 没有就返回空壳 */
function load(scope) {
  const RATES = ratesPath(scope);
  if (!fs.existsSync(RATES)) {
    return { rev: 0, updatedAt: null, data: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(RATES, 'utf8'));
    // 注意: 这里返回的是**原始数据**, 不套用人工改的除数。
    // 因为 load() 的结果会被 atomicWrite 写回 rates.json —— 如果这里就套了覆盖,
    // 人工改的除数会被固化进主数据文件, 以后「恢复自动」就没得恢复了。
    // 读接口请用 loadView(scope)。
    return {
      rev: raw.rev || 0,
      updatedAt: raw.updatedAt || null,
      data: raw.data || null,
    };
  } catch (e) {
    console.error('[db] rates.json 解析失败:', e.message);
    return { rev: 0, updatedAt: null, data: null };
  }
}

/** 读视图: 原始数据 + 套用人工改过的除数 (只给读接口用) */
function loadView(scope) {
  const cur = load(scope);
  if (cur.data && cur.data.groups) {
    applyDivOverrides(cur.data.groups, loadDivs(scope));
  }
  return cur;
}

/* ---------------- 锁定 (手工改的价, 整表推送时不覆盖) ---------------- */

function loadLocks(scope) {
  const LOCKS = locksPath(scope);
  if (!fs.existsSync(LOCKS)) return {};
  try {
    const o = JSON.parse(fs.readFileSync(LOCKS, 'utf8'));
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    console.error('[db] locks.json 解析失败:', e.message);
    return {};
  }
}

/* ---------------- 人工改过的体积重除数 ----------------
 * 跟锁定值一样存在独立文件里:
 *   - 整表导入重写 rates.json 时不会把手工改的除数冲掉
 *   - 「恢复自动」能回到原来的来源 (备注区 / 总目录 / 计算器规则), 而不是
 *     把 countryDiv 删掉 —— 删掉会让来源从「备注区」变成「计算器规则」,
 *     数值可能碰巧一样但来源丢了, 后面就没法跟源报价表对账了。
 *
 * 格式: { "<groupKey>": { div: 8000, orig: { div: 8000, src: "other" } } }
 */

function loadDivs(scope) {
  const F = divsPath(scope);
  if (!fs.existsSync(F)) return {};
  try {
    const o = JSON.parse(fs.readFileSync(F, 'utf8'));
    return (o && typeof o === 'object') ? o : {};
  } catch (e) {
    console.error('[db] divs.json 解析失败:', e.message);
    return {};
  }
}

function saveDivs(scope, map) {
  const F = divsPath(scope);
  ensureDir(path.dirname(F));
  atomicWrite(F, JSON.stringify(map, null, 1));
}

/** 把人工改的除数套到 groups 上 (在内存里, 不写 rates.json) */
function applyDivOverrides(groups, overrides) {
  if (!overrides || !Object.keys(overrides).length) return groups;
  for (const g of groups || []) {
    const ov = overrides[divKey(g)];
    if (!ov) continue;
    g.countryDiv = ov.div;
    g.countryDivSrc = 'manual';
    g.divOverride = true;
  }
  return groups;
}

function saveLocks(scope, locks) {
  const LOCKS = locksPath(scope);
  ensureDir(path.dirname(LOCKS));
  atomicWrite(LOCKS, JSON.stringify(locks, null, 1));
  try { fs.chmodSync(LOCKS, 0o600); } catch (e) { /* Windows 忽略 */ }
}

/** 锁定 / 解锁某个费率档 */
function setLock(scope, id, locked, by) {
  const cur = load(scope);
  if (!cur.data) throw new Error('还没有数据');
  const tier = (cur.data.tiers || []).find(x => x.id === id);
  if (!tier) throw new Error('找不到这条费率: ' + id);
  const locks = loadLocks(scope);
  if (locked) {
    locks[id] = {
      price: tier.price, fee: tier.fee,
      sheet: tier.sheet, country: tier.country, zone: tier.zone,
      line: tier.line, attr: tier.attr || '',
      mode: tier.mode, lo: tier.lo, hi: tier.hi,
      lockedAt: new Date().toISOString(), by: by || 'admin',
    };
  } else {
    delete locks[id];
  }
  saveLocks(scope, locks);
  // 同步写回数据文件, 保持 rates.json 里的标记和 locks.json 一致
  if (locked) tier.locked = true; else delete tier.locked;
  try {
    const next = Object.assign({}, cur, {
      data: cur.data,
      updatedAt: new Date().toISOString(),
    });
    atomicWrite(ratesPath(scope), JSON.stringify(next, null, 1));
  } catch (e) {
    console.error('[db] 同步 locked 标记失败:', e.message);
  }
  appendChange(scope, {
    at: new Date().toISOString(), rev: cur.rev, by: by || 'admin',
    kind: locked ? 'lock' : 'unlock', id,
    label: [tier.sheet, tier.country, tier.zone, tier.line, tier.attr || '通用',
            tier.mode, `${tier.lo}-${tier.hi}kg`].filter(x => x && x !== '-').join(' / '),
    before: null, after: locked ? { price: tier.price, fee: tier.fee } : null,
  });
  return { locked: !!locked, count: Object.keys(locks).length };
}

/** 整表保存时, 把锁定的档位还原成锁定时的价格 */
function applyLocks(scope, data) {
  const locks = loadLocks(scope);
  const ids = Object.keys(locks);
  if (!ids.length) return { preserved: 0, missing: [] };
  let preserved = 0;
  const missing = [];
  for (const id of ids) {
    const t = (data.tiers || []).find(x => x.id === id);
    if (!t) { missing.push(id); continue; }
    const l = locks[id];
    if (t.price !== l.price || t.fee !== l.fee) preserved++;
    t.price = l.price;
    t.fee = l.fee;
    t.locked = true;
  }
  // 没锁的档位清掉标记
  for (const t of data.tiers || []) {
    if (!locks[t.id]) delete t.locked;
  }
  return { preserved, missing };
}

/** 保存整份数据集 (导入用) */
function saveAll(scope, data, note, by) {
  const cur = load(scope);
  // 导入来的数据没有 id, 这里统一补上 (后台改价靠 id 定位)
  ensureIds(data);
  const lockRes = applyLocks(scope, data);
  const rev = (cur.rev || 0) + 1;
  const updatedAt = new Date().toISOString();
  // 算出这次导入到底改了哪些数据 (新增 / 删除 / 价格变动)
  const diff = diffTiers((cur.data && cur.data.tiers) || [], data.tiers || []);
  ensureDir(scopeDir(scope));
  atomicWrite(ratesPath(scope), JSON.stringify({ rev, updatedAt, data }));
  appendChange(scope, {
    at: updatedAt, rev, by: by || 'system', kind: 'import',
    note: note || '整表导入',
    changes: changeSummary(diff),
    lockedPreserved: lockRes.preserved,
  });
  return { rev, updatedAt, lockedPreserved: lockRes.preserved, locksMissing: lockRes.missing.length };
}

/** 原子地改一条费率, 返回改后的整份数据 */
function updateRate(scope, id, patch, by) {
  const cur = load(scope);
  if (!cur.data) throw new Error('还没有数据, 先导入');
  const tiers = cur.data.tiers || [];
  const idx = tiers.findIndex(t => t.id === id);
  if (idx < 0) throw new Error('找不到这条费率: ' + id);

  const before = { price: tiers[idx].price, fee: tiers[idx].fee };
  const after = {};
  if (patch.price != null) {
    const p = Number(patch.price);
    if (!isFinite(p) || p < 0) throw new Error('价格必须是 ≥0 的数字');
    if (p > 100000) throw new Error('价格太大了, 检查是否输错');
    tiers[idx].price = Math.round(p * 100) / 100;
    after.price = tiers[idx].price;
  }
  if (patch.fee != null) {
    const f = Number(patch.fee);
    if (!isFinite(f) || f < 0) throw new Error('挂号费必须是 ≥0 的数字');
    tiers[idx].fee = Math.round(f * 100) / 100;
    after.fee = tiers[idx].fee;
  }
  if (!Object.keys(after).length) throw new Error('没有要改的字段');

  // 已锁定的档位, 改价时同步更新锁里的值 (否则下次推送会被旧锁定值覆盖)
  const locks = loadLocks(scope);
  if (locks[id]) {
    if (after.price !== undefined) locks[id].price = after.price;
    if (after.fee !== undefined) locks[id].fee = after.fee;
    saveLocks(scope, locks);
  }

  const rev = (cur.rev || 0) + 1;
  const updatedAt = new Date().toISOString();
  ensureDir(scopeDir(scope));
  atomicWrite(ratesPath(scope), JSON.stringify({ rev, updatedAt, data: cur.data }));

  const t = tiers[idx];
  appendChange(scope, {
    at: updatedAt, rev, by: by || 'admin', kind: 'update',
    id,
    label: [t.sheet, t.country, t.zone, t.line, t.attr || '通用',
            t.mode, `${t.lo}-${t.hi}kg`].filter(x => x && x !== '-').join(' / '),
    before, after,
  });
  return { rev, updatedAt, tier: t };
}

/**
 * 新增一条费率档 (手工加渠道 / 补漏档位)。
 * sheet/country 必填, price 必填, 其余有默认值。
 */
function addRate(scope, spec, by) {
  const cur = load(scope);
  if (!cur.data) throw new Error('还没有数据, 先导入');
  const need = ['sheet', 'country', 'price'];
  for (const k of need) {
    if (spec[k] === undefined || spec[k] === null || spec[k] === '') {
      throw new Error('缺少必填字段: ' + k);
    }
  }
  const price = Number(spec.price);
  if (!isFinite(price) || price < 0) throw new Error('价格必须是 ≥0 的数字');
  const fee = spec.fee === undefined || spec.fee === null || spec.fee === '' ? 0 : Number(spec.fee);
  if (!isFinite(fee) || fee < 0) throw new Error('挂号费必须是 ≥0 的数字');

  const lo = Number(spec.lo || 0);
  const hi = spec.hi === undefined || spec.hi === null || spec.hi === '' ? 999 : Number(spec.hi);
  if (!isFinite(lo) || !isFinite(hi) || hi < lo) throw new Error('重量段不对');

  const tier = {
    sheet: String(spec.sheet).trim(),
    country: String(spec.country).trim(),
    zone: spec.zone || '-',
    line: spec.line || '-',
    attr: spec.attr || '',
    mode: spec.mode || 'band',
    lo, hi,
    price: Math.round(price * 100) / 100,
    fee: Math.round(fee * 100) / 100,
    nextkg: null, first_kg: null, next_kg: null,
  };

  const tiers = cur.data.tiers || (cur.data.tiers = []);
  // 同一渠道/国家/重量段 不允许重复
  const dup = tiers.find(x => x.sheet === tier.sheet && x.country === tier.country
    && (x.zone || '-') === tier.zone && (x.line || '-') === tier.line
    && (x.attr || '') === tier.attr && x.mode === tier.mode
    && Number(x.lo) === lo && Number(x.hi) === hi);
  if (dup) throw new Error('这个渠道/国家/重量段已经存在了, 直接改那一行就行');

  ensureIds(cur.data);
  const usedIds = new Set(tiers.map(x => x.id).filter(Boolean));
  tier.id = makeId(tier, usedIds);
  tiers.push(tier);

  // 渠道组也要建一个, 否则前端取不到这个渠道
  const groups = cur.data.groups || (cur.data.groups = []);
  const gk = [tier.sheet, tier.country, tier.zone, tier.line, tier.attr].join('|');
  if (!groups.some(g => [g.sheet, g.country, g.zone || '-', g.line || '-', g.attr || ''].join('|') === gk)) {
    groups.push({
      sheet: tier.sheet, country: tier.country, zone: tier.zone, line: tier.line,
      attr: tier.attr, mode: tier.mode, div: 6000, cur: 'EUR',
      lead: '', limits: '',
    });
  }

  const rev = (cur.rev || 0) + 1;
  const updatedAt = new Date().toISOString();
  ensureDir(scopeDir(scope));
  atomicWrite(ratesPath(scope), JSON.stringify({ rev, updatedAt, data: cur.data }));
  appendChange(scope, {
    at: updatedAt, rev, by: by || 'admin', kind: 'add',
    id: tier.id,
    label: [tier.sheet, tier.country, tier.zone, tier.line, tier.attr || '通用',
            tier.mode, `${lo}-${hi}kg`].filter(x => x && x !== '-').join(' / '),
    before: null, after: { price: tier.price, fee: tier.fee },
  });
  return { rev, updatedAt, tier };
}

/** 给每条费率生成稳定 id */
/** 按 (渠道|国家|分区|产品线|属性|方式|下限|上限) 生成稳定 id */
function makeId(t, used) {
  const base = [t.sheet, t.country, t.zone, t.line, t.attr || '', t.mode, t.lo, t.hi].join('|');
  let id = crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
  let n = 1;
  while (used && used.has(id)) {
    id = crypto.createHash('sha1').update(base + '#' + n).digest('hex').slice(0, 16);
    n++;
  }
  if (used) used.add(id);
  return id;
}

function ensureIds(data) {
  const used = new Set();
  for (const t of data.tiers || []) {
    t.id = makeId(t, used);
  }
  return data;
}

/**
 * 比对整表导入前后的费率库, 算出「到底改了哪些数据」。
 *
 * 关键: makeId 的 base 是 [sheet, country, zone, line, attr, mode, lo, hi],
 * **不含 price/fee** -> 价格变了 id 不变, 可以直接按 id 匹配新旧。
 *
 * 返回:
 *   { added: [...], removed: [...], changed: [...], counts: {...} }
 *   每一项都是 { id, label, price, fee } 或 { id, label, fields: [{field, before, after}] }
 */
function tierLabel(t) {
  return [t.sheet, t.country, t.zone, t.line, t.attr || '通用',
          t.mode, `${t.lo}-${t.hi}kg`].filter(x => x && x !== '-').join(' / ');
}

function diffTiers(oldTiers, newTiers) {
  const oldMap = new Map((oldTiers || []).map(t => [t.id, t]));
  const newMap = new Map((newTiers || []).map(t => [t.id, t]));
  const added = [], removed = [], changed = [];

  for (const t of (newTiers || [])) {
    const o = oldMap.get(t.id);
    if (!o) {
      added.push({ id: t.id, label: tierLabel(t), price: t.price, fee: t.fee });
      continue;
    }
    const fields = [];
    if (Number(o.price) !== Number(t.price)) {
      fields.push({ field: 'price', label: '运费', before: o.price, after: t.price });
    }
    if (Number(o.fee) !== Number(t.fee)) {
      fields.push({ field: 'fee', label: '挂号费', before: o.fee, after: t.fee });
    }
    if (fields.length) {
      changed.push({ id: t.id, label: tierLabel(t), fields });
    }
  }
  for (const t of (oldTiers || [])) {
    if (!newMap.has(t.id)) {
      removed.push({ id: t.id, label: tierLabel(t), price: t.price, fee: t.fee });
    }
  }
  return {
    added, removed, changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length },
  };
}

/** 把差异压成能存进 changelog 的形状 (明细有上限, 计数完整) */
function changeSummary(diff, maxItems) {
  const MAX = maxItems || 200;
  const items = [];
  for (const a of diff.added) {
    items.push({ t: 'added', id: a.id, label: a.label, price: a.price, fee: a.fee });
  }
  for (const c of diff.changed) {
    for (const f of c.fields) {
      items.push({ t: 'price', id: c.id, label: c.label, field: f.field,
                   fname: f.label, before: f.before, after: f.after });
    }
  }
  for (const r of diff.removed) {
    items.push({ t: 'removed', id: r.id, label: r.label, price: r.price, fee: r.fee });
  }
  return {
    added: diff.counts.added,
    removed: diff.counts.removed,
    changed: diff.counts.changed,
    total: items.length,
    items: items.slice(0, MAX),
    truncated: items.length > MAX,
  };
}


/**
 * ---- 体积重除数 (体积数) ----
 *
 * 除数属于「渠道组」(sheet × country × zone × line × attr × mode), 不属于单个档位 ——
 * 同一渠道同一国家的所有重量段共用一个除数。所以改一处会影响整组。
 *
 * 生效优先级 (与 engine.js 一致):
 *   countryDiv  -> 报价表备注区/总目录给的逐国除数 (可人工覆盖)
 *   rule.div    -> 原《物流定价计算器》的规则除数
 *   group.div   -> 专线三线 (体积/6000、/10000、/18000) 的固定除数
 *   6000        -> 兜底, 此时标 divUncertain=true
 */

const DIV_FALLBACK = 6000;

function divLabel(g) {
  return [g.sheet, g.country, g.zone, g.line, g.attr || '通用', g.mode]
    .filter(x => x && x !== '-').join(' / ');
}

function divSrcName(src) {
  return src === 'catalog' ? '总目录'
       : src === 'sheet' ? '备注·本国家'
       : src === 'other' ? '备注·其他国家'
       : src === 'manual' ? '人工填写'
       : src ? String(src) : '报价表';
}

function divKey(g) {
  return [g.sheet, g.country, g.zone || '-', g.line || '-',
          g.attr || '', g.mode || ''].join('|');
}

function divKeyOfTier(t) {
  return [t.sheet, t.country, t.zone || '-', t.line || '-',
          t.attr || '', t.mode || ''].join('|');
}

/** 这个 group 当前实际生效的除数 + 来源 */
/**
 * 把 rules 数组建成 Map —— key 必须和 engine.js / 前端 RULE_MAP 一致:
 *   `${channel}|${section}|${country}|${zone}`
 * (踩过: 之前把数组直接当对象用, 导致「原计算器规则」这一档永远命不中)
 */
function buildRuleMap(rules) {
  const m = new Map();
  for (const r of (rules || [])) {
    m.set(`${r.channel}|${r.section}|${r.country}|${r.zone}`, r);
  }
  return m;
}

/**
 * 这个 group 当前实际生效的除数 + 来源。
 * 优先级跟 engine.js 完全一致:
 *   countryDiv -> rule.div(type=normal) -> mode=='divider' 的 group.div
 *   -> group.div (这是 pack_data.py 硬编码的 6000, 不可信) -> 兜底 6000
 */
function divInfo(g, ruleMap) {
  const r = ruleMap && ruleMap.get ? ruleMap.get(g.ruleKey) : null;
  if (g.countryDiv) {
    // countryDivSrc: sheet=备注区里该国家明写 / other=备注区「其他国家」通用
    //                catalog=总目录第 5 列 / manual=后台人工填写
    const src = g.countryDivSrc === 'catalog' ? '总目录'
              : g.countryDivSrc === 'sheet' ? '备注·本国家'
              : g.countryDivSrc === 'other' ? '备注·其他国家'
              : g.countryDivSrc === 'manual' ? '人工填写'
              : g.countryDivSrc ? String(g.countryDivSrc) : '报价表';
    return { div: Number(g.countryDiv), src, kind: 'sheet',
             uncertain: false, overridden: !!g.divOverride };
  }
  if (r && r.type === 'normal' && r.div) {
    return { div: Number(r.div), src: '计算器规则', kind: 'rule',
             uncertain: false, overridden: false };
  }
  if (g.mode === 'divider' && g.div) {
    return { div: Number(g.div), src: '专线固定', kind: 'divider',
             uncertain: false, overridden: false };
  }
  // 到这一步只剩 pack_data.py 硬编码的 6000 —— 没有真实来源, 算「不确定」
  return {
    div: Number(g.div) || DIV_FALLBACK,
    src: '兜底值', kind: 'none',
    uncertain: true,
    overridden: false,
  };
}

/** 列出所有渠道组的除数 (供后台核对页) */
function listDivs(scope) {
  const cur = loadView(scope);
  if (!cur.data) throw new Error('还没有导入数据');
  const groups = cur.data.groups || [];
  const tiers = cur.data.tiers || [];
  // 统计每组有多少档位
  const cnt = new Map();
  for (const t of tiers) {
    const k = divKeyOfTier(t);
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  const ruleMap = buildRuleMap(cur.data.rules);
  return groups.map(g => {
    const k = divKey(g);
    const info = divInfo(g, ruleMap);
    return {
      key: k,
      sheet: g.sheet, country: g.country,
      zone: g.zone || '-', line: g.line || '-',
      attr: g.attr || '', mode: g.mode || '',
      div: info.div, src: info.src, kind: info.kind,
      uncertain: info.uncertain, overridden: info.overridden,
      tiers: cnt.get(k) || 0,
      lead: g.lead || '', cur: g.cur || g.currency || '',
    };
  });
}

/**
 * 改某个渠道组的体积数; div=null 表示恢复自动。
 *
 * 人工覆盖写在独立的 divs.json 里 (不直接改 rates.json):
 *   - 整表导入重写 rates.json 时不会被冲掉
 *   - 存了 orig (原值 + 原来源), 「恢复自动」能精确回到原来的来源
 */
function setDiv(scope, key, div, by) {
  const cur = load(scope);
  if (!cur.data) throw new Error('还没有导入数据');
  const groups = cur.data.groups || [];
  const g = groups.find(x => divKey(x) === key);
  if (!g) throw new Error('找不到这个渠道组: ' + key);

  const ruleMap = buildRuleMap(cur.data.rules);
  const overrides = loadDivs(scope);

  // 旧值: 从**原始**数据算 (cur.data 是原始的, 因为 load() 不套 overrides)
  const oldInfo = divInfo(g, ruleMap);

  if (div === null || div === undefined || div === '') {
    // 恢复自动: 回到原来的来源, 而不是把 countryDiv 删掉
    const ov = overrides[key];
    if (ov && ov.orig && ov.orig.div) {
      // 原来有 countryDiv -> 原样恢复 (值 + 来源都回来)
      g.countryDiv = ov.orig.div;
      g.countryDivSrc = ov.orig.src;
      delete g.divOverride;
      const rev = (cur.rev || 0) + 1;
      const updatedAt = new Date().toISOString();
      ensureDir(scopeDir(scope));
      atomicWrite(ratesPath(scope), JSON.stringify({ rev, updatedAt, data: cur.data }));
      delete overrides[key];
      saveDivs(scope, overrides);
      appendChange(scope, {
        at: updatedAt, rev, by: by || 'admin', kind: 'div',
        id: key, label: divLabel(g),
        before: { div: oldInfo.div, src: oldInfo.src },
        after: { div: ov.orig.div, src: divSrcName(ov.orig.src) },
      });
      return { rev, updatedAt, key, div: ov.orig.div, src: divSrcName(ov.orig.src) };
    }
    // 原来就没有 countryDiv -> 直接删掉覆盖
    delete overrides[key];
    saveDivs(scope, overrides);
    const rev = (cur.rev || 0) + 1;
    const updatedAt = new Date().toISOString();
    ensureDir(scopeDir(scope));
    atomicWrite(ratesPath(scope), JSON.stringify({ rev, updatedAt, data: cur.data }));
    appendChange(scope, {
      at: updatedAt, rev, by: by || 'admin', kind: 'div',
      id: key, label: divLabel(g),
      before: { div: oldInfo.div, src: oldInfo.src },
      after: { div: oldInfo.div, src: oldInfo.src },
    });
    return { rev, updatedAt, key, div: oldInfo.div, src: oldInfo.src };
  }

  const v = Number(div);
  if (!isFinite(v) || v <= 0) throw new Error('体积数必须是 >0 的数字');
  if (v > 100000) throw new Error('体积数太大了, 检查是否输错');
  if (v < 100) throw new Error('体积数太小了 (一般 4000~20000), 检查是否输错');

  // 第一次覆盖时记住原值和原来源, 供「恢复自动」用
  if (!overrides[key]) {
    overrides[key] = {
      div: v,
      orig: g.countryDiv
        ? { div: Number(g.countryDiv), src: g.countryDivSrc || 'other' }
        : { div: 0, src: '' },     // 0 = 原来就没有 countryDiv
    };
  } else {
    overrides[key].div = v;
  }
  saveDivs(scope, overrides);

  const rev = (cur.rev || 0) + 1;
  const updatedAt = new Date().toISOString();
  ensureDir(scopeDir(scope));
  atomicWrite(ratesPath(scope), JSON.stringify({ rev, updatedAt, data: cur.data }));

  appendChange(scope, {
    at: updatedAt, rev, by: by || 'admin', kind: 'div',
    id: key, label: divLabel(g),
    before: { div: oldInfo.div, src: oldInfo.src },
    after: { div: v, src: '人工填写' },
  });
  return { rev, updatedAt, key, div: v, src: '人工填写' };
}

function appendChange(scope, entry) {
  const CHANGELOG = changelogPath(scope);
  ensureDir(path.dirname(CHANGELOG));
  fs.appendFileSync(CHANGELOG, JSON.stringify(entry) + '\n', 'utf8');
}

function readChanges(scope, limit, offset, filter) {
  const CHANGELOG = changelogPath(scope);
  ensureDir(path.dirname(CHANGELOG));
  if (!fs.existsSync(CHANGELOG)) return [];
  const lines = fs.readFileSync(CHANGELOG, 'utf8').trim().split('\n').filter(Boolean);
  const all = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try { all.push(JSON.parse(lines[i])); } catch (e) { /* 跳过坏行 */ }
  }
  let list = all;
  if (filter && filter.kind) list = list.filter(c => c.kind === filter.kind);
  if (filter && filter.q) {
    const q = String(filter.q).toLowerCase();
    list = list.filter(c => JSON.stringify(c).toLowerCase().indexOf(q) >= 0);
  }
  // 时间范围: since = ISO 时间戳, 只看这个时间之后的改动
  if (filter && filter.since) {
    const since = Date.parse(filter.since);
    if (isFinite(since)) list = list.filter(c => Date.parse(c.at || 0) >= since);
  }
  const off = Number(offset) || 0;
  return list.slice(off, off + limit);
}

function countChanges(scope, filter) {
  const CHANGELOG = changelogPath(scope);
  ensureDir(path.dirname(CHANGELOG));
  if (!fs.existsSync(CHANGELOG)) return 0;
  const lines = fs.readFileSync(CHANGELOG, 'utf8').trim().split('\n').filter(Boolean);
  let n = 0;
  for (const l of lines) {
    let c; try { c = JSON.parse(l); } catch (e) { continue; }
    if (filter && filter.kind && c.kind !== filter.kind) continue;
    if (filter && filter.q && JSON.stringify(c).toLowerCase().indexOf(String(filter.q).toLowerCase()) < 0) continue;
    if (filter && filter.since) {
      const since = Date.parse(filter.since);
      if (isFinite(since) && Date.parse(c.at || 0) < since) continue;
    }
    n++;
  }
  return n;
}

/** 管理令牌: 首次启动生成, 之后从文件读 */
function getToken() {
  ensureDir();
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  }
  const t = crypto.randomBytes(24).toString('hex');
  atomicWrite(TOKEN_FILE, t);
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (e) { /* Windows 忽略 */ }
  return t;
}

function checkToken(token) {
  if (!token) return false;
  const want = getToken();
  const a = Buffer.from(String(token));
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  diffTiers, changeSummary, tierLabel,
  divKey, divKeyOfTier, divInfo, buildRuleMap, listDivs, setDiv,
  divsPath, loadDivs, saveDivs, applyDivOverrides, divLabel, divSrcName, loadView,
  load, saveAll, updateRate, addRate, ensureIds, appendChange, readChanges, countChanges,
  setLock, loadLocks, saveLocks, applyLocks,
  getToken, checkToken, atomicWrite,
  DATA_DIR, USERS_DIR, TOKEN_FILE, DEFAULT_SCOPE,
  scopeDir, ratesPath, locksPath, changelogPath, sanitizeScope, migrateLegacy,
};
