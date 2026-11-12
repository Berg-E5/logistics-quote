"""
报价表费率抽取器 v3 —— 逐行自适应。

不再依赖单一"表头行"假设。对每一行, 先判断这行是不是表头(靠关键字),
再按该行/该 sheet 已知的列义解析数据行。这样能同时吃下:
  · 表头在第 2/3/4 行的各种版式
  · 左右分栏 (欧盟P线: A-E 左块 + G-K 右块)
  · 一张 sheet 里混了两种表头 (三态免泡大货)
  · 首重/续重 计费 (金马/美森)
  · 按体积除数 6000/10000/18000 的专线
"""
import sys, json, re, datetime
import os
import openpyxl

SRC = r"C:/Users/Administrator/AppData/Local/hermes/attachments/广州市盛途科技渠道整合报价-2026-10-26-2.xlsx"
# ---- 数据源: 由 更新报价.py 写入 源文件路径.txt ----
_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "源文件路径.txt")
if os.path.exists(_CFG):
    SRC = open(_CFG, encoding="utf-8").read().strip()

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rates_raw.json")

SKIP_SHEETS = {"总目录", "金马理赔条款说明", "日本偏远", "发货实拍", "美国邮编"}

CLAUSE_KW = ("备注", "客户须知", "基本事项", "产品附加费", "尺寸计重", "货物责任",
             "温馨提示", "参考时效", "计费方式", "计重规则", "出货要求", "包装尺寸",
             "走货属性", "申报价值", "禁运", "赔偿", "不可抗力", "特别说明", "海关要求",
             "参展货物", "高价值", "理赔", "税", "VAT", "时效说明", "规则变更")


def parse_band(s):
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    t = t.replace("KG", "").replace("kg", "").replace("K", "")
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
    if isinstance(v, datetime.datetime):
        return v.strftime("%Y-%m-%d")
    # Excel 日期序列号 (1900 基准) -> 日期
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        iv = int(v)
        if 20000 <= iv <= 60000:
            try:
                return (datetime.date(1899, 12, 30) + datetime.timedelta(days=iv)).strftime("%Y-%m-%d")
            except (OverflowError, ValueError):
                pass
        return str(v)
    s = str(v).strip()
    return s or None


def is_clause(s):
    if not s:
        return False
    s = str(s)
    if len(s) > 120:
        return True
    for kw in CLAUSE_KW:
        if s.startswith(kw):
            return True
    if s.startswith(("一、", "二、", "三、", "四、", "五、", "六、", "七、",
                    "1：", "2：", "3：", "4：", "5：", "6：", "7：", "8：", "9：")):
        return True
    return False


def build_grid(ws):
    grid, anchor = {}, {}
    for rng in ws.merged_cells.ranges:
        tl = ws.cell(row=rng.min_row, column=rng.min_col).value
        for r in range(rng.min_row, rng.max_row + 1):
            for c in range(rng.min_col, rng.max_col + 1):
                anchor[(r, c)] = tl
    for r in range(1, min(ws.max_row, 700) + 1):
        for c in range(1, min(ws.max_column, 60) + 1):
            v = ws.cell(row=r, column=c).value
            if v is None:
                v = anchor.get((r, c))
            if v is not None:
                grid[(r, c)] = v
    return grid


# ---- 无表头行的小表: 手工指定列位 ----
# (sheet, 表头行, 国家列, 重量段列, 运费列, 挂号/续重列, 附加信息列)
MANUAL_SHEETS = {
    # 金马美国中包: A=国家 B=挂号费(73) C=0.5KG首重价(14.5) D=备注 E=时效
    # 首重0.5KG收14.5, 续重0.5KG同价 (条款 r6: 计费重量不足0.5KG按0.5KG计)
    "金马美国中包专线6KG+": dict(hdr=3, country=1, band=None, price=None, fee=2,
                                lead=5, note=4, minchg=None,
                                first=3, nextkg=3,
                                first_kg=0.5, next_kg=0.5),
    "三态美国中包（带电）": dict(hdr=1, country=1, band=2, price=3, fee=4,
                                lead=7, note=8, minchg=6, effdate=5),
    # 义速宝日本快捷: B=产品名 C=产品代码 D=重量段 E=首0.5kg价 F=续0.5kg价 G=时效
    #   E/F 是首重价与续重价, 不是运费单价 -> 走 firstnext 规则
    # 这张表的 B 列填的是产品名 (义速宝日本快捷 / 义速宝日本快捷(带电)),
    # 实际发件国家是日本 —— 用 country_override 指定, 并按产品名区分普货/带电。
    "义速宝日本快捷": dict(hdr=4, country=2, band=4, price=None, fee=None,
                           lead=7, note=None, minchg=None,
                           first=5, nextkg=6,
                           first_kg=0.5, next_kg=0.5,
                           country_override="日本",
                           attr_from_name=True),
}


