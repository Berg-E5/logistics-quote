/*
 * 物流报价计算核心 v2 —— 纯函数, 无依赖。
 * 浏览器与 Node 共用同一份实现, 便于验证。
 *
 * 两套数据源:
 *   rates  —— 报价表抽出的完整费率库 (35 渠道, 阶梯价/首重续重/体积除数)
 *   rules  —— 《物流定价计算器》抽出的定价规则 (尺寸限制/重量上下限/普货带电双价/汇率)
 *
 * 计算口径完全对齐《物流定价计算器》:
 *   体积重   = 长×宽×高 ÷ 渠道除数
 *   计费重   = MAX(体积重, 实重); 尺寸或重量超限则判「超尺寸」
 *   运费     = 计费重 × 单价 + 挂号费 (+ 超尺寸加收)
 *   定价成本 = 运费 + 挂号费 + 采购价
 *   售价     = 定价成本 ÷ (0.7 | 0.65 | 0.6) ÷ 0.85     ← 30% / 35% / 40% 毛利
 *   当地售价 = 售价 ÷ 汇率
 *   毛利额   = 到账价 − 定价成本
 */

const EPS = 1e-6;

/** 档位边界去重: 报价表写 "0-2KG"/"2-10KG" 时 2kg 会命中两档。 */
function dedupeBands(tiers) {
  const items = tiers.filter(t => t.band).slice()
    .sort((a, b) => a.band[0] - b.band[0] || a.band[1] - b.band[1]);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    let [lo, hi] = t.band;
    if (i + 1 < items.length) {
      const nextLo = items[i + 1].band[0];
      if (nextLo <= hi) hi = nextLo - 0.001;
    }
    if (hi < lo) hi = lo;
    out.push(Object.assign({}, t, { band: [lo, hi] }));
  }
  return out;
}

function volumetricWeight(L, W, H, div) {
  return (L * W * H) / div;
}

function chargeableWeight(kg, L, W, H, div) {
  return Math.max(kg, volumetricWeight(L, W, H, div));
}

function round9(x) { return Math.round(x * 1e9) / 1e9; }
function round2(x) { return Math.round(x * 100) / 100; }

/**
 * 尺寸条件判定 (来自《物流定价计算器》E 列公式解析出的 dims)。
 * var: E=长 F=宽 G=高 sum=三边和 girth=围长(长+(宽+高)*2)
 */
function checkDims(dims, L, W, H) {
  if (!dims || !dims.length) return { ok: true, over: null };
  for (const d of dims) {
    let actual;
    switch (d.var) {
      case 'E': actual = L; break;
      case 'F': actual = W; break;
      case 'G': actual = H; break;
      case 'sum': actual = L + W + H; break;
      case 'girth': actual = L + (W + H) * 2; break;
      case 'volMax':
        // 体积重上限: 体积 ÷ 专属除数 不能超过阈值 (如 YDH 英国 体积/8000 <= 5kg)
        actual = volumetricWeight(L, W, H, d.div || 8000);
        break;
      default: actual = 0;
    }
    const ok = d.op === '<=' ? actual <= d.val
             : d.op === '>=' ? actual >= d.val
             : d.op === '<' ? actual < d.val
             : d.op === '>' ? actual > d.val : true;
    if (!ok) {
      return { ok: false, over: { var: d.var, op: d.op, val: d.val, actual: actual } };
    }
  }
  return { ok: true, over: null };
}

/** 重量是否在渠道允许范围内 */
function checkWeight(minKg, maxKg, kg) {
  if (minKg != null && kg <= minKg) return { ok: false, reason: '低于起收重量 ' + minKg + 'kg' };
  if (maxKg != null && kg > maxKg) return { ok: false, reason: '超过最大重量 ' + maxKg + 'kg' };
  return { ok: true };
}

/** 超尺寸加收: 超过 dims 阈值但未超 hard limit 时加收 */
function oversizeFee(rule, L, W, H) {
  if (!rule || !rule.oversizeFee) return 0;
  const o = rule.oversizeFee;
  if (L > o.l || W > o.w || H > o.h) return o.fee;
  return 0;
}

