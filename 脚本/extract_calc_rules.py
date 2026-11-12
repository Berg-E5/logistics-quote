"""
从《物流定价计算器.xlsx》抽取完整规则, 转成网站用的 JSON。

原表每个国家一列, 列的含义:
  B 国家/项目   C 尺寸限制(文字)   D 运费(公式)
  E 体积重(公式) F 实重(公式)     G 计费重(公式)
  H 普货单价   I 普货挂号费
  J 带电单价   K 带电挂号费
  L 汇率       M 定价成本CNY      N/O/P 30%/35%/40% 售价
  Q 币种       R/S/T 当地售价     U 毛利额   V 利润比

专线 (杰航) 结构不同:
  E/F/G 分别是 ÷6000/÷10000/÷18000 的体积重
  J/K/L 分别是三条线的单价   M/N... 挂号费按重量段

本脚本把每个国家拆成一条结构化规则:
  { channel, section, country, zone, dims:{...}, minKg, maxKg,
    div, price:{normal,battery}, fee:{normal,battery}, fx, currency,
    oversizeFee, limits }
其中 dims 是把原表 E 列公式解析出来的尺寸条件数组。
"""
import os
import json
import os, re, os
import openpyxl

SRC = r"D:/Desktop/物流定价计算器.xlsx"

# ---- 数据源: 由 更新报价.py 写入 源文件路径.txt ----
_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "原表路径.txt")
if os.path.exists(_CFG):
    SRC = open(_CFG, encoding="utf-8").read().strip()
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "calc_rules.json")

wb = openpyxl.load_workbook(SRC, data_only=False)

