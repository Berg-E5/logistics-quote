"""
从报价表提取「逐国体积重除数」与「起收重量」。

除数有两个来源, 优先级从高到低:

  1. sheet 备注区   —— 每个渠道 sheet 的备注区逐国写的除数 (最具体)
  2. 总目录第 5 列  —— 产品线级的除数说明 (总目录是渠道级口径, 覆盖范围更广)
  3. fallback       —— CHANNEL_DEFAULT 里的硬编码默认值 (最不可靠, 仅在 1/2 都没有时用)

两个来源都没有覆盖到的国家 -> 标记为「不确定」(divUncertain),
前台显示「不确定」而不是随便给个数, 免得用户以为那是报价表的口径。

==== 备注区的两种版式 ====

版式 A (云途等): 国家名和说明在同一格
    "1.加拿大：...长*宽*高cm/8000=KG"

版式 B (三态等): 国家名在第 1 列, 说明在第 2 列
    行88: 丹麦 | 实重和体积重取大者，体积重规则：长*宽*高cm/18000 | ...
    —— 早期版本只按版式 A 解析, 导致三态系列整批漏抽 (2026-11 修复)

==== 总目录第 5 列的格式 ====

    欧洲26国;美国;加拿大，长*宽*高(CM)/6000          -> 范围内所有国家同一除数
    欧洲26国;美国;加拿大，欧洲：体积/10000；加拿大：体积/12000  -> 分段不同除数
    英国，日本，长*宽*高(CM)/18000                    -> 同上
    美国/8000最大尺寸可发：60*45*40cm                 -> 单国 + 尾注
    美国/10000，偏远附加费40元一单
    英国，欧洲，长*宽*高(CM)/30000
"""
import os
import re
import json
import openpyxl

SRC = r"C:/Users/Administrator/AppData/Local/hermes/attachments/广州市盛途科技渠道整合报价-2026-10-26-2.xlsx"
# ---- 数据源: 由 更新报价.py 写入 源文件路径.txt ----
_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "源文件路径.txt")
if os.path.exists(_CFG):
    SRC = open(_CFG, encoding="utf-8").read().strip()

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "div_rules.json")

wb = openpyxl.load_workbook(SRC, data_only=False)

# ---------------------------------------------------------------- 文本解析

# 除数写法在报价表里有好几种, 都要认:
#   长*宽*高/8000        长*宽*高cm/8000       长*宽*高(CM)/8000
#   长(CM)×宽(CM)×高(CM)÷8000                    体积/8000
DIV_RE = re.compile(
    r"长\s*[（(]?\s*[Cc][Mm]\s*[）)]?\s*[×*]\s*宽\s*[（(]?\s*[Cc][Mm]\s*[）)]?\s*[×*]\s*高"
    r"\s*[（(]?\s*[Cc][Mm]\s*[）)]?\s*[÷/]\s*(\d+)"
    r"|长\s*\*\s*宽\s*\*\s*高\s*(?:\(\s*[Cc][Mm]\s*\)|[Cc][Mm])?\s*[÷/]\s*(\d+)"
    r"|体积\s*[÷/]\s*(\d+)")
VOL_RE = re.compile(r"体积\s*[÷/]\s*(\d+)")
SLASH_RE = re.compile(r"/\s*(\d{3,6})")
MINKG_RE = re.compile(r"(\d+)\s*[GgGg]\s*起重")

# 已知国家名 (用于从文本里定位国家段)
KNOWN = ["加拿大", "日本", "新加坡", "马来西亚", "泰国", "越南", "哥伦比亚", "新西兰", "巴西",
         "科威特", "卡塔尔", "巴林", "约旦", "巴基斯坦", "尼日利亚", "加纳", "乌干达", "肯尼亚",
         "马约特", "坦桑尼亚", "卢旺达", "安哥拉", "阿拉伯联合酋长国", "摩洛哥", "塞内加尔", "毛里求斯",
         "留尼汪", "马达加斯加", "塞舌尔", "赞比亚", "南非", "阿塞拜疆", "美国", "墨西哥", "英国", "德国",
         "法国", "意大利", "西班牙", "荷兰", "比利时", "瑞典", "波兰", "爱尔兰", "沙特阿拉伯", "阿联酋",
         "澳大利亚", "俄罗斯", "以色列", "印度", "印度尼西亚", "菲律宾", "韩国", "土耳其", "智利", "秘鲁",
         "阿根廷", "葡萄牙", "捷克", "匈牙利", "奥地利", "保加利亚", "希腊", "罗马尼亚", "芬兰", "丹麦",
         "爱沙尼亚", "拉脱维亚", "立陶宛", "斯洛伐克", "斯洛文尼亚", "克罗地亚", "冰岛", "中国"]

