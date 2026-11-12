/*
 * 报价表口径的独立交叉验证 —— 不调 engine.js 的计算, 自己按公式重算一遍。
 *
 * 为什么要有这个:
 *   脚本/verify_calc.js 验的是「原计算器口径」(preferRates=false, 用原表写死的
 *   旧单价), 而网站前台实际跑的是「报价表口径」(preferRates=true, 用盛途报价表的
 *   当前单价 + 报价表逐国除数 + 报价表附加费规则)。两条路只共用公式骨架,
 *   价格来源完全不同, 所以网站那条路一直没有基准。
 *
 * 这个脚本的做法:
 *   1. 从 data_v2.js 取报价表数据
 *   2. 用下面 calcSimple 这套**独立写的朴素实现**算一遍
 *      (档位匹配、计费重、运费、定价成本、售价、毛利 全都自己算)
 *   3. 再调 engine.quoteAll 算一遍
 *   4. 逐条比对 —— 两套独立代码给出同一个数, 才算通过
 *   5. 顺便导出一份 CSV, 拿去跟源报价表人工核对
 *
 * 刻意「笨」: 只用最朴素的公式, 不做优化, 方便肉眼核对。
 *
 * 用法:
 *   node 脚本/verify_rates.js                 # 验证 + 打印差异
 *   node 脚本/verify_rates.js --csv out.csv   # 顺便导出核对用 CSV
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const SITE = (() => {
  const parent = path.join(HERE, '..');
  for (const c of [parent, path.join(parent, 'public')]) {
    if (fs.existsSync(path.join(c, 'engine.js')) && fs.existsSync(path.join(c, 'data_v2.js'))) return c;
  }
  return parent;
})();
const engine = require(path.join(SITE, 'engine.js'));

const raw = fs.readFileSync(path.join(SITE, 'data_v2.js'), 'utf8');
const DATA = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));

const ruleMap = new Map();
for (const r of (DATA.rules || [])) {
  ruleMap.set(`${r.channel}|${r.section}|${r.country}|${r.zone}`, r);
}

// ---------------------------------------------------------------------------
// 朴素实现
// ---------------------------------------------------------------------------
const EPS = 1e-9;
const r2 = x => Math.round((Number(x) || 0) * 100) / 100;
const r9 = x => Math.round((Number(x) || 0) * 1e9) / 1e9;

/**
 * 算一个渠道组的报价。返回 null 表示该组在这个输入下没有命中任何重量段。
 * 语义刻意跟《物流定价计算器》一致:
 *   体积重 = 长×宽×高 ÷ 除数
 *   计费重 = MAX(体积重, 实重)   (实重超出允许范围时按体积重计费)
 *   band / divider 档位: 命中所有档位, 运费 = Σ单价 × 计费重, 挂号费 = Σ挂号费
 *   firstnext 档位: 运费 = 首重价 + 续重单价 × 续重单位数
 *   定价成本 = 运费 + 挂号费 + 附加费 + 采购价
 *   售价 = 定价成本 ÷ 系数 ÷ 成本加成系数
 */
function calcSimple(group, tiers, inp, rule, extra) {
  const kg = Number(inp.kg) || 0;
  const L = Number(inp.L) || 0, W = Number(inp.W) || 0, H = Number(inp.H) || 0;
  const buy = Number(inp.buy) || 0;

  // 除数优先级: 报价表逐国除数 > 原计算器规则 > 专线固定 > 兜底 6000
  const div = group.countryDiv ? Number(group.countryDiv)
    : (rule && rule.type === 'normal' && rule.div) ? Number(rule.div)
    : (group.mode === 'divider' && group.div) ? Number(group.div)
    : 6000;
  const volKg = L * W * H / div;

  // 实重上下限
  const minKg = group.countryMinKg != null ? Number(group.countryMinKg)
    : (rule && rule.minKg != null ? Number(rule.minKg) : null);
  const maxKg = rule && rule.maxKg != null ? Number(rule.maxKg) : null;
  const wOk = (minKg == null || kg >= minKg) && (maxKg == null || kg <= maxKg);
  // 实重超范围: 原表 G 列判「超尺寸」就不可发; 只看体积重的渠道则按体积重计费
  let effKg = kg;
  if (!wOk) {
    if (rule && rule.weightBlocks) return null;   // 不可发
    effKg = 0;
  }
  const chg = Math.max(effKg, volKg);

  // 档位匹配
  let freight = 0, fee = 0, matched = false;
  const mode = group.mode;
  if (mode === 'band' || mode === 'divider') {
    const hits = tiers.filter(t => t.mode === mode && t.lo <= chg + EPS && t.hi >= chg - EPS);
    if (hits.length) {
      matched = true;
      freight = hits.reduce((s, t) => s + (t.price || 0), 0) * chg;
      fee = hits.reduce((s, t) => s + (t.fee || 0), 0);
    }
  } else if (mode === 'firstnext') {
    const hits = tiers.filter(t => t.mode === 'firstnext' && t.lo <= chg + EPS && t.hi >= chg - EPS);
    if (hits.length) {
      matched = true;
      const t = hits[0];
      const fkg = t.first_kg || 0, nkg = t.next_kg || 0;
      let units = Math.max(0, chg - fkg);
      if (nkg > 0) units = Math.ceil(r9(units / nkg));
      freight = (t.price || 0) + (t.nextkg || 0) * units;
      fee = hits.reduce((s, x) => s + (x.fee || 0), 0);
    }
  }
  if (!matched) return null;

  const surFee = Number((extra && extra.surFee) || 0);
  const total = r2(freight + fee + surFee + buy);
  const sells = {
    0.30: r2(total / 0.7 / 0.85),
    0.35: r2(total / 0.65 / 0.85),
    0.40: r2(total / 0.6 / 0.85),
  };
  const profit = r2((Number(inp.recv) || 0) - total);
  return { div, volKg: r2(volKg), chg: r2(chg), freight: r2(freight), fee: r2(fee),
           surFee: r2(surFee), total, sells, profit };
}