/** 超过 hard limit 完全不能发 */
function overLimit(rule, L, W, H) {
  if (!rule || !rule.overLimit) return false;
  const o = rule.overLimit;
  return L > o.l || W > o.w || H > o.h;
}

/** 按重量段取挂号费 (原表专线按段收不同挂号费) */
/**
 * 报价表尺寸限制判定。
 * lim 来自《渠道整合报价》的尺寸说明, 字段见 extract_surcharges.py。
 * 返回 { blocked, reason, needOversize }
 */
function checkRateLimit(lim, kg, L, W, H, div, volKg) {
  if (!lim) return { blocked: false, reason: '', needOversize: false };
  const d = [L, W, H].slice().sort((a, b) => b - a);
  const [d1, d2, d3] = d;
  const girth = d1 + (d2 + d3) * 2;       // 长 + (宽+高)*2
  const girth2 = d1 + 2 * (d2 + d3);      // 长 + 2*(次长+最短)  (与上式同值)
  const sum3 = d1 + d2 + d3;
  const vol = (L * W * H) / 1000000;      // m³

  // 最大三边 (降序逐边比较)
  if (lim.maxDim && lim.maxDim.length === 3) {
    const md = lim.maxDim.slice().sort((a, b) => b - a);
    const over = d1 > md[0] + 1e-6 || d2 > md[1] + 1e-6 || d3 > md[2] + 1e-6;
    if (over) {
      const alt = lim.altMaxDim;
      if (alt && alt.length === 3) {
        const ad = alt.slice().sort((a, b) => b - a);
        if (d1 <= ad[0] + 1e-6 && d2 <= ad[1] + 1e-6 && d3 <= ad[2] + 1e-6) {
          return { blocked: false, reason: '', needOversize: true };
        }
      }
      return {
        blocked: true, needOversize: false,
        reason: `超最大尺寸 ${md[0]}×${md[1]}×${md[2]}cm（实际 ${fmtDims(d1, d2, d3)}）`,
      };
    }
  }
  if (lim.maxSide != null && d1 > lim.maxSide + 1e-6) {
    return { blocked: true, needOversize: false,
             reason: `最长边超 ${lim.maxSide}cm（实际 ${d1}）` };
  }
  if (lim.maxSide2 != null && d2 > lim.maxSide2 + 1e-6) {
    return { blocked: true, needOversize: false,
             reason: `第二边超 ${lim.maxSide2}cm（实际 ${d2}）` };
  }
  if (lim.maxGirth1 != null && girth > lim.maxGirth1 + 1e-6) {
    return { blocked: true, needOversize: false,
             reason: `围长超 ${lim.maxGirth1}cm（实际 ${round2(girth)}）` };
  }
  if (lim.maxGirth2 != null && girth2 > lim.maxGirth2 + 1e-6) {
    return { blocked: true, needOversize: false,
             reason: `长+2×(宽+高) 超 ${lim.maxGirth2}cm（实际 ${round2(girth2)}）` };
  }
  if (lim.maxSum3 != null && sum3 > lim.maxSum3 + 1e-6) {
    return { blocked: true, needOversize: false,
             reason: `三边和超 ${lim.maxSum3}cm（实际 ${round2(sum3)}）` };
  }
  if (lim.maxWt != null && kg > lim.maxWt + 1e-6) {
    return { blocked: true, needOversize: false,
             reason: `实重超 ${lim.maxWt}kg（实际 ${kg}）` };
  }
  if (lim.maxVolM3 != null && vol > lim.maxVolM3 + 1e-9) {
    return { blocked: true, needOversize: false,
             reason: `体积超 ${lim.maxVolM3}m³（实际 ${round2(vol)}）` };
  }
  if (lim.minDim && lim.minDim.length >= 2) {
    const mn = lim.minDim.slice().sort((a, b) => a - b);
    const small = d.slice().sort((a, b) => a - b);
    if ((mn.length === 2 && (small[1] < mn[0] - 1e-6 || small[2] < mn[1] - 1e-6))
        || (mn.length === 3 && (small[0] < mn[0] - 1e-6 || small[1] < mn[1] - 1e-6
                                || small[2] < mn[2] - 1e-6))) {
      return { blocked: true, needOversize: false,
               reason: `小于最小尺寸 ${mn.join('×')}cm` };
    }
  }
  return { blocked: false, reason: '', needOversize: false };
}