# 欧洲国家集合 (总目录里「欧洲26国」「欧洲」指的就是这一批)
EUROPE = [
    "英国", "德国", "法国", "西班牙", "比利时", "卢森堡", "荷兰", "奥地利", "捷克", "斯洛伐克",
    "匈牙利", "波兰", "意大利", "爱尔兰", "瑞典", "丹麦", "芬兰", "保加利亚", "爱沙尼亚", "希腊",
    "立陶宛", "拉脱维亚", "葡萄牙", "罗马尼亚", "斯洛文尼亚", "克罗地亚",
    # 报价表里还没出现, 但同属欧洲, 一并留着
    "瑞士", "挪威", "冰岛", "塞尔维亚", "黑山", "北马其顿", "阿尔巴尼亚", "摩尔多瓦", "乌克兰",
]

# 已知国家名单要覆盖全部出现过的地方 —— 漏一个就会整行漏抽。
# (2026-11: 漏了「卢森堡」, 而它正是总目录「欧洲26国」里的第 26 国)
KNOWN = sorted(set(KNOWN) | set(EUROPE), key=lambda s: (-len(s), s))

# 渠道 -> 兜底除数 (只在 sheet 备注区和总目录都没给口径时才用, 属于「不确定来源」)
CHANNEL_DEFAULT = {
    "云途全球专线挂号（特惠普货）": 8000,
    "云途全球专线挂号（特惠带电）": 8000,
    "云途全球专线挂号（标快普货）": 8000,
    "云途全球服装专线挂号": 8000,
    "云途全球化妆品类专线挂号": 8000,
    "云途全球泡货专线挂号(特惠普货)": 6000,
    "云途岛屿专线（特惠普货）": 9000,
    "云途岛屿专线（特惠带电）": 9000,
    "云途商派专线（特惠普货）": 8000,
    "三态重货-普货": 6000,
    "三态中包-普货": 6000,
    "三态专选": 6000,
    "三态免泡大货专线（普货）": 6000,
    "三态免泡大货专线（带电）": 6000,
    "三态特惠专线（普货）": 6000,
    "三态美国中包（带电）": 6000,
    "4PX全球专线特快-普货": 8000,
    "4PX全球专线特快-带电": 8000,
    "4PX美国商派专线-普货": 8000,
    "欧洲敏感专线-E": 8000,
    "义速宝全球特惠专线BS(普货)": 8000,
    "亚马逊义速宝全球快捷(普货)": 8000,
    "亚马逊义速宝全球快捷(带电)": 8000,
}

# 总目录渠道名 -> sheet 名 (手工补几个名字对不上的)
CATALOG_ALIAS = {
    "三态重货（普货）": "三态重货-普货",
    # 带电版和普货版规范化后同名, 必须显式指定, 否则匹配到 2 个候选就放弃了
    "三态免泡大货专线（带电）": "三态免泡大货专线（带电）",
    "三态特惠专线（普货）": "三态特惠专线（普货）",
    "三态美国中包（带电）": "三态美国中包（带电）",
    "三态专选": "三态专选",
    "三态中包（普货）": "三态中包-普货",
    "三态免泡大货专线【英国/日本】（普货）": "三态免泡大货专线（普货）",
    "盛途欧盟P线 (预上网，DPD派送)": "欧盟P线",
    "盛途欧盟D线（DHL派送）": "欧盟D线",
    "盛途英国专线(预上网，DPD派送)": "英国专线",
    "盛途德国专线(预上网，DHL派送)": "德国专线",
    "盛途美国Ⅱ号线": "美国Ⅱ号线",
    "全球敏感小包": "欧洲敏感专线-E",
}


def find_div(text):
    """从一段文本里找体积重除数。找不到返回 None。"""
    flat = re.sub(r"\s+", "", text or "")
    for rx in (DIV_RE, VOL_RE):
        m = rx.search(flat)
        if m:
            for gi in (1, 2, 3):
                if m.group(gi):
                    return int(m.group(gi))
    m = SLASH_RE.search(flat)
    if m:
        v = int(m.group(1))
        if 1000 <= v <= 100000:
            return v
    return None