def classify_header(cellmap):
    """把一行单元格解释成 {语义: 列号}。不是表头返回 None。

    注意:
    · 专线表的国家列表头写成 "国家地区/重量段" —— 国家与重量段同格,
      所以先把这类格子标成 country, 重量段另找一列 (如 "重量段")。
    · 体积除数列头是 "体积/6000 ... 运费/KG ..." —— 换行后 "运费" 与
      "体积" 不在同一行, 必须整格匹配 "体积/6000" 才认。
    · 左右分栏表 (欧盟P线) 同一表头行里出现两组国家列, 靠列号奇偶
      区分由调用方处理。
    """
    cols = {}
    for c, v in cellmap.items():
        s = str(v)
        flat = s.replace("\n", " ").replace("\r", " ")

        # --- 体积除数列 (优先, 特征最强) ---
        hit_div = None
        for d in ("6000", "10000", "18000"):
            if f"体积/{d}" in flat or re.search(rf"体积\s*/\s*{d}", flat):
                hit_div = d
                break
        if hit_div:
            cols.setdefault(f"div{hit_div}", c)
            continue

        if "挂号费" in flat or "处理费" in flat:
            cols.setdefault("fee", c); continue
        if "续重" in flat:
            cols.setdefault("nextkg", c); continue
        if "首重" in flat:
            cols.setdefault("first", c); continue
        if "最低计费重" in flat:
            cols.setdefault("minchg", c); continue
        if "进位制" in flat:
            cols.setdefault("step", c); continue
        if "生效日期" in flat:
            cols.setdefault("effdate", c); continue
        if "渠道代码" in flat or "产品代码" in flat:
            cols.setdefault("code", c); continue
        if "限重" in flat:
            cols.setdefault("maxkg", c); continue
        if "分区" in flat:
            cols.setdefault("zone", c); continue
        if "时效" in flat:
            cols.setdefault("lead", c); continue
        # "时效" 语义只在表头文本里认, 数据列的值另行判断
        if "尺寸限制" in flat or "尺寸重量限制" in flat or "准寄范围" in flat or "标准尺寸" in flat:
            cols.setdefault("limits", c); continue
        if "备注" in flat or "特征" in flat:
            cols.setdefault("note", c); continue

        # 国家列: 含"国家"或"地区"。但 "国家地区/重量段" 这种混合格先当 country
        if ("国家" in flat or "地区" in flat or "目的地" in flat
                or "产品名" in flat or "国家地区" in flat) and "尺寸" not in flat:
            cols.setdefault("country", c); continue
        # 纯重量段列
        if ("重量" in flat and ("段" in flat or "KG" in flat or "≤" in flat or "W" in flat)) \
                and "体积" not in flat and "限制" not in flat and "最低" not in flat:
            cols.setdefault("band", c); continue
        if flat.strip() in ("重量", "重量段", "重量(KG)", "重量（KG）"):
            cols.setdefault("band", c); continue
        # 运费 / 价格 / 收费标准
        if "运费" in flat or "价格" in flat or "收费标准" in flat:
            cols.setdefault("price", c); continue

    # "首重"单列出现 (如云途分区小表的 G191) 不能当首重续重表头 ——
    # 必须同行还有"续重"或"国家"才成立
    if "first" in cols and "nextkg" not in cols and "country" not in cols:
        cols.pop("first")
    # 首重列只在「没有续重列」时才兼任运费单价列 ——
    # 有续重列说明这是首重+续重计费表, 首重值不是 ¥/kg 单价,
    # 否则同一张表会被同时解读成 ¥/kg 表和首重续重表, 造成重复计价。
    if "first" in cols and "nextkg" not in cols and "price" not in cols:
        cols["price"] = cols["first"]
    # 首重/续重 的公斤数写在表头文字里: 首重10KG / 续重1KG / 首重（0.5KG）
    for c, v in cellmap.items():
        flat = str(v).replace("\n", " ")
        m = re.search(r"首重\s*[（(]?\s*(\d+(?:\.\d+)?)", flat)
        if m:
            cols.setdefault("first_kg", float(m.group(1)))
        m = re.search(r"续重\s*[（(]?\s*(\d+(?:\.\d+)?)", flat)
        if m:
            cols.setdefault("next_kg", float(m.group(1)))
    if "country" not in cols:
        return None
    if not any(k in cols for k in ("price", "div6000", "band", "first")):
        return None
    return cols



