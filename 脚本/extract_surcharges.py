"""
从《渠道整合报价》抽取 尺寸限制 + 附加费 规则。

输出 surcharges.json:
{
  "<sheet>": {
      "default": { "lim": {...}, "sur": [...] },
      "byCountry": {
         "美国": { "lim": {...}, "sur": [...], "text": "原文" },
         ...
      }
  }
}

lim 结构 (全部可为 None):
  maxSide   最长边上限 cm
  maxSide2  第二边长上限 cm
  maxGirth2 长+2*(宽+高) 上限 cm
  maxGirth1 长+(宽+高)*2 上限 cm
  maxSum3   长+宽+高 上限 cm
  maxDim    [a,b,c] 三边上限 (降序比较)
  maxWt     实重上限 kg
  maxVolM3  体积上限 m3
  minDim    [a,b,c] 最小尺寸

sur 结构 (列表, 命中即加收):
  {"name": "...", "fee": 150, "stack": false, "cond": [ {...}, ... ], "note": "..."}
  cond 各条为 AND; 支持的条件键:
    weight_gt, side_gt, girth2_gt, girth1_gt, sum3_gt, dim_ge, vol_ratio_gt, vol_m3_gt
  stack=false 时同组内只取最高一笔; true 则累加
"""
import json
import os
import re

import openpyxl

SRC = (r"C:\Users\Administrator\AppData\Local\hermes\attachments"
       r"\广州市盛途科技渠道整合报价-2026-10-26-2.xlsx")
# ---- 数据源: 由 更新报价.py 写入 源文件路径.txt ----
_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "源文件路径.txt")
if os.path.exists(_CFG):
    SRC = open(_CFG, encoding="utf-8").read().strip()

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "surcharges.json")

SKIP = {"总目录", "金马理赔条款说明", "日本偏远", "发货实拍", "美国邮编"}

# 报价表里出现过的国家/地区名 (用于在整段文字里定位国家)
COUNTRIES = [
    "南非", "尼日利亚", "加纳", "乌干达", "肯尼亚", "马约特", "巴基斯坦", "坦桑尼亚",
    "卢旺达", "安哥拉", "埃及", "摩洛哥", "阿塞拜疆", "塞内加尔", "毛里求斯", "留尼汪",
    "马达加斯加", "塞舌尔", "赞比亚", "德国", "荷兰", "比利时", "卢森堡", "爱尔兰",
    "瑞典", "挪威", "加拿大", "以色列", "巴西", "墨西哥", "哥伦比亚", "日本", "澳大利亚",
    "新加坡", "马来西亚", "泰国", "新西兰", "美国", "约旦", "阿拉伯联合酋长国", "阿联酋",
    "科威特", "卡塔尔", "巴林", "沙特阿拉伯", "沙特", "越南", "菲律宾", "秘鲁", "韩国",
    "瑞士", "智利", "厄瓜多尔", "萨尔瓦多", "哥斯达黎加", "阿根廷", "印度尼西亚",
    "英国", "法国", "意大利", "西班牙", "波兰", "葡萄牙", "希腊", "芬兰", "丹麦",
    "捷克", "斯洛伐克", "斯洛文尼亚", "克罗地亚", "匈牙利", "奥地利", "保加利亚",
    "罗马尼亚", "立陶宛", "拉脱维亚", "爱沙尼亚", "冰岛", "土耳其", "中国香港", "中国澳门",
]


def num(s):
    try:
        return float(str(s).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def find_dims(text):
    """'55*40*35' / '60x40x35' / '120CM*60CM*60CM' -> [55,40,35]"""
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:CM|cm)?\s*[*xX×]\s*"
                  r"(\d+(?:\.\d+)?)\s*(?:CM|cm)?\s*[*xX×]\s*"
                  r"(\d+(?:\.\d+)?)", text)
    if not m:
        return None
    return [float(m.group(1)), float(m.group(2)), float(m.group(3))]


def countries_in(text):
    """找出这段文字提到的国家 (长的名字优先, 避免 '沙特' 抢 '沙特阿拉伯')"""
    hits = []
    for c in sorted(COUNTRIES, key=len, reverse=True):
        if c in text and not any(c in h and c != h for h in hits):
            hits.append(c)
    # 去掉被更长名字包含的短名
    out = []
    for c in hits:
        if any(c != o and c in o for o in hits):
            continue
        out.append(c)
    return out