# 尺寸条件解析: 从 E 列公式里抠出 AND(...) 里的比较
def parse_dims(formula):
    """从 E 列公式解析出尺寸条件。

    原表有两种形态:
      OR(...):  一刀切, 任一条件命中就超尺寸 (YDH: IF(OR(E3>61,...),"超尺寸",...))
      AND(...): 多档尺寸, 从小到大排列 (云途美国:
                IF(AND(<=55,<=40,<=35),体积重,IF(AND(<=68,<=43,<=43),体积重,"超尺寸")))

    语义统一成 "限制组" (limitGroups): 每组是一组必须同时满足的条件;
    任一组通过即尺寸可发 (多档), 全部不通过才超尺寸 (单档时等价于 OR)。

    返回 [{var, op, val, ...}, ...]  —— 单组时直接是 dims, 多组时用 groups 字段
    """
    if not formula:
        return []
    dims = []
    f = formula
    strict = bool(re.search(r"IF\(\s*OR\(", f))
    inner = extract_cond_block(f)
    if not inner:
        return dims
    # 逗号分隔的条件, 但 E3+(F3+G3)<=160 这种带括号要小心
    # 嵌套 IF 里的算式条件 (如 IF(体积/8000>5,"超尺寸",...))
    nested = re.findall(r"IF\(\s*([A-Z]3\*?[A-Z]3[^,\)]{0,24}?\s*(?:<=|>=|<|>)\s*\d+(?:\.\d+)?)\s*,", f)
    for nd in nested:
        m8 = re.match(r"E3\*F3\*G3/(\d+)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", nd.strip())
        if m8:
            dims.append(dict(var="volMax", op=m8.group(2), val=float(m8.group(3)),
                             div=int(m8.group(1))))

    for part in split_and(inner):
        part = part.strip()
        # E3<=55  /  F3<=40  /  G3<=35
        m2 = re.match(r"([EFG])3\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", part)
        if m2:
            var, op, val = m2.group(1), m2.group(2), float(m2.group(3))
            dims.append(dict(var=var, op=op, val=val))
            continue
        # E3+(F3+G3)*2<=300  围长 (先匹配带 *2 的)
        m4 = re.match(r"E3\+\(F3\+G3\)\*2\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", part)
        if m4:
            dims.append(dict(var="girth", op=m4.group(1), val=float(m4.group(2))))
            continue
        # E3+(F3+G3)<=160  三边和
        m3 = re.match(r"E3\+\(F3\+G3\)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", part)
        if m3:
            dims.append(dict(var="sum", op=m3.group(1), val=float(m3.group(2))))
            continue
        m5 = re.match(r"\(E3\+F3\+G3\)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", part)
        if m5:
            dims.append(dict(var="sum", op=m5.group(1), val=float(m5.group(2))))
            continue
        m6 = re.match(r"\(E3\+\(F3\+G3\)\*2\)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", part)
        if m6:
            dims.append(dict(var="girth", op=m6.group(1), val=float(m6.group(2))))
            continue
        # E3+F3+G3<=150
        m7 = re.match(r"E3\+F3\+G3\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", part)
        if m7:
            dims.append(dict(var="sum", op=m7.group(1), val=float(m7.group(2))))
            continue
        # E3*F3*G3/8000>5  -> 体积重上限 (除数从公式里取)
        m8 = re.match(r"E3\*F3\*G3/(\d+)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", part)
        if m8:
            dims.append(dict(var="volMax", op=m8.group(2), val=float(m8.group(3)),
                             div=int(m8.group(1))))
            continue
    # 语义归一: dims 里存的是"限制"(actual op val 必须成立才通过)。
    # 原公式里的 "E3>61" 是"超限条件", 等价于限制 "E3<=61"。
    for d in dims:
        d["strict"] = strict
        if d["op"] == ">":
            d["op"] = "<="
        elif d["op"] == ">=":
            d["op"] = ">="

    # 多档尺寸: 收集公式里所有 AND(...) 块, 按出现顺序 (从小到大)。
    # 第一组是主限制, 后面的是放宽档。
    groups = []
    for m in re.finditer(r"AND\(", f):
        start = m.end()
        depth = 1
        k = start
        while k < len(f) and depth:
            if f[k] == "(":
                depth += 1
            elif f[k] == ")":
                depth -= 1
            k += 1
        content = f[start:k - 1]
        grp = []
        for part in split_and(content):
            part = part.strip()
            for pat, var in (
                (r"([EFG])3\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", None),
                (r"E3\+\(F3\+G3\)\*2\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", "girth"),
                (r"E3\+\(F3\+G3\)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", "sum"),
                (r"\(E3\+F3\+G3\)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", "sum"),
                (r"E3\+F3\+G3\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)", "sum"),
            ):
                mm = re.match(pat, part)
                if not mm:
                    continue
                if var is None:
                    op, val = mm.group(2), float(mm.group(3))
                    v = mm.group(1)
                else:
                    op, val = mm.group(1), float(mm.group(2))
                    v = var
                if op == ">":
                    op = "<="
                grp.append(dict(var=v, op=op, val=val, strict=strict))
                break
        if grp:
            groups.append(grp)
    if len(groups) > 1:
        dims = groups[0]
        return dict(groups=groups, strict=strict)

    return dims


def extract_cond_block(f):
    """从公式里取出尺寸条件块的内容。

    可能是 AND(...) 或单个 (条件) 或裸条件:
      =IFERROR(IF(AND(E3<=55,F3<=40,G3<=35),J3/8000,...),...)
      =IFERROR(IF((E3+(F3+G3)*2<=250),J3/8000,...),...)
    要做括号配对, 不能用 [^)]* (会被 E3+(F3+G3) 里的括号截断)。
    """
    # 取**第一个** IF( 后的条件块 —— 不能先找 AND(, 因为
    # IF(OR(a,b),"超尺寸",IF(AND(c,d,e),...)) 里 AND 在后面, 先找 AND 会取错分支。
    i = f.find("IF(")
    if i < 0:
        return None
    j = i + len("IF(")
    rest = f[j:]
    if rest.startswith("AND("):
        j += len("AND(")
        depth = 1
        start = j
        while j < len(f) and depth:
            if f[j] == "(":
                depth += 1
            elif f[j] == ")":
                depth -= 1
            j += 1
        return f[start:j - 1]
    # IF( 之后可能是 OR(...) 或 (条件) 或裸条件
    if True:
        if j < len(f) and f[j] == "(":
            j = j
            depth = 1
            start = j + 1
            j += 1
            while j < len(f) and depth:
                if f[j] == "(":
                    depth += 1
                elif f[j] == ")":
                    depth -= 1
                j += 1
            return f[start:j - 1]
        # OR(...)
        if f.startswith("OR(", j):
            depth = 1
            start = j + len("OR(")
            k = start
            while k < len(f) and depth:
                if f[k] == "(":
                    depth += 1
                elif f[k] == ")":
                    depth -= 1
                k += 1
            return f[start:k - 1]
        # 裸条件: 取到逗号或右括号
        start = j
        depth = 0
        while j < len(f):
            if f[j] == "(":
                depth += 1
            elif f[j] == ")":
                if depth == 0:
                    break
                depth -= 1
            elif f[j] == "," and depth == 0:
                break
            j += 1
        return f[start:j]
    return None