def split_countries(text):
    """从一段文本里找出它讲的国家列表 (取 '：' 前的中文国家名)。"""
    head = text.split("：")[0].split(":")[0]
    head = re.sub(r"^[0-9０-９]+\s*[.．、]\s*", "", head).strip()
    if "其他国家" in head:
        return ["__OTHER__"]
    found = []
    for c in KNOWN:
        if c in head:
            found.append(c)
    if not found:
        return []
    return found


def norm_channel(name):
    """规范化渠道名, 去掉属性后缀, 便于总目录名匹配 sheet 名。"""
    s = str(name or "").strip()
    s = re.sub(r"【[^】]*】", "", s)
    s = re.sub(r"[（(][普带][货电][^）)]*[）)]", "", s)
    s = s.replace("盛途", "")
    return s.strip()


# ---------------------------------------------------------------- sheet 备注区

def extract_sheet(name):
    """返回 {country: {div, minKg}} —— 兼容两种备注区版式。"""
    ws = wb[name]
    out = {}

    # --- 版式 A: 国家名与说明在同一格 ---
    for r in range(1, min(ws.max_row, 400) + 1):
        for c in range(1, min(ws.max_column, 3) + 1):
            v = ws.cell(row=r, column=c).value
            if isinstance(v, str) and ("长*宽*高" in v.replace(" ", "") or "长×宽×高" in v
                                       or "体积重" in v or "材积重" in v or "起重" in v):
                t = v.strip()
                flat = re.sub(r"\s+", "", t)
                dm = DIV_RE.search(flat)
                if not dm:
                    continue
                div = None
                for gi in (1, 2, 3):
                    if dm.group(gi):
                        div = int(dm.group(gi))
                        break
                if div is None:
                    continue
                countries = split_countries(t)
                mm = MINKG_RE.search(flat)
                minkg = (float(mm.group(1)) / 1000.0) if mm else None
                for ctry in countries:
                    out[ctry] = dict(div=div, minKg=minkg)

    # --- 版式 C: 通用说明 (整行只有一个非空单元格, 没有国家名前缀) ---
    #     4PX:  行175 「取实重和体积重较大值计费（体积重量计算方式为：长*宽*高/8000），...」
    #     义速宝: 行13 「体积计算公式：长(CM)×宽(CM)×高(CM)÷6000」
    #     这类说明适用于该渠道所有国家 -> 归到 other (「其他国家」口径)。
    #     专线三线的表头 (「体积/6000重货实惠运费/KG」) 那一行有很多列, 不会命中这里。
    for r in range(1, min(ws.max_row, 400) + 1):
        nonempty = [c for c in range(1, min(ws.max_column, 13) + 1)
                    if ws.cell(row=r, column=c).value not in (None, "")]
        if len(nonempty) != 1:
            continue
        c = nonempty[0]
        v = ws.cell(row=r, column=c).value
        if not isinstance(v, str):
            continue
        flat = re.sub(r"\s+", "", v)
        if not ("长*宽*高" in flat or "长×宽×高" in flat or "体积重" in flat
                or "材积重" in flat or "体积计算" in flat):
            continue
        dm = DIV_RE.search(flat)
        if not dm:
            continue
        div = None
        for gi in (1, 2, 3):
            if dm.group(gi):
                div = int(dm.group(gi))
                break
        if div is None:
            continue
        # 头部 (第一个「：」之前) 里出现国家名 -> 不是通用说明, 留给版式 A/B 处理
        head = flat.split("：")[0].split(":")[0]
        if any(k in head for k in KNOWN):
            continue
        if "其他国家" in head:
            continue          # 版式 A 已经用 __OTHER__ 处理过了
        if "__OTHER__" in out:
            continue          # 版式 A 的「其他国家」更明确, 不许版式 C 覆盖
        mm = MINKG_RE.search(flat)
        minkg = (float(mm.group(1)) / 1000.0) if mm else None
        out["__OTHER__"] = dict(div=div, minKg=minkg)

    # --- 版式 B: 国家名在第 1 列, 说明在第 2 列 (三态系列) ---
    for r in range(1, min(ws.max_row, 400) + 1):
        first = ws.cell(row=r, column=1).value
        if not isinstance(first, str):
            continue
        ctry = first.strip()
        if ctry not in KNOWN:
            continue
        for c in range(2, min(ws.max_column, 4) + 1):
            v = ws.cell(row=r, column=c).value
            if not isinstance(v, str):
                continue
            flat = re.sub(r"\s+", "", v)
            if not ("长*宽*高" in flat or "长×宽×高" in flat or "体积重" in flat):
                continue
            dm = DIV_RE.search(flat)
            if not dm:
                continue
            div = None
            for gi in (1, 2, 3):
                if dm.group(gi):
                    div = int(dm.group(gi))
                    break
            if div is None:
                continue
            mm = MINKG_RE.search(flat)
            minkg = (float(mm.group(1)) / 1000.0) if mm else None
            # 版式 A 已经写过这个国家就不覆盖 (同格里的更完整)
            if ctry in out:
                continue
            out[ctry] = dict(div=div, minKg=minkg)
    return out