MAXDIM_RE = re.compile(
    r"最大尺寸(?:限制|要求)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:CM|cm)?\s*[*xX×]\s*"
    r"(\d+(?:\.\d+)?)\s*(?:CM|cm)?\s*[*xX×]\s*(\d+(?:\.\d+)?)", re.I)
MINDIM_RE = re.compile(
    r"最小尺寸(?:限制|要求)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:CM|cm)?\s*[*xX×]\s*"
    r"(\d+(?:\.\d+)?)", re.I)


def parse_size_text(text):
    """统一的尺寸文字解析: 最大尺寸 / 最小尺寸 / 单边 / 第二边 / 三边和 / 围长。"""
    lim = {}
    if not text:
        return lim
    t = text.replace("（", "(").replace("）", ")").replace("＜", "<")
    m = MAXDIM_RE.search(t)
    if m:
        lim["maxDim"] = [float(m.group(1)), float(m.group(2)), float(m.group(3))]
    m = MINDIM_RE.search(t)
    if m:
        lim["minDim"] = [float(m.group(1)), float(m.group(2))]
    lim.update({k: v for k, v in parse_common_limits(t).items() if v is not None})
    # 「其他国家最大尺寸限制：60*40*35cm」这种没写"最大尺寸"前缀的三边
    if "maxDim" not in lim:
        m = re.search(r"尺寸(?:限制)?\s*[:：]\s*(\d+)\s*[*xX×]\s*(\d+)\s*[*xX×]\s*(\d+)", t)
        if m:
            lim["maxDim"] = [float(m.group(1)), float(m.group(2)), float(m.group(3))]
    return lim


def parse_common_limits(text):
    """从一段尺寸描述里抽通用限制。"""
    lim = {}
    t = text.replace("（", "(").replace("）", ")").replace("＜", "<").replace("≤", "<=")

    m = re.search(r"最长边[^0-9]{0,6}(\d+(?:\.\d+)?)", t)
    if m:
        lim["maxSide"] = float(m.group(1))
    if "maxSide" not in lim:
        # 「单边长度＜100CM」「单边不超过120CM」「单边长不超过120CM」
        m = re.search(r"单边(?:长度|长)?\s*(?:不超(?:过)?[^0-9]{0,2}|[≤<])?"
                      r"(\d+(?:\.\d+)?)\s*(?:CM|cm)", t)
        if m:
            lim["maxSide"] = float(m.group(1))
    m = re.search(r"第二边(?:长|长度)?[^0-9]{0,8}(\d+(?:\.\d+)?)", t)
    if m:
        lim["maxSide2"] = float(m.group(1))
    m = re.search(r"长\s*\+\s*\(?\s*宽\s*\+\s*高\s*\)?\s*\*\s*2\s*(?:<=|<|≤|不超过)?\s*"
                  r"(\d+(?:\.\d+)?)", t)
    if m:
        lim["maxGirth1"] = float(m.group(1))
    m = re.search(r"长\s*\+\s*2\s*\*\s*\(\s*宽\s*\+\s*高\s*\)\s*(?:<=|<|≤)\s*"
                  r"(\d+(?:\.\d+)?)", t)
    if not m:
        m = re.search(r"[Ll]\s*\+\s*2\s*\*\s*\(\s*[Ww宽]\s*\+\s*[Hh高]\s*\)"
                      r"\s*(?:<=|<|≤)\s*(\d+(?:\.\d+)?)", t)
    if m:
        lim["maxGirth1"] = float(m.group(1))
    m = re.search(r"[Ll]\s*\+\s*[Hh]\s*\+\s*[Ww][^0-9]{0,6}(\d+(?:\.\d+)?)", t)
    if m:
        lim["maxSum3"] = float(m.group(1))
    # 「长+宽+高≤60+40+35」要把三个数加起来
    m = re.search(r"长\s*\+\s*宽\s*\+\s*高\s*(?:<=|<|≤)\s*(\d+(?:\.\d+)?)\s*\+\s*"
                  r"(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)", t)
    if m:
        lim["maxSum3"] = float(m.group(1)) + float(m.group(2)) + float(m.group(3))
    else:
        m = re.search(r"长\s*\+\s*宽\s*\+\s*高[^0-9]{0,6}(\d+(?:\.\d+)?)", t)
        if m:
            lim["maxSum3"] = float(m.group(1))
    m = re.search(r"实重[^0-9]{0,6}(\d+(?:\.\d+)?)\s*KG", t, re.I)
    if m:
        lim["maxWt"] = float(m.group(1))
    m = re.search(r"体积\s*[≤<]\s*(\d+(?:\.\d+)?)\s*CBM", t, re.I)
    if m:
        lim["maxVolM3"] = float(m.group(1))
    m = re.search(r"最大体积\s*[＜<]\s*(\d+(?:\.\d+)?)\s*m³", t, re.I)
    if m:
        lim["maxVolM3"] = float(m.group(1))
    return lim