def _cell_kind(c, v):
    """判断单个表头格子属于哪种语义, 返回语义名或 None。"""
    flat = str(v).replace("\n", " ").replace("\r", " ")
    for d in ("6000", "10000", "18000"):
        if f"体积/{d}" in flat or re.search(rf"体积\s*/\s*{d}", flat):
            return f"div{d}"
    if "挂号费" in flat or "处理费" in flat:
        return "fee"
    if "续重" in flat:
        return "nextkg"
    if "首重" in flat:
        return "first"
    if "最低计费重" in flat:
        return "minchg"
    if "进位制" in flat:
        return "step"
    if "生效日期" in flat:
        return "effdate"
    if "渠道代码" in flat or "产品代码" in flat:
        return "code"
    if "限重" in flat:
        return "maxkg"
    if "分区" in flat:
        return "zone"
    if "时效" in flat:
        return "lead"
    if "尺寸限制" in flat or "尺寸重量限制" in flat or "准寄范围" in flat or "标准尺寸" in flat:
        return "limits"
    if "备注" in flat or "特征" in flat:
        return "note"
    if ("国家" in flat or "地区" in flat or "目的地" in flat
            or "产品名" in flat) and "尺寸" not in flat:
        return "country"
    if ("重量" in flat and ("段" in flat or "KG" in flat or "≤" in flat or "W" in flat)) \
            and "体积" not in flat and "限制" not in flat and "最低" not in flat:
        return "band"
    if flat.strip() in ("重量", "重量段", "重量(KG)", "重量（KG）"):
        return "band"
    if "运费" in flat or "价格" in flat or "收费标准" in flat:
        return "price"
    return None


def detect_blocks(cells):
    """找出表头行里的左右分栏 (欧盟P线: A-E 一组, G-K 一组)。

    逐格判定语义, 再按国家列的位置切成块 —— 不能先对整行分类, 因为
    setdefault 会让第二个国家列被丢弃, 右半块就整块丢了。
    """
    kinds = {c: _cell_kind(c, v) for c, v in cells.items()}
    # 单飞的"首重" (无续重、无国家) 降级成价格列
    if not any(k == "nextkg" for k in kinds.values()) and not any(k == "country" for k in kinds.values()):
        for c, k in list(kinds.items()):
            if k == "first":
                kinds[c] = "price"
    country_cols = sorted(c for c, k in kinds.items() if k == "country")
    if len(country_cols) < 2:
        whole = classify_header(cells)
        return [whole] if whole else []

    blocks = []
    for i, cc in enumerate(country_cols):
        end = country_cols[i + 1] if i + 1 < len(country_cols) else max(cells) + 1
        blk = {}
        for c, k in kinds.items():
            if k and cc <= c < end and k not in blk:
                blk[k] = c
        if "country" in blk:
            blocks.append(blk)
    return blocks


def _extract_block(g, r, blk, rows):
    """按一个列义块抽一行数据 (供左右分栏表使用)。

    返回 False 表示这一块已进入条款段落, 调用方应停止处理该块。
    """
    cc = blk.get("country")
    if cc is None:
        return True
    cn = txt(g.get((r, cc)))
    if not cn:
        return True
    if is_clause(cn):
        return False
    band = parse_band(txt(g.get((r, blk["band"])))) if blk.get("band") else None
    rec = {
        "country": cn,
        "lead": txt(g.get((r, blk["lead"]))) if blk.get("lead") else None,
        "limits": txt(g.get((r, blk["limits"]))) if blk.get("limits") else None,
        "note": txt(g.get((r, blk["note"]))) if blk.get("note") else None,
        "minchg": num(g.get((r, blk["minchg"]))) if blk.get("minchg") else None,
        "code": txt(g.get((r, blk["code"]))) if blk.get("code") else None,
        "maxkg": num(g.get((r, blk["maxkg"]))) if blk.get("maxkg") else None,
        "band": list(band) if band else None,
        "price": num(g.get((r, blk["price"]))) if blk.get("price") else None,
        "fee": num(g.get((r, blk["fee"]))) if blk.get("fee") else None,
        "div6000": num(g.get((r, blk["div6000"]))) if blk.get("div6000") else None,
        "div10000": num(g.get((r, blk["div10000"]))) if blk.get("div10000") else None,
        "div18000": num(g.get((r, blk["div18000"]))) if blk.get("div18000") else None,
        "first": num(g.get((r, blk["first"]))) if blk.get("first") else None,
        "nextkg": num(g.get((r, blk["nextkg"]))) if blk.get("nextkg") else None,
        "effdate": txt(g.get((r, blk["effdate"]))) if blk.get("effdate") else None,
    }
    if any(rec[k] is not None for k in ("price", "div6000", "first")):
        rows.append(rec)
    return True

