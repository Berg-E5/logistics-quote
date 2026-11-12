"""
专门抽取「专线类」sheet (欧盟P线/欧盟D线/英国专线/德国专线/美国Ⅱ号线)。

这类的结构与其它渠道不同:
  表头一行: 国家地区 | 重量段 | 挂号费/票 | 体积/6000(重货实惠) | 体积/10000(泡货实惠)
             | 体积/18000(大泡货实惠) | 尺寸限制 | 特征
  三个体积列是**三条并列的产品线**(渠道代码不同), 不是同一产品的三档价:
    体积/6000  重货实惠    (渠道代码 UKDPD / EUP6  等)
    体积/10000 泡货实惠    (渠道代码 UKDP  / EUP10 等)
    体积/18000 大泡货实惠  (渠道代码 UKD   / EUP18 等)
  重量段列可空 (欧盟P/D线整表 0.1-30KG); 单价与挂号费在重量段首行给出, 后续行留空 -> 继承。
  欧盟P线/D线还是左右分栏 (左块 A-E, 右块 G-K)。

输出: 每个 (渠道, 国家, 产品线) 一组, 组内按重量段分档。
"""
import re, json
import os
import openpyxl

SRC = r"C:/Users/Administrator/AppData/Local/hermes/attachments/广州市盛途科技渠道整合报价-2026-10-26-2.xlsx"
# ---- 数据源: 由 更新报价.py 写入 源文件路径.txt ----
_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "源文件路径.txt")
if os.path.exists(_CFG):
    SRC = open(_CFG, encoding="utf-8").read().strip()

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "divider_rates.json")

# 专线渠道 -> (体积除数, 产品线名)
DIV_LINES = {
    6000: ("重货实惠", "6"),
    10000: ("泡货实惠", "10"),
    18000: ("大泡货实惠", "18"),
}


def parse_band(s):
    if s is None:
        return None
    t = str(s).strip().replace("KG", "").replace("kg", "").replace("K", "")
    t = t.replace("＜", "<").replace("＞", ">").replace("≤", "<=").replace("≥", ">=")
    t = re.sub(r"[Ww]", "", t).replace(" ", "")
    m = re.match(r"^(\d*\.?\d*)\s*-\s*(\d*\.?\d*)$", t)
    if m:
        lo = float(m.group(1)) if m.group(1) else 0.0
        hi = float(m.group(2)) if m.group(2) else 999.0
        return (lo, hi)
    m = re.match(r"^(\d*\.?\d*)\s*<=?\s*.*?\s*<=?\s*(\d*\.?\d*)$", t)
    if m:
        lo = float(m.group(1)) if m.group(1) else 0.0
        hi = float(m.group(2)) if m.group(2) else 999.0
        return (lo, hi)
    return None


def num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"-?\d+(?:\.\d+)?", str(v).replace(",", ""))
    if m:
        try:
            return float(m.group(0))
        except ValueError:
            return None
    return None