# ---------------------------------------------------------------- 云途
def parse_yuntu(ws):
    """云途: 备注区「尺寸要求」章节, 逐条国家限制。"""
    start = None
    for r in range(1, ws.max_row + 1):
        v = ws.cell(row=r, column=1).value
        if v and isinstance(v, str) and "尺寸要求" in v:
            start = r
            break
    if not start:
        return {}, ""

    lines = []
    for r in range(start + 1, min(start + 60, ws.max_row + 1)):
        v = ws.cell(row=r, column=1).value
        if not v or not str(v).strip():
            continue
        s = str(v).strip()
        if re.match(r"^[一二三四五六七八九十]、", s):     # 下一大章节
            break
        lines.append(s)

    default = {"lim": {}, "sur": []}
    byc = {}
    raw = "\n".join(lines)

    # 默认: 「其他国家最大尺寸限制：60*40*35cm」
    for s in lines:
        if "其他国家" in s and ("最大尺寸" in s or "尺寸限制" in s):
            d = find_dims(s)
            if d:
                default["lim"]["maxDim"] = d
            m = re.search(r"单边(?:长)?不超(?:过)?\s*(\d+)", s)
            if m:
                default["lim"]["maxSide"] = float(m.group(1))

    # 最小尺寸: 「XX最小尺寸：10*15cm」
    for s in lines:
        if "最小尺寸" in s:
            mm = MINDIM_RE.search(s.replace("（", "(").replace("）", ")"))
            if not mm:
                continue
            md = [float(mm.group(1)), float(mm.group(2))]
            for cn in countries_in(s.split("最小尺寸")[0]):
                byc.setdefault(cn, {"lim": {}, "sur": [], "text": ""})
                byc[cn]["lim"].setdefault("minDim", md)

    # 逐条: 只有编号行才算具体国家规则
    for s in lines:
        if not re.match(r"^\d+[.、]", s):
            continue
        cs = countries_in(s)
        if not cs:
            continue
        lim = parse_common_limits(s)
        d = find_dims(s)
        # 「加收150RMB可发最大尺寸：68*43*43」-> 超尺寸档
        mo = re.search(r"加收\s*(\d+(?:\.\d+)?)\s*RMB\s*可发最大尺寸[^0-9]{0,4}"
                       r"(\d+(?:\.\d+)?)\s*[*xX×]\s*(\d+(?:\.\d+)?)\s*[*xX×]\s*(\d+(?:\.\d+)?)", s)
        oversize = None
        if mo:
            oversize = {"fee": float(mo.group(1)),
                        "dim": [float(mo.group(2)), float(mo.group(3)), float(mo.group(4))]}
            # 标准尺寸 = 第一个三边
            if d:
                lim["maxDim"] = d
        elif d:
            lim["maxDim"] = d

        # 一行里有多个国家各自不同尺寸 (「A、B：50*50*50 ; C：120*80*80」)
        segs = [x for x in re.split(r"[;；]", s) if x.strip()]
        per_country_lim = {}
        if len(segs) > 1:
            for seg in segs:
                seg_names = countries_in(seg)
                seg_lim = parse_common_limits(seg)
                seg_d = find_dims(seg)
                if seg_d:
                    seg_lim["maxDim"] = seg_d
                seg_m = re.search(r"单边(?:长)?不超(?:过)?\s*(\d+)", seg)
                if seg_m:
                    seg_lim["maxSide"] = float(seg_m.group(1))
                for n2 in seg_names:
                    if seg_lim:
                        per_country_lim[n2] = seg_lim
        for cn in cs:
            e = byc.setdefault(cn, {"lim": {}, "sur": [], "text": ""})
            use_lim = per_country_lim.get(cn, lim)
            e["lim"].update({k: v for k, v in use_lim.items() if v is not None})
            e["text"] = (e["text"] + " " + s).strip() if e["text"] else s
            if oversize:
                # 超过标准三边但不超过超尺寸三边 -> 加收
                e["sur"].append({
                    "name": "超尺寸附加费",
                    "fee": oversize["fee"],
                    "stack": False,
                    "cond": [{"dim_gt": lim.get("maxDim")}],
                    "note": f"最大 {oversize['dim'][0]:g}*{oversize['dim'][1]:g}*"
                            f"{oversize['dim'][2]:g}cm",
                })
                e["lim"]["altMaxDim"] = oversize["dim"]

    # 全局: 超尺寸附加费 150/票, 异形 150/票
    for s in lines:
        if "超尺寸附加费" in s and "RMB" in s:
            m = re.search(r"超尺寸附加费\s*RMB?\s*(\d+)", s)
            if m:
                default["sur"].append({"name": "超尺寸附加费", "fee": float(m.group(1)),
                                       "stack": False, "cond": [], "manual": True,
                                       "note": "超出标准尺寸但可发时加收"})
        if "异形" in s and "RMB" in s:
            m = re.search(r"(\d+)\s*RMB", s)
            if m:
                default["sur"].append({"name": "异形件处理费", "fee": float(m.group(1)),
                                       "stack": False, "cond": [], "manual": True,
                                       "note": "管状/圆柱/不规则包装, 需人工确认"})
    return {"default": default, "byCountry": byc}, raw