def split_and(s):
    """按顶层逗号切分 (忽略括号内逗号)。"""
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur); cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur)
    return out


def parse_weight(formula):
    """从 '=IFERROR(IF(AND(H3>0.1,H3<=30),H3,"超尺寸"),"")' 解析重量上下限。"""
    if not formula:
        return None, None
    lo = re.search(r"H3\s*>\s*(\d+(?:\.\d+)?)", formula)
    hi = re.search(r"H3\s*<=\s*(\d+(?:\.\d+)?)", formula)
    return (float(lo.group(1)) if lo else None,
            float(hi.group(1)) if hi else None)


def parse_div(formula):
    """体积重除数: 'J3/8000' -> 8000"""
    if not formula:
        return None
    m = re.search(r"/\s*(\d{3,6})", formula)
    return int(m.group(1)) if m else None


def fnum(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except (ValueError, TypeError):
        return None


def cell(ws, coord):
    v = ws[coord].value
    return v


# ---- 表结构定义: sheet -> [(小节名, 起始行, 结束行, 国家列, 类型)] ----
SECTIONS = {
    "云途": [
        ("云途小包", 8, 25, "B", "normal"),
        ("云途大货", 32, 41, "B", "normal"),
    ],
    "杰航": [
        ("欧盟P线", 8, 16, "B", "triple"),
        ("欧盟D线", 21, 28, "B", "triple"),
        ("英国专线", 33, 33, "B", "triple"),
        ("德国专线", 38, 38, "B", "triple"),
        ("美国专线", 43, 43, "B", "triple"),
    ],
    "YDH义速宝": [
        ("YDH", 8, 29, "B", "normal"),
    ],
    "三态": [
        ("三态重货", 8, 22, "B", "normal"),
        ("三态大货", 32, 41, "B", "normal"),
    ],
    "递四方": [
        ("递四方", 8, 29, "B", "normal"),
    ],
}


KNOWN_COUNTRIES = {
    "美国", "加拿大", "墨西哥", "澳大利亚", "英国", "法国", "德国", "意大利",
    "西班牙", "荷兰", "比利时", "瑞典", "波兰", "爱尔兰", "阿联酋", "沙特",
    "俄罗斯", "日本", "韩国", "新加坡", "马来西亚", "泰国", "越南", "菲律宾",
    "印度", "巴西", "智利", "南非", "新西兰", "以色列", "阿曼", "科威特",
    "卡塔尔", "巴林", "约旦", "印度尼西亚", "白俄罗斯", "乌克兰", "捷克",
    "匈牙利", "奥地利", "葡萄牙", "斯洛伐克", "斯洛文尼亚", "立陶宛",
    "拉脱维亚", "爱沙尼亚", "罗马尼亚", "保加利亚", "希腊", "克罗地亚",
    "丹麦", "芬兰", "冰岛", "爱尔兰", "中国", "中国香港", "中国台湾",
}


def build_normal(ws, r, country_col):
    """普通结构 (云途/三态/YDH/递四方)。"""
    cn = cell(ws, f"{country_col}{r}")
    cn = str(cn).strip() if cn else ""
    raw_c = cell(ws, f"C{r}")
    raw_c = str(raw_c).strip() if raw_c else ""
    ZONE_WORDS = ("一区", "二区", "三区", "四区", "五区", "六区")
    # 国家名空但有分区 (澳大利亚二~四区) -> 有效行, 国家名留空待继承
    if not cn and raw_c not in ZONE_WORDS:
        return None
    cn = str(cn).strip()
    # B 列可能把国家名和尺寸限制写在一起: "澳大利亚59x49x39L+H+W≤147cm,最长边≤105cm"
    # 剥离后面的尺寸文字, 只留国家名
    if cn:
        cn = re.split(r"[\d]", cn)[0].strip() or cn
        # 国家名必须在白名单里 (排除表头行/备注行被误当国家)
        if cn not in KNOWN_COUNTRIES:
            return None
    # C 列可能是分区名 (一区/二区...), 也可能是尺寸限制文字
    zone = raw_c if raw_c in ZONE_WORDS else ""
    limits = "" if zone else raw_c
    # 若国家名里带了尺寸文字, 并入 limits
    b_raw = str(cell(ws, f"{country_col}{r}") or "").strip()
    b_tail = b_raw[len(cn):].strip() if b_raw.startswith(cn) else ""
    if b_tail and not zone:
        limits = (b_tail + ("\n" + limits if limits else "")).strip()
    elif b_tail and zone:
        limits = b_tail
    e_formula = cell(ws, f"E{r}") or ""
    # G 列 (计费重) 决定实重超限是否阻断:
    #   IF(OR(E="超尺寸",F="超尺寸"),...)  -> 实重超限 => 不可发 (云途/三态/YDH)
    #   IF(OR(E="超尺寸"),...)           -> 只看体积重, 实重超限仍按体积重算 (递四方)
    g_formula = cell(ws, f"G{r}") or ""
    weight_blocks = bool(re.search(r'F\d*="超尺寸"', g_formula))
    dims_raw = parse_dims(e_formula)
    if isinstance(dims_raw, dict):
        limit_groups = dims_raw["groups"]
        dims = limit_groups[0]
    else:
        dims = dims_raw
        limit_groups = [dims_raw] if dims_raw else []
    minKg, maxKg = parse_weight(cell(ws, f"F{r}"))
    div = parse_div(e_formula)
    # 可信度: 公式必须引用输入行 E3/F3/G3/H3。若引用了其它行 (如 E10),
    # 说明原表是复制粘贴错误, 该行的尺寸规则不可信。
    bad_refs = re.findall(r"[EFGH](\d+)", e_formula)
    trusted = all(int(b) in (3,) for b in bad_refs) if bad_refs else True
    # 重量公式同样检查
    f_formula = cell(ws, f"F{r}") or ""
    if not trusted:
        bad_refs2 = re.findall(r"H(\d+)", f_formula)
        trusted = all(int(b) == 3 for b in bad_refs2) if bad_refs2 else trusted

    # 超尺寸加收: D 列公式里的 IF(OR(E3>55,F3>40,G3>35),150,0)
    d_formula = cell(ws, f"D{r}") or ""
    over_fee = None
    mo = re.search(r"IF\(OR\(E3>(\d+),F3>(\d+),G3>(\d+)\),(\d+),0\)", d_formula)
    if mo:
        over_fee = dict(l=float(mo.group(1)), w=float(mo.group(2)),
                        h=float(mo.group(3)), fee=float(mo.group(4)))

    # 超限 (完全不能发)
    over_limit = None
    ml = re.search(r"IF\(OR\(E3>(\d+),F3>(\d+),G3>(\d+)\),\"超限\"", d_formula)
    if ml:
        over_limit = dict(l=float(ml.group(1)), w=float(ml.group(2)), h=float(ml.group(3)))

    return dict(
        country=cn, zone=zone,
        limits=(str(limits) if limits else ""),
        dims=dims, minKg=minKg, maxKg=maxKg, div=div,
        price_normal=fnum(cell(ws, f"H{r}")),
        fee_normal=fnum(cell(ws, f"I{r}")),
        price_battery=fnum(cell(ws, f"J{r}")),
        fee_battery=fnum(cell(ws, f"K{r}")),
        fx=fnum(cell(ws, f"L{r}")),
        currency=(cell(ws, f"Q{r}") or ""),
        oversizeFee=over_fee, overLimit=over_limit,
        type="normal", trusted=trusted, weightBlocks=weight_blocks,
        limitGroups=limit_groups,
    )


def find_fx(ws, r):
    """找 "汇率" 标签所在列, 取该列本行的值。"""
    for hr in range(r - 1, max(0, r - 16), -1):
        for col in "MNOPQRSTUVW":
            hdr = cell(ws, f"{col}{hr}")
            if isinstance(hdr, str) and "汇率" in hdr:
                v = fnum(cell(ws, f"{col}{r}"))
                if v is not None:
                    return v
    return None


def build_triple(ws, r, country_col):
    """专线结构 (杰航): E/F/G 三个除数的体积重, J/K/L 三条线单价。"""
    cn = cell(ws, f"{country_col}{r}")
    cn = str(cn).strip() if cn else ""
    raw_c = cell(ws, f"C{r}")
    raw_c = str(raw_c).strip() if raw_c else ""
    ZONE_WORDS = ("一区", "二区", "三区", "四区", "五区", "六区")
    # 国家名空但有分区 (澳大利亚二~四区) -> 有效行, 国家名留空待继承
    if not cn and raw_c not in ZONE_WORDS:
        return None
    cn = str(cn).strip()

    limits = cell(ws, f"C{r}")
    dims = parse_dims(cell(ws, f"E{r}"))
    minKg, maxKg = parse_weight(cell(ws, f"H{r}"))

    # 挂号费有两种形式:
    #   a) 表头写 "挂号费" -> 单值 (欧盟P线/D线, M 列)
    #   b) 表头写 "3.1-20kg" -> 分重量段 (英国/德国/美国专线, M/N/O/P 列)
    bands = []
    for hr in range(r - 1, max(0, r - 16), -1):
        found = False
        is_hdr = False
        for col in "MNOPQRSTUVW":
            hdr = cell(ws, f"{col}{hr}")
            if not isinstance(hdr, str):
                continue
            h = hdr.strip()
            if "kg" in h.lower() and "-" in h:
                is_hdr = True
                val = fnum(cell(ws, f"{col}{r}"))
                if val is not None:
                    bands.append(dict(label=h, fee=val))
                    found = True
            elif "挂号费" in h:
                is_hdr = True
                val = fnum(cell(ws, f"{col}{r}"))
                if val is not None:
                    bands.append(dict(label="全部", fee=val))
                    found = True
        if is_hdr:
            break

    return dict(
        country=cn, zone="",
        limits=(str(limits) if limits else ""),
        dims=dims, minKg=minKg, maxKg=maxKg,
        div=parse_div(cell(ws, f"E{r}")),
        lines=[
            dict(name="重货实惠(÷6000)", div=6000, price=fnum(cell(ws, f"J{r}"))),
            dict(name="泡货实惠(÷10000)", div=10000, price=fnum(cell(ws, f"K{r}"))),
            dict(name="大泡货实惠(÷18000)", div=18000, price=fnum(cell(ws, f"L{r}"))),
        ],
        feeBands=bands,
        fx=find_fx(ws, r),
        currency="",
        oversizeFee=None, overLimit=None,
        type="triple",
    )


def main():
    rules = []
    for sheet, secs in SECTIONS.items():
        ws = wb[sheet]
        for sec_name, r0, r1, ccol, kind in secs:
            for r in range(r0, r1 + 1):
                if kind == "normal":
                    rec = build_normal(ws, r, ccol)
                else:
                    rec = build_triple(ws, r, ccol)
                if not rec:
                    continue
                rec["channel"] = sheet
                rec["section"] = sec_name
                # 三态大货 section 名字要改
                if sheet == "三态" and sec_name == "三态重货":
                    rec["section"] = "三态重货"
                rules.append(rec)

    # 继承国家名 (分区行 B 列为空时, 用上面的国家名)
    out = []
    last_country = ""
    last_section = ""
    last_section = ""
    for rec in rules:
        # 换 section 时重置继承 (每个 section 的国家名单独立)
        if rec["section"] != last_section:
            last_country = ""
            last_section = rec["section"]
        if rec["country"]:
            last_country = rec["country"]
        else:
            rec["country"] = last_country
        rec["country"] = rec["country"] or ""
        out.append(rec)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"规则 {len(out)} 条  -> {OUT}")
    from collections import Counter
    for k, v in Counter((r["channel"], r["section"]) for r in out).items():
        print(f"  {k[0]:8s} {k[1]:10s} {v:3d} 条")


if __name__ == "__main__":
    main()
