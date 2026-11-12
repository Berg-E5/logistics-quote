#!/usr/bin/env node
/**
 * 新旧两份报价数据的结果差异 (只读)
 *
 * 背景: verify_calc.js 验证的是「engine 复现原计算器」(preferRates=false),
 *       不覆盖网站实际口径 (preferRates=true, 除数走报价表)。
 *       所以改报价表的除数后, 回归仍是绿灯 —— 必须用这个脚本看实际影响。
 *
 * 用法: node 脚本/diff_rates.js <旧data.json> <新data.json>
 */
const fs = require('fs');
const path = require('path');
const calc = require(path.join(__dirname, '..', 'engine.js'));

const [oldFile, newFile] = process.argv.slice(2);
if (!oldFile || !newFile) {
  console.error('用法: node diff_rates.js <旧data.json> <新data.json>');
  process.exit(1);
}
const load = (f) => {
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  return raw.data || raw;
};
const OLD = load(oldFile);
const NEW = load(newFile);

function ruleMapOf(data) {
  const m = new Map();
  for (const r of (data.rules || [])) {
    m.set(`${r.channel}|${r.section}|${r.country}|${r.zone}`, r);
  }
  return m;
}
const OLD_RM = ruleMapOf(OLD);
const NEW_RM = ruleMapOf(NEW);

const CASES = [
  { kg: 0.5, L: 20, W: 15, H: 10 },
  { kg: 1, L: 30, W: 20, H: 15 },
  { kg: 2, L: 40, W: 30, H: 20 },
  { kg: 5, L: 60, W: 50, H: 40 },
  { kg: 10, L: 80, W: 60, H: 50 },
  { kg: 20, L: 100, W: 70, H: 60 },
];

const gkey = (g) => [g.sheet, g.country, g.zone || '-', g.line || '-', g.attr || ''].join('|');

function groupsOf(data, sheet) {
  return (data.groups || []).filter((g) => g.sheet === sheet);
}
function pick(res) {
  return res.rows.find((x) => x.matched && !x.blocked) || null;
}

// ---- 1) 除数差异 ----
const oldG = new Map((OLD.groups || []).map((g) => [gkey(g), g]));
const newG = new Map((NEW.groups || []).map((g) => [gkey(g), g]));
const divChanged = [];
for (const [k, ng] of newG) {
  const og = oldG.get(k);
  if (!og) continue;
  if ((og.countryDiv || null) !== (ng.countryDiv || null)) {
    divChanged.push({ k, old: og.countryDiv, now: ng.countryDiv, src: ng.countryDivSrc });
  }
}
console.log('==== 除数变化的组: ' + divChanged.length + ' ====');
const bySheet = new Map();
for (const d of divChanged) {
  const s = d.k.split('|')[0];
  if (!bySheet.has(s)) bySheet.set(s, []);
  bySheet.get(s).push(d);
}
for (const [s, list] of bySheet) {
  const o = [...new Set(list.map((x) => String(x.old)))].join('/');
  const n = [...new Set(list.map((x) => String(x.now)))].join('/');
  console.log(`  ${s.padEnd(26)} ${o} -> ${n}   (${list.length} 国, 来源 ${[...new Set(list.map((x) => x.src))].join(',')})`);
}

// ---- 2) 结果差异 ----
console.log('\n==== 结果差异 (按渠道+国家, 取每组第一个可发渠道) ====');
let changedGroups = 0, totalGroups = 0, blockedNew = 0, blockedOld = 0;
const detail = [];

for (const [k, ng] of newG) {
  const og = oldG.get(k);
  if (!og) continue;
  const sheet = ng.sheet, country = ng.country;
  const oGroups = groupsOf(OLD, sheet).filter((g) => g.country === country);
  const nGroups = groupsOf(NEW, sheet).filter((g) => g.country === country);
  if (!oGroups.length || !nGroups.length) continue;

  for (const attr of ['普货', '带电']) {
    const og2 = oGroups.filter((g) => !g.attr || g.attr === attr);
    const ng2 = nGroups.filter((g) => !g.attr || g.attr === attr);
    if (!og2.length || !ng2.length) continue;

    for (const c of CASES) {
      const inp = { ...c, attr, buy: 490, recv: 1500, margin: 0.35, extra: 0.85, fx: 0 };
      const a = pick(calc.quoteAll(og2, OLD.tiers, inp, OLD_RM, true));
      const b = pick(calc.quoteAll(ng2, NEW.tiers, inp, NEW_RM, true));
      totalGroups++;
      if (!a && !b) continue;
      if (!a && b) { blockedOld++; changedGroups++; detail.push({ sheet, country, attr, inp: c, old: null, now: b }); continue; }
      if (a && !b) { blockedNew++; changedGroups++; detail.push({ sheet, country, attr, inp: c, old: a, now: null }); continue; }
      if (Math.abs(a.total - b.total) > 0.005 || Math.abs(a.chargeKg - b.chargeKg) > 0.005) {
        changedGroups++;
        detail.push({ sheet, country, attr, inp: c, old: a, now: b });
      }
    }
  }
}
console.log(`总比对 ${totalGroups} 次, 有差异 ${changedGroups} 次`);
console.log(`  原来发不了现在能发: ${blockedOld}   原来能发现在发不了: ${blockedNew}`);

// 按渠道汇总
const dBySheet = new Map();
for (const d of detail) {
  if (!dBySheet.has(d.sheet)) dBySheet.set(d.sheet, []);
  dBySheet.get(d.sheet).push(d);
}
for (const [s, list] of [...dBySheet].sort((a, b) => b[1].length - a[1].length)) {
  const countries = [...new Set(list.map((x) => x.country))];
  const deltas = list.filter((x) => x.old && x.now)
    .map((x) => (x.now.total - x.old.total) / x.old.total * 100);
  const lo = deltas.length ? Math.min(...deltas).toFixed(1) : '-';
  const hi = deltas.length ? Math.max(...deltas).toFixed(1) : '-';
  console.log(`  ${s.padEnd(26)} ${list.length} 次差异, ${countries.length} 国, 价格变动 ${lo}% ~ ${hi}%`);
}

// 抽样明细
console.log('\n==== 抽样明细 (每个渠道最多 6 条) ====');
for (const [s, list] of dBySheet) {
  console.log(`\n--- ${s} ---`);
  const seen = new Set();
  let shown = 0;
  for (const d of list) {
    const ck = d.country + '|' + d.attr + '|' + d.inp.kg + '|' + d.inp.L;
    if (seen.has(ck)) continue;
    seen.add(ck);
    if (shown++ >= 6) break;
    const f = (x) => x ? `÷${x.divUsed} 计费重${x.chargeKg}kg 成本¥${x.total}` : '不可发';
    const pct = (d.old && d.now) ? ` (${((d.now.total - d.old.total) / d.old.total * 100).toFixed(1)}%)` : '';
    console.log(`   ${d.country.padEnd(6)} ${d.attr} ${d.inp.kg}kg ${d.inp.L}x${d.inp.W}x${d.inp.H}  旧:${f(d.old).padEnd(30)} 新:${f(d.now).padEnd(30)}${pct}`);
  }
}