# ---------------------------------------------------------------- 专线 (P/D线, 英/德/美线)
def parse_zhuanxian(ws, lim_col):
    """逐行读: 每个国家行可能带自己的尺寸限制。另取最长的一段作为默认。"""
    byc = {}
    texts = []
    for r in range(1, ws.max_row + 1):
        v = ws.cell(row=r, column=lim_col).value
        if not (v and isinstance(v, str)) or len(v.strip()) < 8:
            continue
        texts.append(v.strip())
        country = None
        for c in (1, 2, 3):
            cv = ws.cell(row=r, column=c).value
            if cv and isinstance(cv, str) and cv.strip() in COUNTRIES:
                country = cv.strip()
                break
        if country:
            byc.setdefault(country, {"lim": {}, "sur": [], "text": ""})
            byc[country]["lim"].update(parse_size_text(v))
            byc[country]["text"] = v.strip()

    longest = max(texts, key=len) if texts else ""
    lim = parse_size_text(longest)
    sur = []
    if "带电无附加费" in longest:
        pass          # 明确写了不加收
    return {"default": {"lim": lim, "sur": sur, "text": longest}, "byCountry": byc}


# ---------------------------------------------------------------- 4PX / 欧洲敏感
def parse_4px(ws, size_col, sur_col):
    byc = {}
    for r in range(1, ws.max_row + 1):
        country = None
        for c in (2, 1):
            v = ws.cell(row=r, column=c).value
            if v and isinstance(v, str) and v.strip() in COUNTRIES:
                country = v.strip()
                break
        if not country:
            continue
        size = ws.cell(row=r, column=size_col).value
        sur = ws.cell(row=r, column=sur_col).value
        e = byc.setdefault(country, {"lim": {}, "sur": [], "text": ""})
        texts = []
        if size and isinstance(size, str):
            texts.append(size)
            e["lim"].update(parse_size_text(size))
        if sur and isinstance(sur, str):
            texts.append(sur)
            # 有些行把尺寸要求写在附加费列 (如「最大尺寸要求：最长边≤120CM」)
            e["lim"].update({k: v for k, v in parse_size_text(sur).items()
                             if v is not None})
            # 有些国家把「最大尺寸要求」写在附加费列
            if "尺寸" in sur:
                e["lim"].update({k: v for k, v in parse_size_text(sur).items()
                                 if k not in e["lim"]})
            m = re.search(r"(?:收费标准|收费)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*RMB\s*/\s*票", sur)
            if m:
                fee = float(m.group(1))
                cond = []
                mm = re.search(r"(\d+)\s*CM?\s*[＜<＝=]?\s*单边\w*\s*[＜<＝=]?\s*(\d+)\s*CM", sur)
                if mm:
                    cond.append({"side_gt": float(mm.group(1))})
                mm = re.search(r"第二边(?:长)?\s*[≥>＝=]\s*(\d+)", sur)
                if mm:
                    cond.append({"side2_ge": float(mm.group(1))})
                mm = re.search(r"长\s*\+\s*宽\s*\+\s*高\s*[＞>]\s*(\d+)", sur)
                if mm:
                    cond.append({"sum3_gt": float(mm.group(1))})
                e["sur"].append({"name": "超尺寸服务费", "fee": fee, "stack": False,
                                 "any": True, "cond": cond,
                                 "note": "超出标准尺寸、在可服务范围内"})
            if "偏远" in sur:
                e["note_remote"] = "偏远地区不接受超尺寸服务"
        if texts:
            e["text"] = "\n".join(texts)
    return {"default": {"lim": {}, "sur": []}, "byCountry": byc}