/** 单条附加费条件判定 */
function condHit(c, kg, L, W, H, div) {
  const d = [L, W, H].slice().sort((a, b) => b - a);
  const [d1, d2, d3] = d;
  const girth = d1 + (d2 + d3) * 2;
  const sum3 = d1 + d2 + d3;
  const volKg = volKgOf(L, W, H, div);
  for (const k of Object.keys(c)) {
    const v = c[k];
    if (k === 'weight_gt' && !(kg > v)) return false;
    else if (k === 'side_gt' && !(d1 > v)) return false;
    else if (k === 'side_ge' && !(d1 >= v)) return false;
    else if (k === 'other_side_gt' && !(d2 > v || d3 > v)) return false;
    else if (k === 'side2_ge' && !(d2 >= v)) return false;
    else if (k === 'girth2_gt' && !(girth > v)) return false;
    else if (k === 'girth1_gt' && !(girth > v)) return false;
    else if (k === 'sum3_gt' && !(sum3 > v)) return false;
    else if (k === 'sum3_lte' && !(sum3 <= v)) return false;
    else if (k === 'vol_ratio_gt' && !(kg > 0 && volKg / kg > v)) return false;
    else if (k === 'vol_m3_gt' && !((L * W * H) / 1000000 > v)) return false;
    else if (k === 'dim_gt') {
      // 超过给定三边 (降序逐边比较) -> 命中
      const lim = v.slice().sort((a, b) => a - b);   // 升序
      const over = d[0] > lim[2] + 1e-6 || d[1] > lim[1] + 1e-6 || d[2] > lim[0] + 1e-6;
      if (!over) return false;
    }
    else if (k === 'dim_ge') {
      const need = v.slice().sort((a, b) => a - b);
      if (!(d[0] >= need[0] && d[1] >= need[1] && d[2] >= need[2])) return false;
    }
  }
  return true;
}

/**
 * 计算附加费。返回 { fee, list }。
 * sur 里 stack=false 的同名项只取最高一笔; stack=true 的累加。
 * manual=true 的只提示, 不计入金额。
 */
function evalSurcharges(sur, kg, L, W, H, div) {
  if (!sur || !sur.length) return { fee: 0, list: [] };
  const hit = [];
  for (const s of sur) {
    if (s.manual) continue;                       // 需人工判断, 不自动计费
    const conds = s.cond || [];
    let ok;
    if (!conds.length) ok = !!s.forceApply;       // 无条件 -> 不自动收
    else if (s.any) ok = conds.some(c => condHit(c, kg, L, W, H, div));
    else ok = conds.every(c => condHit(c, kg, L, W, H, div));
    if (!ok) continue;
    const fee = (s.fee != null) ? s.fee : ((s.fee_per_kg || 0) * kg);
    if (fee > 0) hit.push({ name: s.name, fee: fee, stack: s.stack !== false, note: s.note || '' });
  }
  if (!hit.length) return { fee: 0, list: [] };

  // 不叠加组 (同名或 stack=false) 只取最高
  const noStack = hit.filter(x => !x.stack);
  const stack = hit.filter(x => x.stack);
  let fee = stack.reduce((a, b) => a + b.fee, 0);
  const list = stack.slice();
  if (noStack.length) {
    const best = noStack.reduce((a, b) => (b.fee > a.fee ? b : a));
    fee += best.fee;
    list.push(best);
  }
  return { fee: round2(fee), list: list };
}

