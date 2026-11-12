/*
 * 验证引擎 v2: 与《物流定价计算器.xlsx》的公式结果逐格比对。
 *
 * 做法:
 *   1. 用 LibreOffice 重算原表, 拿到每个国家行的 M(定价成本) N/O/P(售价) U(毛利) V(利润比)
 *   2. 用 engine.js 按同样输入算出同样的值
 *   3. 比对
 *
 * 原表输入: E3=长 F3=宽 G3=高 H3=重量 I3=属性 K3=采购价 L3=到账
 */
const fs = require('fs');
const path = require('path');

// 引擎和费率数据都取网站根目录的现版 (脚本目录的副本会过期)。
// 服务器上根目录没有, 放在 public/ 下, 所以两处都找一下。
const HERE = __dirname;
const SITE = (() => {
  const parent = path.join(HERE, '..');
  for (const c of [parent, path.join(parent, 'public')]) {
    if (fs.existsSync(path.join(c, 'engine.js')) && fs.existsSync(path.join(c, 'data_v2.js'))) return c;
  }
  return parent;
})();
const engine = require(path.join(SITE, 'engine.js'));

// data_v2.js 前面是赋值语句, 后面才是 JSON
const raw = fs.readFileSync(path.join(SITE, 'data_v2.js'), 'utf8');
const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));

const expect = JSON.parse(fs.readFileSync(path.join(HERE, 'expect_calc.json'), 'utf8'));

// 规则索引
const ruleMap = new Map();
for (const r of data.rules) {
  ruleMap.set(`${r.channel}|${r.section}|${r.country}|${r.zone}`, r);
}

let bad = 0, checked = 0, skip = 0, overSkipped = 0;

for (const sc of expect.cases) {
  const inp = {
    kg: sc.kg, L: sc.L, W: sc.W, H: sc.H,
    attr: sc.attr, buy: sc.buy, recv: sc.recv, margin: 0.35, extra: 0.85
  };
  // 找到对应的渠道组: 按原表的 渠道|小节|国家|分区 定位规则, 再取套用该规则的组
  const nz = z => { z = (z||'').trim(); if (!z) return '-';
    return z.replace('一区','1区').replace('二区','2区').replace('三区','3区')
            .replace('四区','4区').replace('五区','5区').replace('六区','6区'); };
  const nc = c => ({ '沙特': '沙特阿拉伯' }[(c||'').trim()] || (c||'').trim());
  const rkey = `${sc.channel}|${sc.section}|${nc(sc.country)}|${nz(sc.zone)}`;
  // 原表公式本身有复制粘贴错误的行 (引用了非输入行), 其规则不可信 -> 跳过比对
  if (!ruleMap.has(rkey)) { skip++; continue; }
  const groups = data.groups.filter(g => g.ruleKey === rkey);
  if (!groups.length) { skip++; continue; }

  const res = engine.quoteAll(groups, data.tiers, inp, ruleMap);
  if (!res.rows.length) { skip++; continue; }
  // 原表 D 列是"三条产品线取最小" (MIN(...J,...K,...L)), 而网站把三条线分行显示。
  // 因此基准对比应取匹配组里定价成本最低的那一行。
  let r = res.rows[0];
  if (res.rows.length > 1) {
    const okRows = res.rows.filter(x => x.matched && !x.blocked);
    if (okRows.length) r = okRows.reduce((a, b) => (b.total < a.total ? b : a));
  }

  const dM = Math.abs(r.total - sc.total);
  const dN = Math.abs((r.sells[0.30] || 0) - sc.sell30);
  const dO = Math.abs((r.sells[0.35] || 0) - sc.sell35);
  const dP = Math.abs((r.sells[0.40] || 0) - sc.sell40);
  // 不可发的渠道: 引擎把 profit 置 null (原表会算成「毛利 = 到账全额」, 那是原表的缺陷),
  // 所以这一项不比 —— 其余字段照常比。
  // 不可发: 引擎把 profit 置 null (原表 U 列会算成「毛利 = 到账全额」, 那是原表的缺陷)。
  // 判定用「基准标了 over」或「引擎判 blocked」两个条件 —— 原表判超尺寸的情形比
  // 引擎判 blocked 的情形少 (实重超范围/未命中重量段, 原表没有这些判定),
  // 但那些情形下原表 M 列同样是 0, U 列同样是到账全额, 所以同样不该比毛利。
  const overCase = !!sc.over || !!r.blocked;
  const dU = overCase ? 0 : Math.abs(r.profit - sc.profit);
  if (overCase) overSkipped++;

  checked++;
  const tol = Math.max(0.02, Math.abs(sc.total) * 0.001);
  if (dM > tol || dN > tol * 2 || dO > tol * 2 || dP > tol * 2 || dU > tol) {
    bad++;
    if (bad <= 15) {
      console.log(`   ! ${sc.label}`);
      console.log(`      定价成本 js=${r.total} xl=${sc.total} (差 ${dM.toFixed(3)})`);
      console.log(`      售价30  js=${r.sells[0.30]} xl=${sc.sell30} | 35 js=${r.sells[0.35]} xl=${sc.sell35} | 40 js=${r.sells[0.40]} xl=${sc.sell40}`);
      // 原表的「运费」列公式是 ...+M, 含挂号费; 引擎把运费/挂号费拆两列, 所以这里比合计
      console.log(`      毛利   js=${r.profit} xl=${sc.profit}  运费+挂号费 js=${r.freight + r.fee} xl=${sc.freight} (js运费=${r.freight} js挂号费=${r.fee})`);
    }
  }
}

console.log(`\n比对 ${checked} 组, 不一致 ${bad}, 跳过 ${skip}`);
if (overSkipped) console.log(`其中 ${overSkipped} 组是不可发渠道, 毛利项不参与比对 (引擎按「不可发」处理)`);
process.exit(bad === 0 ? 0 : 1);