# ---------------------------------------------------------------- 三态
def parse_santai(ws, lim_col, rows):
    """按行读: 不同国家/分区可能用不同规则。"""
    byc = {}
    for r in rows:
        v = ws.cell(row=r, column=lim_col).value
        if not v or not isinstance(v, str):
            continue
        s = v.strip()
        byc.setdefault("__rows__", []).append({"row": r, "text": s})
    return byc


def build_santai_rules(text):
    """把三态那段尺寸/附加费文字解析成 lim + sur。"""
    lim = {}
    sur = []
    t = text.replace("（", "(").replace("）", ")").replace("＜", "<").replace("＞", ">")
    t = t.replace("≤", "<=").replace("≥", ">=").replace("≦", "<=")

    # 基础不可超限: 「长<175cm, 长+2*宽+2*高<340cm」
    m = re.search(r"长\s*<\s*(\d+(?:\.\d+)?)\s*cm", t, re.I)
    if m:
        lim["maxSide"] = float(m.group(1))
    m = re.search(r"长\s*\+\s*2\s*\*\s*宽\s*\+\s*2\s*\*\s*高\s*<\s*(\d+(?:\.\d+)?)", t)
    if m:
        lim["maxGirth2"] = float(m.group(1))

    # 附加费档: 两种写法都要接
    #   「1）…，收取附加费50RMB/票」     数字在前
    #   「(1) …，加收超长附加费RMB 80/票」 数字在后
    seg_re = re.compile(r"(\d)\s*[)）]\s*([^；;]*?)(?=；|;|\n\d\s*[)）]|\n\s*\(\d\)|$)", re.S)
    for m in seg_re.finditer(t):
        cond_text = m.group(2)
        fm = re.search(r"附加费\s*(\d+(?:\.\d+)?)\s*RMB", cond_text)
        if not fm:
            fm = re.search(r"附加费\s*RMB\s*(\d+(?:\.\d+)?)", cond_text)
        if not fm:
            continue
        fee = float(fm.group(1))
        cond = []
        mm = re.search(r"重量\s*>\s*(\d+(?:\.\d+)?)\s*KG", cond_text, re.I)
        if mm:
            cond.append({"weight_gt": float(mm.group(1))})
        mm = re.search(r"最长边\s*>\s*(\d+(?:\.\d+)?)", cond_text)
        if mm:
            cond.append({"side_gt": float(mm.group(1))})
        mm = re.search(r"其他边任意一边\s*>\s*(\d+(?:\.\d+)?)", cond_text)
        if mm:
            cond.append({"other_side_gt": float(mm.group(1))})
        mm = re.search(r"最长边\s*\+\s*2\s*\*\s*\(\s*次长边\s*\+\s*最短边\s*\)\s*>\s*(\d+(?:\.\d+)?)",
                       cond_text)
        if mm:
            cond.append({"girth2_gt": float(mm.group(1))})
        mm = re.search(r"长\s*\+\s*\(\s*宽\s*\+\s*高\s*\)\s*\*\s*2\s*>\s*(\d+(?:\.\d+)?)", cond_text)
        if mm:
            cond.append({"girth1_gt": float(mm.group(1))})
        mm = re.search(r"长\s*\+\s*宽\s*\*\s*2\s*\+\s*高\s*\*\s*2\s*>\s*(\d+(?:\.\d+)?)", cond_text)
        if mm:
            cond.append({"girth1_gt": float(mm.group(1))})
        if cond:
            # 原文用「或」连接 -> 任一满足即收费
            sur.append({"name": f"超长附加费({m.group(1)})", "fee": fee, "stack": False,
                        "any": True, "cond": cond, "note": "任一条件满足即收, 多项不叠加取最高"})

    # 「超尺寸附加费标准：440RMB/件」
    m = re.search(r"超尺寸附加费标准\s*[:：]\s*(\d+(?:\.\d+)?)\s*RMB", t)
    if m:
        lim["oversizeFee"] = float(m.group(1))
    # 可接受最大: 295<长+2*宽+2*高<=340 / 170<最长边<=240
    m = re.search(r"可接受最大尺寸[^\d]{0,10}(\d+)\s*cm\s*<\s*长\s*\+\s*2\s*\*\s*宽\s*\+\s*2\s*\*\s*高"
                  r"\s*<=\s*(\d+)\s*cm", t)
    if m and lim.get("oversizeFee"):
        sur.append({"name": "超尺寸附加费", "fee": lim["oversizeFee"], "stack": True,
                    "cond": [{"girth2_gt": float(m.group(1))}],
                    "note": "超大包裹附加费叠加收取"})
    m = re.search(r"(\d+)\s*cm\s*<\s*最长边\s*<=\s*(\d+)\s*cm", t)
    if m and lim.get("oversizeFee"):
        sur.append({"name": "超尺寸附加费", "fee": lim["oversizeFee"], "stack": True,
                    "cond": [{"side_gt": float(m.group(1))}],
                    "note": "超大包裹附加费叠加收取"})

    # 三态特惠专线: 「最大尺寸限制：60*45*40cm」+「尺寸≥55*45*35cm 产生105RMB/件」
    m = re.search(r"最大尺寸限制\s*[:：]\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)", t)
    if m:
        lim["maxDim"] = [float(m.group(1)), float(m.group(2)), float(m.group(3))]
    m = re.search(r"最小尺寸限制\s*[:：]\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)", t)
    if m:
        lim["minDim"] = [float(m.group(1)), float(m.group(2)), float(m.group(3))]
    m = re.search(r"当尺寸\s*>=?\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)\s*cm\s*时[^0-9]{0,12}"
                  r"(\d+(?:\.\d+)?)\s*RMB", t)
    if m:
        sur.append({"name": "超尺附加费", "fee": float(m.group(4)), "stack": False,
                    "cond": [{"dim_ge": [float(m.group(1)), float(m.group(2)),
                                         float(m.group(3))]}],
                    "note": "达到该尺寸即加收"})
    m = re.search(r"异形附加费[^0-9]{0,40}?(\d+(?:\.\d+)?)\s*RMB", t)
    if m:
        sur.append({"name": "异形件附加费", "fee": float(m.group(1)), "stack": False,
                    "cond": [], "manual": True, "note": "管状/圆柱体以外不接"})

    # 三边和分档: 「三边和(L+W+H)，在160CM(含)到220CM(含)时收取100RMB」
    for m in re.finditer(r"在\s*(\d+)\s*CM\s*\(?含?\)?\s*到\s*(\d+)\s*CM\s*\(?含?\)?\s*时收取"
                         r"\s*(\d+(?:\.\d+)?)\s*RMB", t):
        sur.append({"name": "超尺附加费", "fee": float(m.group(3)), "stack": False,
                    "cond": [{"sum3_gt": float(m.group(1)) - 0.001}],
                    "note": f"三边和 {m.group(1)}–{m.group(2)}cm"})
    # 木箱/托盘 +2元/kg
    m = re.search(r"木箱/托盘包装[，,]?\s*加收\s*(\d+(?:\.\d+)?)\s*元/kg", t)
    if m:
        sur.append({"name": "木箱/托盘包装", "fee_per_kg": float(m.group(1)), "stack": True,
                    "cond": [], "manual": True, "note": "木箱/托盘包装加收, 时效晚一天"})
    # 体积重/实重 > 8:1
    m = re.search(r"体积重[^。]{0,60}?与实重之比大于\s*(\d+)\s*[:：]\s*1\s*时[，,]?\s*"
                  r"加收\s*(\d+(?:\.\d+)?)\s*RMB", t)
    if m:
        sur.append({"name": "超大件附加费", "fee": float(m.group(2)), "stack": True,
                    "cond": [{"vol_ratio_gt": float(m.group(1))}], "note": "泡货比超过该倍数"})
    # 旺季附加费 (有截止日期)
    m = re.search(r"加收旺季附加费\s*RMB\s*(\d+)\s*/\s*票[，,]?\s*截止日期到\s*([\d年月日]+)", t)
    if m:
        sur.append({"name": "旺季附加费", "fee": float(m.group(1)), "stack": True,
                    "cond": [], "manual": True, "until": m.group(2),
                    "note": f"旺季附加费, 截止 {m.group(2)}"})
    return lim, sur