function volKgOf(L, W, H, div) {
  return (L * W * H) / (div || 6000);
}

function fmtDims(a, b, c) {
  return `${a}×${b}×${c}`;
}

function feeByBand(bands, kg) {
  if (!bands || !bands.length) return 0;
  // 单值标签 (如 "全部") -> 直接用
  const single = bands.find(b => !/\d+\s*-\s*\d+/.test(String(b.label)));
  if (single) return single.fee;

  let chosen = null;
  for (const b of bands) {
    const m = String(b.label).match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
    if (!m) continue;
    const hi = parseFloat(m[2]);
    if (kg <= hi) { chosen = b; break; }
    if (!chosen) chosen = b;
  }
  return chosen ? chosen.fee : 0;
}

/**
 * 计算单个渠道组的报价。
 * @param {object} q   渠道组 { sheet, country, zone, line, mode, div, lead, limits }
 * @param {Array}  lib 该渠道组的费率档
 * @param {object} inp { kg, L, W, H, attr, buy, recv, margin, extra }
 * @param {object} rule 可选的定价规则 (来自《物流定价计算器》)
 */
function quote(q, lib, inp, rule, preferRates) {
  const kg = Number(inp.kg) || 0;
  const L = Number(inp.L) || 0, W = Number(inp.W) || 0, H = Number(inp.H) || 0;
  const attr = inp.attr || '普货';
  const buy = Number(inp.buy) || 0;
  const recv = Number(inp.recv) || 0;
  const margin = inp.margin == null ? 0.35 : Number(inp.margin);
  const extra = Number(inp.extra) || 0.85;   // 平台佣金/成本加成系数

  const out = {
    freight: 0, fee: 0, total: 0, chargeKg: 0, volKg: 0,
    matched: false, oversize: false, overLimit: false, blocked: false, note: '', line: '',
    sells: {}, locals: {}, profit: 0, profitRatio: 0, fx: 0, buy: buy
  };

  // ---- 定价成本 / 售价 / 利润 (提前返回的分支也要算, 原表超尺寸时 U 列仍有值) ----
  function finalize(o) {
    o.freight = round2(o.freight);
    o.fee = round2(o.fee);
    // 不可发时定价成本记 0 (原表 M 列: IF(G="超尺寸",0,...)), 不含采购价
    if (o.blocked) { o.surFee = 0; o.surList = []; }
    o.surFee = round2(o.surFee || 0);
    // 附加费计入定价成本 (运费 + 挂号费 + 附加费 + 采购价)
    o.total = o.blocked ? 0 : round2(o.freight + o.fee + o.surFee + buy);
    const factors = { 0.30: 0.7, 0.35: 0.65, 0.40: 0.6 };
    // 报价表与原计算器全部以人民币(RMB)计价。
    // fx > 0 时按用户填的汇率 (1 外币 = fx 元) 换算当地售价; fx = 0 则不换算。
    const fxRate = Number(inp.fx) || 0;
    o.fx = fxRate;
    for (const pct of [0.30, 0.35, 0.40]) {
      const sell = o.total / factors[pct] / extra;
      o.sells[pct] = round2(sell);
      o.locals[pct] = fxRate ? round2(sell / fxRate) : 0;
    }
    const customSell = o.total / (1 - margin) / extra;
    o.sells.custom = round2(customSell);
    o.locals.custom = fxRate ? round2(customSell / fxRate) : 0;
    // 不可发时「利润」没有意义。
    // 原表 U 列是 =L3-M8, 而 M8 在超尺寸时被置 0, 于是 U8 会算出「毛利 = 到账全额」
    // (例如到账 1500 时显示毛利 1500) —— 那是原表的缺陷, 照搬会误导。
    // 这里置 null, 前台/后台显示「不可发」而不是白赚一笔。
    if (o.blocked) {
      o.profit = null;
      o.profitRatio = null;
    } else {
      o.profit = round2(recv - o.total);
      o.profitRatio = recv ? round2(o.profit / recv) : 0;
    }
    return o;
  }

  // ---- 报价表尺寸限制 (逐国, 比原计算器更新) ----
  // q.lim 来自《渠道整合报价》的尺寸说明; 命中即判不可发。
  const rateLim = (preferRates && q.lim) ? q.lim : null;
  // 除数在下面才正式算, 这里先取一份用于附加费/体积判断
  const divEarly = (preferRates && q.countryDiv) ? q.countryDiv
                 : (rule && rule.type === 'normal' && rule.div) ? rule.div
                 : (q.mode === 'divider' && q.div) ? q.div
                 : (q.div || 6000);
  let rateLimited = false;
  if (rateLim) {
    const rl = checkRateLimit(rateLim, kg, L, W, H, divEarly, volKgOf(L, W, H, divEarly));
    if (rl.blocked) {
      out.blocked = true;
      out.overLimit = true;
      out.note = rl.reason;
      rateLimited = true;
    }
  }

  // ---- 附加费 (报价表规则, 计入定价成本) ----
  const surRes = (preferRates && q.sur) ? evalSurcharges(q.sur, kg, L, W, H, divEarly) : { fee: 0, list: [] };
  out.surFee = surRes.fee;
  out.surList = surRes.list;
  out.surManual = (q.sur || []).filter(s => s.manual);

  // ---- 定价规则: 先判超限 ----
  if (rule && !rateLimited) {
    if (overLimit(rule, L, W, H)) {
      out.overLimit = true;
      out.blocked = true;
      out.note = '超出最大尺寸, 不可发';
      return finalize(out);
    }
    // 多档尺寸: 任一组限制通过即可发 (云途美国 55/40/35 与 68/43/43)
    const groups = rule.limitGroups && rule.limitGroups.length
      ? rule.limitGroups : (rule.dims ? [rule.dims] : []);
    let anyPass = false, firstFail = null;
    for (const grp of groups) {
      const dd = checkDims(grp, L, W, H);
      if (dd.ok) { anyPass = true; break; }
      if (!firstFail) firstFail = dd;
    }
    const d = anyPass ? { ok: true, over: null } : (firstFail || { ok: true, over: null });
    if (!d.ok) {
      // 尺寸超了能不能发, 看原表 D 列 (运费公式) 有没有 "超限" 分支:
      //   有 overLimit (如云途美国 55/40/35 与 68/43/43 两档) -> 超了仍能发, 只是加收超尺寸费
      //   没有 (单一尺寸档) -> 完全不能发
      const hasHardLimit = !!(rule.overLimit);
      if (!hasHardLimit) {
        out.oversize = true;
        out.blocked = true;
        out.note = '超出尺寸限制, 不可发';
        return finalize(out);
      }
      out.oversize = true;
      out.note = '超出尺寸限制';
    }
    // 起收/最大重量: 报价表逐国说明 (countryMinKg) 优先, 否则用原表规则
    const minKg = (preferRates && q.countryMinKg != null) ? q.countryMinKg : rule.minKg;
    const w = checkWeight(minKg, rule.maxKg, kg);
    if (!w.ok) {
      // weightBlocks: 原表 G 列检查了实重超限 -> 计费重判"超尺寸" -> 不可发
      // 否则 (如递四方): G 列只看体积重, 实重超限时仍按体积重计费
      if (rule.weightBlocks) {
        out.blocked = true;
        out.note = w.reason + ', 不可发';
        return finalize(out);
      }
      out.note = w.reason + ' (按体积重计费)';
    }
  }

  // ---- 计费重 ----
  // 除数优先级:
  //   1) q.div   —— 报价表备注区的逐国体积重规则 (最准, 2026-10 报价)
  //   2) rule.div —— 《物流定价计算器》整理的渠道除数
  //   3) q.mode==='divider' 的专线除数 (÷6000/÷10000/÷18000 三条线)
  //   4) 6000 兜底
  let div;
  if (preferRates && q.countryDiv) div = q.countryDiv;   // 报价表逐国除数 (最新口径)
  else if (rule && rule.type === 'normal' && rule.div) div = rule.div;  // 原表渠道除数
  else if (q.mode === 'divider' && q.div) div = q.div;  // 专线三条线的除数
  else if (q.div) div = q.div;
  else div = 6000;
  const volKg = volumetricWeight(L, W, H, div);
  out.volKg = round2(volKg);
  out.divUsed = div;
  // 报价表没给这个国家的体积重除数 -> divUsed 只是估算值, 前台要显示「不确定」
  out.divUncertain = !!(preferRates && q.countryDivUncertain && !q.countryDiv);
  // 实重不在允许范围时, 原表 F 列返回 "超尺寸" 文本, Excel 的 MAX 会忽略文本,
  // 计费重只剩体积重。
  let effKg = kg;
  if (rule) {
    const minK2 = (preferRates && q.countryMinKg != null) ? q.countryMinKg : rule.minKg;
    const wchk = checkWeight(minK2, rule.maxKg, kg);
    if (!wchk.ok && !rule.weightBlocks) effKg = 0;
  }
  let chg = Math.max(effKg, volKg);
  out.chargeKg = round2(chg);

  // ---- 运费 ----
  let freight = 0, fee = 0;

  // 原计算器口径: 专线三条线各算一遍取 MIN (原表 D8 公式)。
  // 注意 preferRates: 报价表口径下**必须**走下面的通用费率库分支 ——
  // 报价表把专线拆成三条独立产品线(÷18000 / ÷10000 / ÷6000), 各自有自己的
  // 单价和挂号费档位; 如果这里还用 rule.lines, 就会拿原计算器的旧单价
  // (如美国Ⅱ号线 106/89/71) 覆盖掉报价表的当前价 (119/98/81)。
  if (rule && rule.type === 'triple' && rule.lines && !preferRates) {
    // 专线: 三条产品线各算各的 (泡货走泡货线, 重货走重货线)。
    // 组本身已经按产品线拆开 (q.line 指定), 所以按 q.line 选对应那条;
    // 若组没有指定线, 则三条取最便宜 (对齐原表 D 列的 MIN(...))。
    const wantLine = q.line && q.line !== '-' ? q.line : null;
    const cands = [];
    for (const ln of rule.lines) {
      if (ln.price == null) continue;
      if (wantLine && ln.name !== wantLine) continue;
      const vw = volumetricWeight(L, W, H, ln.div);
      const c = Math.max(kg, vw);
      cands.push({ name: ln.name, div: ln.div, cost: c * ln.price, charge: c });
    }
    if (cands.length) {
      const best = cands.reduce((a, b) => (b.cost < a.cost ? b : a));
      freight = best.cost;
      out.line = best.name;
      out.divUsed = best.div;
      out.chargeKg = round2(best.charge);
      fee = feeByBand(rule.feeBands, out.chargeKg);
      out.matched = true;
    }
  } else if (rule && rule.type === 'normal' && rule.price_normal != null && !preferRates) {
    // 定价规则自带普货/带电两套价 (仅当明确要求用规则价时)
    const price = attr === '带电' ? rule.price_battery : rule.price_normal;
    const f = attr === '带电' ? rule.fee_battery : rule.fee_normal;
    if (price != null) {
      freight = chg * price;
      fee = f || 0;
      out.matched = true;
    }
  } else {
    // 通用费率库
    if (q.mode === 'band') {
      const hits = lib.filter(t =>
        t.mode === 'band' && t.lo <= chg + EPS && t.hi >= chg - EPS);
      if (hits.length) {
        out.matched = true;
        freight = hits.reduce((s, t) => s + (t.price || 0), 0) * chg;
        fee = hits.reduce((s, t) => s + (t.fee || 0), 0);
      }
    } else if (q.mode === 'firstnext') {
      const hits = lib.filter(t =>
        t.mode === 'firstnext' && t.lo <= chg + EPS && t.hi >= chg - EPS);
      if (hits.length) {
        out.matched = true;
        const t = hits[0];
        const fkg = t.first_kg || 0;
        const nkg = t.next_kg || 0;
        let units = Math.max(0, chg - fkg);
        if (nkg > 0) units = Math.ceil(round9(units / nkg));
        freight = (t.price || 0) + (t.nextkg || 0) * units;
        fee = hits.reduce((s, x) => s + (x.fee || 0), 0);
      }
    } else { // divider
      const hits = lib.filter(t =>
        t.mode === 'divider' && t.lo <= chg + EPS && t.hi >= chg - EPS);
      if (hits.length) {
        out.matched = true;
        freight = hits.reduce((s, t) => s + (t.price || 0), 0) * chg;
        fee = hits.reduce((s, t) => s + (t.fee || 0), 0);
      }
    }
  }

  // ---- 超尺寸加收 ----
  if (rule) freight += oversizeFee(rule, L, W, H);

  // 没有命中任何重量段 (超重 / 超档) -> 明确标注, 不要静默按 0 算
  if (!out.matched && !out.blocked) {
    out.blocked = true;
    out.note = (lib && lib.length)
      ? `计费重 ${round2(Math.max(kg, volKgOf(L, W, H, divEarly)))}kg 超出该渠道重量段`
      : '该渠道在此线路没有报价';
  }

  out.freight = out.blocked ? 0 : freight;
  out.fee = out.blocked ? 0 : fee;
  // 产品线名: 原表口径的三线分支会自己设 out.line; 报价表口径走通用费率库分支,
  // 不会设 —— 这里回填渠道组自己的 line (专线三线是 ÷18000 / ÷10000 / ÷6000 三条
  // 独立产品线, 前台要显示出来)。普通渠道 line 为 '-', 前台本来就不显示。
  if (!out.line) out.line = q.line || '';
  return finalize(out);
}