def txt(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def build_grid(ws):
    grid, anchor = {}, {}
    for rng in ws.merged_cells.ranges:
        tl = ws.cell(row=rng.min_row, column=rng.min_col).value
        for r in range(rng.min_row, rng.max_row + 1):
            for c in range(rng.min_col, rng.max_col + 1):
                anchor[(r, c)] = tl
    for r in range(1, min(ws.max_row, 200) + 1):
        for c in range(1, min(ws.max_column, 30) + 1):
            v = ws.cell(row=r, column=c).value
            if v is None:
                v = anchor.get((r, c))
            if v is not None:
                grid[(r, c)] = v
    return grid


def find_header_row(g, maxr, maxc):
    """找含 '体积/6000' 的那一行作为表头。"""
    for r in range(1, maxr + 1):
        for c in range(1, maxc + 1):
            v = g.get((r, c))
            if v and "体积/6000" in str(v).replace("\n", " "):
                return r
    return None


def parse_header(cells):
    """返回 {语义: [列号,...]}。同一表头行里可能有两组 (左右分栏)。"""
    cols = {}
    divs = {6000: [], 10000: [], 18000: []}
    countries = []
    bands = []
    for c, v in sorted(cells.items()):
        flat = str(v).replace("\n", " ").replace("\r", " ")
        hit = False
        for div in (6000, 10000, 18000):
            if re.search(rf"体积\s*/\s*{div}", flat):
                divs[div].append(c)
                hit = True
                break
        if hit:
            continue
        if "挂号费" in flat:
            cols.setdefault("fee", []).append(c)
        elif "重量段" in flat:
            # "国家地区/重量段"(合并) 与纯 "重量段" 列要分开
            if "国家" in flat or "地区" in flat:
                countries.append(c)
            else:
                bands.append(c)
        elif ("国家" in flat or "地区" in flat) and "尺寸" not in flat:
            countries.append(c)
        elif "尺寸" in flat:
            cols.setdefault("limits", []).append(c)
        elif "特征" in flat or "备注" in flat:
            cols.setdefault("note", []).append(c)
    cols["country"] = countries
    cols["band"] = bands
    for d in (6000, 10000, 18000):
        cols[f"div{d}"] = divs[d]
    return cols


def split_blocks(cols, maxc):
    """左右分栏: 按 country 列切成块, 每块内取本块自己的 fee/band/div 列。"""
    ccs = sorted(cols.get("country", []))
    if not ccs:
        return []
    blocks = []
    for i, c0 in enumerate(ccs):
        end = ccs[i + 1] if i + 1 < len(ccs) else maxc + 1
        blk = {"country": c0}

        def pick_in_range(key):
            for c in cols.get(key, []):
                if c0 <= c < end:
                    return c
            return None

        blk["fee"] = pick_in_range("fee")
        blk["band"] = pick_in_range("band")
        blk["limits"] = pick_in_range("limits")
        blk["note"] = pick_in_range("note")
        for d in (6000, 10000, 18000):
            blk[f"div{d}"] = pick_in_range(f"div{d}")
        blocks.append(blk)
    return blocks


def extract_sheet(ws):
    g = build_grid(ws)
    maxr = min(ws.max_row, 200)
    maxc = min(ws.max_column, 30)
    hr = find_header_row(g, maxr, maxc)
    if not hr:
        return []

    cells = {c: g[(hr, c)] for c in range(1, maxc + 1) if (hr, c) in g}
    cols = parse_header(cells)
    blocks = split_blocks(cols, maxc)

    # 每个块: 国家列 + 重量段列 + 挂号费列 + 三个体积列
    out = []
    for blk in blocks:
        cc = blk.get("country")
        if cc is None:
            continue
        bc = blk.get("band")
        fc = blk.get("fee")
        dcs = {d: blk.get(f"div{d}") for d in (6000, 10000, 18000)}
        if not any(dcs.values()):
            continue

        cur_cn = None
        last_fee = None
        last_price = {6000: None, 10000: None, 18000: None}
        last_band = None
        stop = False

        for r in range(hr + 1, maxr + 1):
            row = {c: g.get((r, c)) for c in range(1, maxc + 1)}
            if not any(v is not None for v in row.values()):
                continue
            cn = txt(row.get(cc))
            # 条款区: 国家列出现说明文字
            if cn and len(cn) > 12:
                break
            # 重量段列是说明文字 -> 条款区
            bt = txt(row.get(bc)) if bc else None
            if bt and parse_band(bt) is None and len(bt) > 10:
                break
            # 整行出现 "备注/基本事项" 之类 -> 条款区
            alltxt = " ".join(str(v) for v in row.values() if v is not None)
            if re.search(r"(备注[:：]|基本事项|注意事项|赔偿|禁运|海关要求|目的地派送)", alltxt) and cn is None:
                break

            band = parse_band(bt) if bt else None
            if band is None and last_band is not None:
                band = last_band
            fee = num(row.get(fc)) if fc else None
            if fee is not None:
                last_fee = fee
            prices = {}
            got_any = False
            for d, dc in dcs.items():
                p = num(row.get(dc)) if dc else None
                if p is not None:
                    last_price[d] = p
                    got_any = True
                prices[d] = last_price[d]
            if not got_any and fee is None:
                continue

            if cn:
                cur_cn = cn
            if band is not None:
                last_band = band
            if not cur_cn:
                continue

            for d, p in prices.items():
                if p is None:
                    continue
                line_name, suffix = DIV_LINES[d]
                lo, hi = band if band else (0.0, 999.0)
                out.append(dict(
                    sheet=ws.title.strip(), country=cur_cn,
                    line=f"{line_name}(÷{d})", div=d, lo=lo, hi=hi,
                    price=p, fee=last_fee,
                    limits=txt(row.get(blk.get("limits"))) if blk.get("limits") else None,
                ))
    return out


def main():
    wb = openpyxl.load_workbook(SRC, data_only=False)
    sheets = ["欧盟P线", "欧盟D线", "英国专线", "德国专线", "美国Ⅱ号线"]
    allr = []
    for name in sheets:
        if name not in wb.sheetnames:
            print(f"  (无此 sheet) {name}")
            continue
        r = extract_sheet(wb[name])
        countries = sorted({x["country"] for x in r})
        print(f"  {name:10s} 档={len(r):4d}  国家={len(countries):3d}  产品线={sorted({x['line'] for x in r})}")
        allr.extend(r)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(allr, f, ensure_ascii=False, indent=1)
    print("written", OUT, "total", len(allr))
    # 抽样
    for x in allr[:6]:
        print("   ", x)


if __name__ == "__main__":
    main()