CN_PREFIX = re.compile(r"^([\u4e00-\u9fa5、，,和/（）()\s]{1,80}?)\s*[:：]\s*(.*)$")


def parse_generic(ws, row_limit=140):
    """兜底解析。只认明确句式, 宁可少解析也不猜 —— 猜错的限制会错误拦截正常包裹。

    认可句式:
      最大尺寸(限制)：A*B*C / 尺寸(限制)：A*B*C / 尺寸不超过A*B*C
      最小尺寸(限制)：A*B / 尺寸不小于A*B
      最长边(不超过|≤)Ncm
      长+宽+高(不超过|≤)Ncm
      三边之和(不超过|≤)Ncm
      单件重量≤N KG
      160-180cm：+80元/票  (分档加收)
    """
    byc = {}
    lines = []
    for r in range(1, min(ws.max_row + 1, row_limit)):
        for c in range(1, min(ws.max_column + 1, 20)):
            v = ws.cell(row=r, column=c).value
            if isinstance(v, str) and len(v.strip()) >= 6:
                for ln in v.split("\n"):
                    if ln.strip():
                        lines.append(ln.strip())

    def norm(s):
        return (s.replace("（", "(").replace("）", ")").replace("＜", "<")
                 .replace("≤", "<=").replace("不小于", ">="))

    def parse_one(text):
        lim, sur = {}, []
        t2 = norm(text)

        m = re.search(r"(?:最大)?尺寸(?:限制)?\s*[:：]?\s*"
                      r"(\d+(?:\.\d+)?)\s*(?:CM|cm)?\s*[*xX×]\s*"
                      r"(\d+(?:\.\d+)?)\s*(?:CM|cm)?\s*[*xX×]\s*"
                      r"(\d+(?:\.\d+)?)", t2)
        if m:
            lim["maxDim"] = [float(m.group(1)), float(m.group(2)), float(m.group(3))]
        m = re.search(r"尺寸不超过\s*(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)\s*\*\s*"
                      r"(\d+(?:\.\d+)?)", t2)
        if m:
            lim["maxDim"] = [float(m.group(1)), float(m.group(2)), float(m.group(3))]
        m = re.search(r"最小尺寸(?:限制|要求)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:CM|cm)?\s*[*xX×]\s*"
                      r"(\d+(?:\.\d+)?)", t2)
        if m:
            lim["minDim"] = [float(m.group(1)), float(m.group(2))]
        m = re.search(r"最长边(?:不超过|<=|<)\s*(\d+(?:\.\d+)?)\s*cm", t2, re.I)
        if m:
            lim["maxSide"] = float(m.group(1))
        m = re.search(r"长\s*\+\s*宽\s*\+\s*高(?:不超过|<=|<)\s*(\d+(?:\.\d+)?)", t2)
        if m:
            lim["maxSum3"] = float(m.group(1))
        m = re.search(r"三边之和\s*(?:不超过|<=|<)\s*(\d+(?:\.\d+)?)\s*cm", t2)
        if m:
            lim["maxSum3"] = float(m.group(1))
        m = re.search(r"单件重量\s*(?:<=|<)\s*(\d+(?:\.\d+)?)\s*KG", t2, re.I)
        if m:
            lim["maxWt"] = float(m.group(1))

        # 分档: 「160-180cm：+80元/票」
        for lo, hi, fee in re.findall(
                r"(\d+)\s*[-–]\s*(\d+)\s*cm\s*[:：]\s*\+?\s*(\d+(?:\.\d+)?)\s*元", t2):
            sur.append({"name": f"超规格({lo}-{hi}cm)", "fee": float(fee), "stack": False,
                        "cond": [{"sum3_gt": float(lo) - 0.001, "sum3_lte": float(hi)}],
                        "note": "三边和超出标准, 按档加收"})

        # 明确写「附加费N元/票」的, 记为人工项
        for mm in re.finditer(r"([\u4e00-\u9fa5]{2,6}附加费)\s*(\d+(?:\.\d+)?)\s*元\s*/\s*票", t2):
            sur.append({"name": mm.group(1), "fee": float(mm.group(2)), "stack": True,
                        "cond": [], "manual": True, "note": "满足条件时收取, 需人工判断"})
        return lim, sur

    for ln in lines:
        m = CN_PREFIX.match(ln)
        if not m:
            continue
        head, body = m.group(1).strip(), m.group(2)
        names = [x.strip() for x in re.split(r"[、，,和/]", head) if x.strip() in COUNTRIES]
        if not names:
            continue
        if not any(k in body for k in ("尺寸", "附加费", "超长", "限制", "加收", "超区")):
            continue
        lim, sur = parse_one(body)
        if not lim and not sur:
            continue
        for cn in names:
            e = byc.setdefault(cn, {"lim": {}, "sur": [], "text": ""})
            e["lim"].update(lim)
            e["sur"].extend(sur)
            e["text"] = (e["text"] + "\n" + ln).strip()

    # 无国家前缀的整段
    all_text = "\n".join(lines)
    all_sur = []
    for ln in lines:
        _, s2 = parse_one(ln)
        all_sur.extend(s2)
    # 整表没有逐国规则时 (单一国家渠道), 把整段的明确句式当作默认限制
    dlim = {}
    if not byc:
        dlim, _ = parse_one(all_text)
    default = {"lim": dlim, "sur": all_sur, "text": all_text[:400]}
    return {"default": default, "byCountry": byc}