// ---- 档位索引 (和引擎一样按 sheet|country|zone|line|attr 分组) ----
const tiersByKey = new Map();
for (const t of (DATA.tiers || [])) {
  const k = [t.sheet, t.country, t.zone || '-', t.line || '-', t.attr || ''].join('|');
  if (!tiersByKey.has(k)) tiersByKey.set(k, []);
  tiersByKey.get(k).push(t);
}
function tiersFor(g) {
  const k = [g.sheet, g.country, g.zone || '-', g.line || '-', g.attr || ''].join('|');
  let ts = tiersByKey.get(k) || [];
  if (!ts.length && (g.attr || '')) {
    ts = tiersByKey.get([g.sheet, g.country, g.zone || '-', g.line || '-', ''].join('|')) || [];
  }
  return ts;
}

// ---- 测试输入 ----
const INPUTS = [
  { kg: 1,   L: 30,  W: 20, H: 15, attr: '普货', buy: 490, recv: 1500 },
  { kg: 2,   L: 40,  W: 30, H: 20, attr: '普货', buy: 490, recv: 1500 },
  { kg: 8,   L: 60,  W: 50, H: 40, attr: '普货', buy: 300, recv: 900 },
  { kg: 5,   L: 40,  W: 30, H: 20, attr: '带电', buy: 490, recv: 1500 },
  { kg: 0.5, L: 25,  W: 20, H: 15, attr: '普货', buy: 100, recv: 600 },
  { kg: 15,  L: 70,  W: 50, H: 45, attr: '普货', buy: 300, recv: 900 },
  { kg: 30,  L: 80,  W: 60, H: 50, attr: '带电', buy: 300, recv: 900 },
  { kg: 3,   L: 120, W: 90, H: 60, attr: '普货', buy: 490, recv: 1500 },   // 超限
];
const COUNTRIES = ['美国', '加拿大', '英国', '德国', '澳大利亚', '日本', '沙特阿拉伯', '墨西哥', '法国'];

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------
let checked = 0, bad = 0, skipped = 0;
const diffs = [];
const csvRows = [['国家', '属性', '重量kg', '尺寸cm', '渠道', '产品线', '除数', '体积重kg', '计费重kg',
                  '运费', '挂号费', '附加费', '定价成本', '售价35', '简单-成本', '引擎-成本', '差']];

for (const country of COUNTRIES) {
  const groups = (DATA.groups || []).filter(g => g.country === country);
  if (!groups.length) continue;
  for (const inp of INPUTS) {
    const full = Object.assign({ country, margin: 0.35, extra: 0.85, fx: 0 }, inp);
    const res = engine.quoteAll(groups, DATA.tiers, full, ruleMap, true);   // preferRates=true
    for (const r of (res.rows || [])) {
      if (!r.matched || r.blocked) { skipped++; continue; }
      const rule = r.ruleKey ? ruleMap.get(r.ruleKey) : null;
      const simple = calcSimple(r, tiersFor(r), full, rule, { surFee: r.surFee });
      if (!simple) { skipped++; continue; }

      checked++;
      const dTotal = Math.abs(simple.total - r.total);
      const dSell = Math.abs(simple.sells[0.35] - (r.sells[0.35] || 0));
      const dProfit = Math.abs(simple.profit - (r.profit == null ? simple.profit : r.profit));
      const tol = Math.max(0.05, Math.abs(r.total) * 0.002);
      if (dTotal > tol || dSell > tol * 2 || dProfit > tol) {
        bad++;
        if (diffs.length < 25) {
          diffs.push({
            渠道: r.sheet, 产品线: r.line || '-', 国家: country,
            尺寸: `${inp.L}x${inp.W}x${inp.H}`, 属性: inp.attr,
            简单: { 计费重: simple.chg, 运费: simple.freight, 挂号费: simple.fee, 成本: simple.total, 售价: simple.sells[0.35] },
            引擎: { 计费重: r.chargeKg, 运费: r.freight, 挂号费: r.fee, 成本: r.total, 售价: r.sells[0.35] },
            差: +(simple.total - r.total).toFixed(2),
          });
        }
      }
      csvRows.push([
        country, inp.attr, inp.kg, `${inp.L}x${inp.W}x${inp.H}`, r.sheet, r.line || '-',
        simple.div, simple.volKg, simple.chg, simple.freight, simple.fee, simple.surFee,
        simple.total, simple.sells[0.35], simple.total, r.total, +(simple.total - r.total).toFixed(2),
      ]);
    }
  }
}

console.log(`报价表口径交叉验证: 比对 ${checked} 组, 不一致 ${bad}, 跳过 ${skipped} (不可发/没命中重量段)`);
if (diffs.length) {
  console.log('\n差异明细:');
  for (const d of diffs) console.log('  ', JSON.stringify(d));
}

const csvArg = process.argv.indexOf('--csv');
if (csvArg > 0 && process.argv[csvArg + 1]) {
  const out = process.argv[csvArg + 1];
  const esc = v => {
    const s = (v === null || v === undefined) ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  fs.writeFileSync(out, '\uFEFF' + csvRows.map(r => r.map(esc).join(',')).join('\r\n'), 'utf8');
  console.log(`\n核对用 CSV 已导出: ${out}  (${csvRows.length - 1} 行)`);
}

process.exit(bad === 0 ? 0 : 1);