def lead_text(v):
    """时效字段只接受看起来像时效的文本 (含 天/日/工作日/weekday 等)。

    纯数字 (如误填的日期序列号 46213) 与长段说明文字一律不当作时效。
    """
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return None
    s = str(v).strip()
    if not s or len(s) > 40:
        return None
    if any(k in s for k in ("天", "日", "工作日", "周", "week", "工作")):
        return s
    if re.match(r"^\d+\s*-\s*\d+", s):
        return s
    return None


def row_cells(g, r, maxc=60):
    return {c: g[(r, c)] for c in range(1, maxc + 1) if (r, c) in g}


def extract(ws, sheet_name=None):
    g = build_grid(ws)
    maxr = min(ws.max_row, 700)
    maxc = min(ws.max_column, 60)

    # 无表头行的小表: 走手工列位
    if sheet_name in MANUAL_SHEETS:
        m = MANUAL_SHEETS[sheet_name]
        rows = []
        last_cn = None
        for r in range(m["hdr"] + 1, maxr + 1):
            cn = txt(g.get((r, m["country"])))
            if cn and is_clause(cn):
                break
            if cn:
                last_cn = cn
            country = cn or last_cn
            if not country:
                continue
            # 产品名型国家名 -> 真实国家 (如 "义速宝日本快捷" -> 日本)
            attr = ""
            if m.get("country_override"):
                country = m["country_override"]
                if m.get("attr_from_name") and cn:
                    attr = "带电" if "带电" in cn else "普货"
            band = parse_band(txt(g.get((r, m["band"])))) if m.get("band") else None
            price = num(g.get((r, m["price"]))) if m.get("price") else None
            fee = num(g.get((r, m["fee"]))) if m.get("fee") else None
            first = num(g.get((r, m["first"]))) if m.get("first") else None
            nextkg = num(g.get((r, m["nextkg"]))) if m.get("nextkg") else None
            # 首重续重型 (E=首重价 F=续重价): 每行可有不同续重价, 按重量段记档
            if m.get("first") and m.get("nextkg") and price is None:
                if first is None and nextkg is None:
                    continue
                # 这类表没有重量段 -> 覆盖全部重量
                fn_band = list(band) if band else [0.0, 999.0]
                rows.append({
                    "country": country, "zone": None, "attr": attr,
                    "lead": lead_text(g.get((r, m["lead"]))) if m.get("lead") else None,
                    "limits": None,
                    "note": txt(g.get((r, m["note"]))) if m.get("note") else None,
                    "minchg": num(g.get((r, m["minchg"]))) if m.get("minchg") else None,
                    "code": None, "maxkg": None,
                    "band": fn_band,
                    "price": None, "fee": fee,
                    "div6000": None, "div10000": None, "div18000": None,
                    "first": first, "nextkg": nextkg,
                    "first_kg": m.get("first_kg"), "next_kg": m.get("next_kg"),
                    "step": None,
                    "effdate": txt(g.get((r, m["effdate"]))) if m.get("effdate") else None,
                })
                continue
            if price is None:
                continue
            rows.append({
                "country": country, "zone": None,
                "lead": lead_text(g.get((r, m["lead"]))) if m.get("lead") else None,
                "limits": None,
                "note": txt(g.get((r, m["note"]))) if m.get("note") else None,
                "minchg": num(g.get((r, m["minchg"]))) if m.get("minchg") else None,
                "code": None, "maxkg": None,
                "band": list(band) if band else None,
                "price": price, "fee": fee,
                "div6000": None, "div10000": None, "div18000": None,
                "first": None, "nextkg": None,
                "first_kg": m.get("first_kg"), "next_kg": m.get("next_kg"), "step": None,
                "effdate": txt(g.get((r, m["effdate"]))) if m.get("effdate") else None,
            })
        return rows

    rows = []          # 抽出的费率行
    cur_cols = {}      # 当前生效的列义
    cur_blocks = []    # 左右分栏时的列义块
    block_alive = []   # 每个块是否还在费率区
    cur_country = None
    cur_zone = None    # 当前分区 (一区/二区/...)
    cur_meta = {}      # 当前国家的附加信息 (时效/尺寸/最低计费重)

    def flush(country, meta):
        pass

    pending_country = None
    pending_meta = {}

    r = 1
    while r <= maxr:
        cells = row_cells(g, r, maxc)
        if not cells:
            r += 1
            continue

        # 这行是表头吗?
        hc = classify_header(cells)
        if hc:
            cur_cols = hc
            cur_country = None
            cur_zone = None
            pending_meta = {}
            # 左右分栏表: 同一表头行出现两组国家列 (欧盟P线 A-E + G-K)
            blocks = detect_blocks(cells)
            if len(blocks) > 1:
                cur_blocks = blocks
                block_alive = [True] * len(blocks)
            else:
                cur_blocks = [cur_cols]
                block_alive = [True]
            r += 1
            continue

        # 分栏表: 对每个块分别处理 (左块到条款就停, 右块继续)
        if cur_blocks and len(cur_blocks) > 1:
            for bi, blk in enumerate(cur_blocks):
                if not block_alive[bi]:
                    continue
                if not _extract_block(g, r, blk, rows):
                    block_alive[bi] = False
            r += 1
            continue

        cc = cur_cols.get("country")
        if cc is None:
            r += 1
            continue

        raw_cn = txt(g.get((r, cc)))
        cn = raw_cn
        if cn and is_clause(cn):
            break  # 进入条款段落, 结束
        # 条款区的特征行: 国家列有值, 但重量列里是说明文字 (而非重量段)
        if cn and cur_cols.get("band"):
            btxt = txt(g.get((r, cur_cols["band"])))
            if btxt and parse_band(btxt) is None and len(btxt) > 12:
                break
        if cn:
            # 重量段列是长说明文字 -> 说明已进入条款区, 停止抽费率
            if cur_cols.get("band"):
                btxt = txt(g.get((r, cur_cols["band"])))
                if btxt and parse_band(btxt) is None and len(btxt) > 12:
                    break
            cur_country = cn
            cur_zone = None
            pending_meta = {}
            # 取本行的时效/尺寸/最低计费重
            if cur_cols.get("lead"):
                pending_meta["lead"] = lead_text(g.get((r, cur_cols["lead"])))
            if cur_cols.get("limits"):
                pending_meta["limits"] = txt(g.get((r, cur_cols["limits"])))
            if cur_cols.get("note"):
                pending_meta["note"] = txt(g.get((r, cur_cols["note"])))
            if cur_cols.get("minchg"):
                pending_meta["minchg"] = num(g.get((r, cur_cols["minchg"])))
            if cur_cols.get("code"):
                pending_meta["code"] = txt(g.get((r, cur_cols["code"])))
            if cur_cols.get("maxkg"):
                pending_meta["maxkg"] = num(g.get((r, cur_cols["maxkg"])))

        if not cur_country:
            r += 1
            continue

        band = parse_band(txt(g.get((r, cur_cols["band"])))) if cur_cols.get("band") else None
        price = num(g.get((r, cur_cols["price"]))) if cur_cols.get("price") else None
        fee = num(g.get((r, cur_cols["fee"]))) if cur_cols.get("fee") else None
        d6 = num(g.get((r, cur_cols["div6000"]))) if cur_cols.get("div6000") else None
        d10 = num(g.get((r, cur_cols["div10000"]))) if cur_cols.get("div10000") else None
        d18 = num(g.get((r, cur_cols["div18000"]))) if cur_cols.get("div18000") else None
        first = num(g.get((r, cur_cols["first"]))) if cur_cols.get("first") else None
        nextkg = num(g.get((r, cur_cols["nextkg"]))) if cur_cols.get("nextkg") else None

        zone_val = txt(g.get((r, cur_cols["zone"]))) if cur_cols.get("zone") else None
        if zone_val:
            cur_zone = zone_val

        rec = {
            "country": cur_country,
            "zone": cur_zone,
            "lead": pending_meta.get("lead"),
            "lead_raw": None,
            "limits": pending_meta.get("limits"),
            "note": pending_meta.get("note"),
            "minchg": pending_meta.get("minchg"),
            "code": pending_meta.get("code"),
            "maxkg": pending_meta.get("maxkg"),
            "band": list(band) if band else None,
            "price": price,
            "fee": fee,
            "div6000": d6, "div10000": d10, "div18000": d18,
            "first": first, "nextkg": nextkg,
            "first_kg": cur_cols.get("first_kg"),
            "next_kg": cur_cols.get("next_kg"),
            "step": num(g.get((r, cur_cols["step"]))) if cur_cols.get("step") else None,
            "effdate": txt(g.get((r, cur_cols["effdate"]))) if cur_cols.get("effdate") else None,
        }
        # 至少要有一个价格数字
        if any(rec[k] is not None for k in ("price", "div6000", "first")):
            rows.append(rec)
        r += 1

    return rows