# ---------------------------------------------------------------- 总目录

# 「范围 + 除数」成对匹配。范围里可以含分号/逗号, 但不能含斜杠,
# 所以非贪婪的 [^/]*? 正好把范围和除数说明分开。
#   "欧洲26国;美国;加拿大，长*宽*高(CM)/18000"
#     -> 范围 "欧洲26国;美国;加拿大，"  除数 18000
#   "欧洲26国;美国;加拿大，欧洲：体积/10000；加拿大：体积/12000"
#     -> 范围 "欧洲26国;美国;加拿大，欧洲：" 除数 10000
#     -> 范围 "；加拿大："                  除数 12000
#   "美国/8000最大尺寸可发：60*45*40cm"
#     -> 范围 "美国"  除数 8000
CATALOG_DIV_RE = re.compile(
    r"([^/]*?)((?:长\*宽\*高(?:\(\s*CM\s*\)|cm|CM)?|长×宽×高|体积|材积重)?)/(\d{3,6})")


def parse_catalog_advantage(adv):
    """解析总目录第 5 列 -> [(适用范围, 除数覆盖范围, 除数), ...]

    适用范围   = 这条产品线走哪些国家 (总目录第一段)
    除数覆盖范围 = 除数说明实际管到哪些国家 (通常比适用范围小)

    例: 「欧洲26国;美国;加拿大，欧洲：体积/10000；加拿大：体积/12000」
       适用范围 = 欧洲26国 + 美国 + 加拿大
       10000 只覆盖欧洲国家, 加拿大另给 12000
       -> 美国落在适用范围内却没有除数说明 => 体积重除数「不确定」
    """
    if not adv:
        return []
    flat = re.sub(r"\s+", "", str(adv))
    items = []
    for m in CATALOG_DIV_RE.finditer(flat):
        raw = m.group(1).rstrip(" ,，;；")
        div = int(m.group(3))
        if not (1000 <= div <= 100000):
            continue
        if raw.endswith(("：", ":")):
            # 「...：除数说明」型 —— 除数只管到冒号前最后那一段
            parts = re.split(r"[;；,，]", raw[:-1].rstrip(" ,，;；"))
            div_scope = parts[-1].strip() if parts else ""
            full_scope = raw[:-1].rstrip(" ,，;；")
        else:
            # 「...;...,除数说明」型 —— 整段都适用
            div_scope = raw
            full_scope = raw
        items.append((full_scope, div_scope, div))
    return items


def expand_scope(scope, sheet_countries):
    """把范围串展开成国家集合。

    「欧洲26国」「欧洲」 -> 该渠道覆盖的欧洲国家
    其他 -> 里面提到的国家名
    """
    if not scope:
        return set()
    out = set()
    if "欧洲" in scope:
        out |= {c for c in sheet_countries if c in EUROPE}
    for c in KNOWN:
        if c in scope:
            out.add(c)
    return out


def _is_price_row(ws, r):
    """价格行 vs 备注区行。

    价格行: 第 2 列是重量段 (以数字开头, 如 "0-1KG" / "0 - 30KG")
    备注区行: 第 2 列是文字说明 (体积重规则 / 偏远说明 / 关税说明)

    早期版本靠「第 8 列文本长度 > 400」来判断, 结果卢森堡那一行因为
    尺寸限制写得长被误判成备注区, 漏掉了 —— 而它正是「欧洲26国」里的第 26 国。
    """
    c2 = ws.cell(row=r, column=2).value
    s2 = "" if c2 is None else str(c2).strip()
    if s2 and s2[0].isdigit():
        return True
    if not s2:
        c3 = ws.cell(row=r, column=3).value
        s3 = "" if c3 is None else str(c3).strip()
        return bool(s3 and s3[0].isdigit())
    return False


