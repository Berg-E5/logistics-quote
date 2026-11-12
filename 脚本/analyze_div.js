#!/usr/bin/env node
/**
 * 体积重除数影响分析 (只读, 不修改任何数据文件)
 *
 * 背景:
 *   报价表「三态免泡大货专线（带电）」的 sheet 备注区里, 12 个国家明写
 *   「长*宽*高cm/18000」, 但 extract_div_rules.py 抽漏了 —— divRules 里没有
 *   这个渠道的条目, 于是引擎回退到原《物流定价计算器》的 rule.div (美国 8000)。
 *   报价表「总目录」第 18 行也写明「欧洲26国;美国;墨西哥，长*宽*高(CM)/18000」。
 *
 * 本脚本对比:
 *   A. 现状 (divUsed = rule.div, 美国 8000)
 *   B. 假设给该渠道所有国家 countryDiv = 18000
 * 并列出定价成本的变化, 供人工判断该不该改。
 *
 * 用法: node 脚本/analyze_div.js <data.json>
 */
const fs = require('fs');
const path = require('path');

const calc = require(path.join(__dirname, '..', 'engine.js'));

const dataFile = process.argv[2]
  || path.join(__dirname, '..', 'data', 'rates.json');
const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const data = raw.data || raw;

const SHEET = '三态免泡大货专线（带电）';
const NEW_DIV = 18000;

// ruleMap: channel|section|country|zone
const ruleMap = new Map();
for (const r of (data.rules || [])) {
  ruleMap.set(`${r.channel}|${r.section}|${r.country}|${r.zone}`, r);
}

// 典型输入组合 (覆盖小件/大件/泡货/超限)
const CASES = [
  { kg: 0.5, L: 20, W: 15, H: 10, attr: '带电' },
  { kg: 1,   L: 30, W: 20, H: 15, attr: '带电' },
  { kg: 2,   L: 40, W: 30, H: 20, attr: '带电' },
  { kg: 5,   L: 60, W: 50, H: 40, attr: '带电' },
  { kg: 10,  L: 80, W: 60, H: 50, attr: '带电' },
  { kg: 0.5, L: 20, W: 15, H: 10, attr: '普货' },
  { kg: 1,   L: 30, W: 20, H: 15, attr: '普货' },
  { kg: 5,   L: 60, W: 50, H: 40, attr: '普货' },
];

const groups = (data.groups || []).filter(g => g.sheet === SHEET);
if (!groups.length) {
  console.error(`没找到渠道「${SHEET}」`);
  process.exit(1);
}

console.log(`渠道: ${SHEET}  国家数: ${groups.length}`);
console.log(`当前各国家 divUsed:`);

const byCountry = new Map();
for (const g of groups) {
  if (!byCountry.has(g.country)) byCountry.set(g.country, g);
}

// 逐国算一个基准用例, 看当前用的除数
const probe = { kg: 5, L: 60, W: 50, H: 40, attr: '带电', buy: 490, recv: 1500, margin: 0.35, extra: 0.85, fx: 0 };
const divNow = new Map();
for (const [country, g] of byCountry) {
  const gs = groups.filter(x => x.country === country);
  const res = calc.quoteAll(gs, data.tiers, probe, ruleMap, true);
  const r = res.rows.find(x => x.matched && !x.blocked) || res.rows[0];
  divNow.set(country, r ? { divUsed: r.divUsed, total: r.total, blocked: r.blocked } : null);
}
const divList = {};
for (const [c, v] of divNow) divList[c] = v && v.divUsed;
console.log('  ' + JSON.stringify(divList));

// ---- 对比: 现状 vs countryDiv=18000 ----
console.log('\n================ 逐国逐用例对比 ================');
console.log('(定价成本 = 运费 + 挂号费 + 附加费 + 采购价 490)');

const summary = new Map();
let totalCases = 0, changedCases = 0;

for (const [country, g] of byCountry) {
  const gs = groups.filter(x => x.country === country);
  const rows = [];
  for (const c of CASES) {
    const inp = { ...c, buy: 490, recv: 1500, margin: 0.35, extra: 0.85, fx: 0 };
    const rA = calc.quoteAll(gs, data.tiers, inp, ruleMap, true);
    const pick = (res) => res.rows.find(x => x.matched && !x.blocked) || null;

    // 变体 B: 给这一组注入 countryDiv=18000
    const gsB = gs.map(x => ({ ...x, countryDiv: NEW_DIV }));
    const rB = calc.quoteAll(gsB, data.tiers, inp, ruleMap, true);

    const a = pick(rA), b = pick(rB);
    totalCases++;
    const same = (!a && !b) || (a && b && Math.abs(a.total - b.total) < 0.005
      && Math.abs(a.chargeKg - b.chargeKg) < 0.005);
    if (!same) changedCases++;
    if (a || b) {
      rows.push({
        inp: `${c.kg}kg ${c.L}x${c.W}x${c.H}`,
        A: a ? { div: a.divUsed, kg: a.chargeKg, total: a.total } : null,
        B: b ? { div: b.divUsed, kg: b.chargeKg, total: b.total } : null,
        same,
      });
    }
  }
  const changed = rows.filter(r => !r.same);
  summary.set(country, { changed: changed.length, total: rows.length });
  if (!changed.length) continue;

  console.log(`\n--- ${country}  (${changed.length}/${rows.length} 个用例有变化) ---`);
  for (const r of changed) {
    const f = (x) => x ? `÷${x.div} 计费重${x.kg}kg 成本¥${x.total}` : '无报价';
    const diff = (r.A && r.B) ? ` (${((r.B.total - r.A.total) / r.A.total * 100).toFixed(1)}%)` : '';
    console.log(`   ${r.inp.padEnd(18)} A: ${f(r.A).padEnd(28)} B: ${f(r.B).padEnd(28)}${diff}`);
  }
}

console.log('\n================ 汇总 ================');
console.log(`用例总数 ${totalCases}, 有变化 ${changedCases}`);
console.log('各国变化用例数:');
for (const [c, v] of [...summary].sort((a, b) => b[1].changed - a[1].changed)) {
  if (v.changed) console.log(`  ${c.padEnd(12)} ${v.changed}/${v.total}`);
}