def main():
    wb = openpyxl.load_workbook(SRC, data_only=False)
    channels = []
    for name in wb.sheetnames:
        if name in SKIP_SHEETS:
            continue
        ws = wb[name]
        rows = [x for x in extract(ws, name) if x.get("country")]
        if not rows:
            print(f"  (skip) {name}")
            continue
        # 按 (国家, 分区) 分组 —— 同一国家可能按一区/二区/三区/四区给不同价
        groups = {}
        for rec in rows:
            c = rec["country"]
            z = rec.get("zone") or ""
            a = rec.get("attr") or ""
            key = (c, z, a)
            e = groups.setdefault(key, {
                "country": c, "zone": rec.get("zone"), "attr": a,
                "lead": None, "limits": None,
                "note": None, "minchg": None, "code": None, "maxkg": None,
                "effdate": None, "first_kg": None, "next_kg": None, "step": None,
                "tiers": [], "fee": None,
                "div6000": None, "div10000": None, "div18000": None,
                "first": None, "nextkg": None, "fn_tiers": [],
            })
            for k in ("lead", "limits", "note", "minchg", "code", "maxkg", "effdate",
                      "first_kg", "next_kg", "step"):
                if e[k] is None and rec.get(k):
                    e[k] = rec[k]
            for k in ("div6000", "div10000", "div18000"):
                if e[k] is None and rec.get(k) is not None:
                    e[k] = rec[k]
            if e["fee"] is None and rec.get("fee") is not None:
                e["fee"] = rec["fee"]
            if rec.get("first") is not None or rec.get("nextkg") is not None:
                # 首重价常只在第一行给出, 后续行留空 -> 继承上一档
                fn_first = rec.get("first")
                if fn_first is None and e["fn_tiers"]:
                    fn_first = e["fn_tiers"][-1].get("first")
                fn_next = rec.get("nextkg")
                if fn_next is None and e["fn_tiers"]:
                    fn_next = e["fn_tiers"][-1].get("nextkg")
                # band=None 的行: 金马/美森这类表没有重量段 (只有首重kg+续重kg),
                # 是真档; 但条款区误抽的行也会这样 —— 用"首重价是否合理"筛。
                band = rec.get("band")
                if band is None:
                    # 首重价过大(>5000)基本是条款区数字误抽
                    if fn_first is None or fn_first > 5000:
                        continue
                    band = [0.0, 999.0]
                e["fn_tiers"].append({
                    "band": band,
                    "first": fn_first, "nextkg": fn_next,
                })
                if e["first"] is None and rec.get("first") is not None:
                    e["first"] = rec["first"]
                    e["nextkg"] = rec.get("nextkg")
            if rec.get("band") and rec.get("price") is not None:
                e["tiers"].append({"band": rec["band"], "price": rec["price"], "fee": rec.get("fee")})
        countries = list(groups.values())
        layout = "divider" if any(c["div6000"] is not None for c in countries) else (
            "firstnext" if any(c["first"] is not None for c in countries) else "band")
        channels.append({
            "sheet": name, "layout": layout,
            "countries": sorted(countries, key=lambda x: (x["country"], x["zone"] or "")),
        })
        nt = sum(len(c["tiers"]) for c in countries)
        nd = sum(1 for c in countries if c["div6000"] is not None)
        nf = sum(1 for c in countries if c["first"] is not None)
        nz = sum(1 for c in countries if c["zone"])
        print(f"  {name[:34]:36s} {layout:9s} g={len(countries):3d} tiers={nt:4d} "
              f"div={nd:3d} first={nf:2d} zones={nz:3d}")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"channels": channels}, f, ensure_ascii=False, indent=1)
    print("written", OUT)


if __name__ == "__main__":
    main()