/**
 * 规则查找键。
 * 合并脚本已经把每个渠道组对应到《物流定价计算器》的规则, 存在 g.ruleKey,
 * 直接用它; 没有 ruleKey 的组 (原表未覆盖的渠道) 不套用规则。
 */
function ruleKey(g) {
  if (g.ruleKey) return g.ruleKey;
  return (g.channel || g.sheet) + '|' + g.country + '|' + (g.zone || '');
}

/** 计算所有渠道组, 并标注最低价 */
function quoteAll(groups, lib, inp, ruleMap, preferRates) {
  const byKey = new Map();
  for (const t of lib) {
    const k = t.sheet + '|' + t.country + '|' + t.zone + '|' + t.line + '|' + (t.attr || '');
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  // 属性匹配: 带电组只服务带电, 普货组只服务普货, 空属性 = 通用 (两种都接)
  const attrOk = (a) => !a || !inp.attr || a === inp.attr;
  const rows = [];
  for (const g of groups) {
    if (!attrOk(g.attr)) continue;
    const k = g.sheet + '|' + g.country + '|' + g.zone + '|' + g.line + '|' + (g.attr || '');
    let tiers = byKey.get(k) || [];
    if (!tiers.length && (g.attr || '')) {
      // 该组标记了属性但费率档没带 attr 字段 -> 回退查无 attr 的档
      tiers = byKey.get(g.sheet + '|' + g.country + '|' + g.zone + '|' + g.line + '|') || [];
    }
    const rule = ruleMap ? ruleMap.get(ruleKey(g)) : null;
    const r = quote(g, tiers, inp, rule, preferRates);
    rows.push(Object.assign({}, g, r));
  }
  const valid = rows.filter(r => r.matched && !r.overLimit && r.total > 0);
  let best = null;
  for (const r of valid) if (!best || r.total < best.total) best = r;
  for (const r of rows) r.isBest = !!(best && r === best);
  return { rows: rows, best: best };
}

const API = {
  dedupeBands, volumetricWeight, chargeableWeight, quote, quoteAll, round2,
  checkDims, checkWeight, feeByBand, ruleKey, oversizeFee, overLimit
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
} else {
  window.calc = API;
}