def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    out = {}

    for sn in wb.sheetnames:
        s = sn.strip()
        if s in SKIP:
            continue
        ws = wb[sn]
        rec = None

        if s.startswith("云途"):
            rec, _ = parse_yuntu(ws)
        elif s in ("欧盟P线", "欧盟D线"):
            rec = parse_zhuanxian(ws, 12)                 # L 列尺寸限制
        elif s == "英国专线":
            rec = parse_zhuanxian(ws, 7)                  # G 列
        elif s == "德国专线":
            rec = parse_zhuanxian(ws, 7)
        elif s == "美国Ⅱ号线":
            rec = parse_zhuanxian(ws, 8)                  # H 列
        elif s == "4PX全球专线特快-普货":
            rec = parse_4px(ws, 5, 6)
        elif s == "4PX全球专线特快-带电":
            rec = parse_4px(ws, 6, 7)
        elif s == "欧洲敏感专线-E":
            rec = parse_4px(ws, 6, 7)
        elif s in ("三态重货-普货", "三态中包-普货", "三态专选"):
            rec = {"default": {"lim": {}, "sur": []}, "byCountry": {}}
            seen = set()
            for r in range(1, min(8, ws.max_row + 1)):
                v = ws.cell(row=r, column=8).value
                if v and isinstance(v, str) and v not in seen:
                    seen.add(v)
                    lim, sur = build_santai_rules(v)
                    # 「英国：长<175cm…」这种以国家名开头的, 归到该国家
                    lead = v.split("：")[0].split(":")[0].strip()
                    if lead in COUNTRIES:
                        rec["byCountry"][lead] = {"lim": lim, "sur": sur, "text": v}
                    elif r == 3:
                        rec["default"] = {"lim": lim, "sur": sur, "text": v}
                    else:
                        rec.setdefault("__alt", []).append({"lim": lim, "sur": sur,
                                                            "text": v})
        elif s in ("三态特惠专线（普货）", "三态美国中包（带电）",
                   "三态免泡大货专线（带电）", "三态免泡大货专线（普货）"):
            rec = {"default": {"lim": {}, "sur": []}, "byCountry": {}}
            for r in range(1, min(8, ws.max_row + 1)):
                v = ws.cell(row=r, column=8).value
                if v and isinstance(v, str):
                    lim, sur = build_santai_rules(v)
                    # 走「三态重货」那套通用解析
                    if not rec["default"]["lim"] and not rec["default"]["sur"]:
                        rec["default"] = {"lim": lim, "sur": sur, "text": v}
        else:
            # 义速宝 / 亚马逊 / 4PX商派: 走通用文本解析
            rec = parse_generic(ws)

        out[s] = rec

    # 三态的 "超长附加费" 解析可能漏掉第二种写法, 统一兜底
    for s, rec in out.items():
        if not s.startswith("三态"):
            continue
        for blk in [rec.get("default")] + rec.get("__alt", []):
            if not blk:
                continue
            t = blk.get("text") or ""
            if t and not blk["sur"]:
                lim, sur = build_santai_rules(t)
                blk["lim"].update({k: v for k, v in lim.items() if v is not None})
                blk["sur"] = sur

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    print(f"written {OUT}")
    for s, rec in out.items():
        d = rec.get("default", {})
        nb = len(rec.get("byCountry", {}))
        print(f"  {s:34s} 默认限制{len(d.get('lim',{}))}项 "
              f"附加费{len(d.get('sur',[]))}条 逐国{nb}")


if __name__ == "__main__":
    main()