def sheet_countries(name):
    """一个 sheet 的价格行覆盖了哪些国家。"""
    ws = wb[name]
    out = []
    seen = set()
    for r in range(1, min(ws.max_row, 400) + 1):
        v = ws.cell(row=r, column=1).value
        if not isinstance(v, str):
            continue
        s = v.strip()
        if not s or s in seen or s not in KNOWN:
            continue
        if not _is_price_row(ws, r):
            continue
        out.append(s)
        seen.add(s)
    return out


def extract_catalog():
    """从总目录读产品线级除数 -> {sheet名: {country: {div, minKg}}}"""
    if "总目录" not in wb.sheetnames:
        return {}
    ws = wb["总目录"]
    result = {}
    for r in range(3, min(ws.max_row, 60) + 1):
        chan = ws.cell(row=r, column=2).value
        adv = ws.cell(row=r, column=5).value
        if not chan or not adv:
            continue
        chan = str(chan).strip()
        sheet = CATALOG_ALIAS.get(chan)
        if sheet is None:
            nc = norm_channel(chan)
            cands = [s for s in wb.sheetnames
                     if s != "总目录" and (norm_channel(s) == nc or norm_channel(s).startswith(nc)
                                           or nc.startswith(norm_channel(s)))]
            if len(cands) == 1:
                sheet = cands[0]
        if not sheet or sheet not in wb.sheetnames:
            continue
        items = parse_catalog_advantage(adv)
        if not items:
            continue
        countries = sheet_countries(sheet)
        got = result.setdefault(sheet, {})
        for full_scope, div_scope, div in items:
            for ctry in expand_scope(full_scope, countries):
                got.setdefault("_scope", set())
                got["_scope"].add(ctry)
            for ctry in expand_scope(div_scope, countries):
                got.setdefault(ctry, dict(div=div, minKg=None))
    # _scope 是集合, 单独拿出来
    for sheet, got in result.items():
        sc = got.pop("_scope", set())
        result[sheet] = got
        result[sheet]["scopeCountries"] = sorted(sc)
    return result


# ---------------------------------------------------------------- 主流程

def main():
    # 1) sheet 备注区
    sheet_rules = {}
    for name in wb.sheetnames:
        if name == "总目录":
            continue
        r = extract_sheet(name)
        if r:
            sheet_rules[name.strip()] = r

    # 2) 总目录
    catalog_rules = extract_catalog()

    result = {}
    all_sheets = [s for s in wb.sheetnames if s != "总目录"]
    for name in all_sheets:
        key = name.strip()
        sr = sheet_rules.get(key, {})
        cr = catalog_rules.get(key, {})

        byCountry = {}
        # sheet 备注区优先
        for ctry, v in sr.items():
            byCountry[ctry] = dict(div=v["div"], minKg=v.get("minKg"), src="sheet")
        # 总目录补齐 (只在 sheet 没给这个国家时)
        for ctry, v in cr.items():
            if ctry.startswith("_") or not isinstance(v, dict):
                continue
            if ctry not in byCountry:
                byCountry[ctry] = dict(div=v["div"], minKg=v.get("minKg"), src="catalog")

        # 「其他国家：.../N」展开成 other (真正的兜底口径)
        other = byCountry.pop("__OTHER__", None)
        if not byCountry and not other:
            continue
        result[key] = dict(
            default=CHANNEL_DEFAULT.get(key),
            byCountry=byCountry,
            scopeCountries=cr.get("scopeCountries") or [],
            other=other,
            hasCatalog=bool(cr),
        )
        srcs = {}
        for ctry, v in byCountry.items():
            srcs.setdefault(v.get("src"), []).append(ctry)
        print(f"  {key[:30]:32s} 逐国={len(byCountry):3d}  "
              + " ".join(f"{s}={len(v)}" for s, v in srcs.items()))

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print("written", OUT, len(result), "渠道")

    # ---- 对比: 总目录补进来多少条 ----
    for key in sorted(set(catalog_rules) | set(sheet_rules)):
        s = set(sheet_rules.get(key, {}))
        c = set(catalog_rules.get(key, {}))
        added = c - s
        if added:
            print(f"  [总目录补齐] {key}: +{len(added)} 国 -> "
                  + ", ".join(f"{x}={catalog_rules[key][x]['div']}"
                              for x in sorted(added)
                              if isinstance(catalog_rules[key][x], dict)))


if __name__ == "__main__":
    main()
