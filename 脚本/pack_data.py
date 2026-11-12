"""
把报价表打包成网站用的 JSON。

数据源:
  rates_raw.json     —— 通用渠道抽取结果 (云途/三态/4PX/义速宝/金马/美森等)
  divider_rates.json —— 专线抽取结果 (欧盟P/D线、英国/德国专线、美国Ⅱ号线)

只保留目标国家。
"""
import os
import json
import os, os

SRC_DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")

# 国家白名单不再硬编码: 报价表里有的国家全部保留 (用户要求"只按表上有的渠道计算",
# 渠道不能因为国家不在常用列表就被丢掉)。
# ORDER 只是排序偏好 —— 用户常用的 15 国排前面, 其余按报价表出现顺序追加。
PREFERRED = ["美国", "加拿大", "墨西哥", "澳大利亚", "英国", "法国", "德国",
             "意大利", "西班牙", "比利时", "波兰", "瑞典", "爱尔兰",
             "沙特阿拉伯", "阿联酋"]
# 报价表里出现的别名 -> 规范名
ALIAS = {"沙特": "沙特阿拉伯", "沙特阿拉伯": "沙特阿拉伯"}
ORDER = []          # 运行期按实际覆盖情况填
TARGET = {}         # name -> label

CUR = {"美国": "USD", "加拿大": "CAD", "墨西哥": "MXN", "澳大利亚": "AUD",
       "英国": "GBP", "沙特阿拉伯": "SAR", "阿联酋": "AED"}
DIV_SHEETS = {"欧盟P线", "欧盟D线", "英国专线", "德国专线", "美国Ⅱ号线"}


def sheet_attr(sheet):
    """从渠道名判断属性: 含"带电"=带电, 含"普货"=普货, 否则通用(两种都接)。"""
    s = sheet or ""
    if "带电" in s:
        return "带电"
    if "普货" in s:
        return "普货"
    return ""


def dedupe_bands(tiers):
    items = [t for t in tiers if t.get("band")]
    if not items:
        return []
    items = sorted(items, key=lambda t: (t["band"][0], t["band"][1]))
    out = []
    for i, t in enumerate(items):
        lo, hi = t["band"]
        if i + 1 < len(items):
            nxt = items[i + 1]["band"][0]
            if nxt <= hi:
                hi = nxt - 0.001
        if hi < lo:
            hi = lo
        out.append(dict(t, band=[lo, hi]))
    return out


def main():
    rates = json.load(open(os.path.join(SRC_DIR, "rates_raw.json"), encoding="utf-8"))
    divrates = json.load(open(os.path.join(SRC_DIR, "divider_rates.json"), encoding="utf-8"))

    tiers = []      # 费率档
    groups = []     # 渠道组
    seen = set()

    def add_group(sheet, country, zone, line, mode, div, lead, limits, attr=""):
        key = (sheet, country, zone, line, attr)
        if key in seen:
            return
        seen.add(key)
        groups.append(dict(sheet=sheet, country=country, zone=zone, line=line,
                           attr=attr, mode=mode, div=div, cur=CUR.get(country, "EUR"),
                           lead=lead or "", limits=limits or ""))

    # ---- 通用渠道 ----
    for ch in rates["channels"]:
        sheet = ch["sheet"].strip()
        if sheet in DIV_SHEETS:
            continue
        for ctry in ch["countries"]:
            cn = (ctry["country"] or "").strip()
            cn = ALIAS.get(cn, cn)
            if not cn:
                continue
            # 国家名里混了分区 (如 "澳大利亚/2区") -> 拆成 国家 + 分区
            mzone = None
            if "/" in cn and "区" in cn:
                cn2, _, zpart = cn.partition("/")
                cn, mzone = cn2.strip(), zpart.strip()
            zone = (mzone or ctry.get("zone") or "-").strip()
            lead = ctry.get("lead") or ""
            limits = ctry.get("limits") or ""
            has_band = bool(ctry["tiers"])
            has_fn = bool(ctry.get("fn_tiers"))
            if has_band:
                for t in dedupe_bands(ctry["tiers"]):
                    lo, hi = t["band"]
                    tiers.append(dict(sheet=sheet, country=cn, zone=zone, line="-",
                                      attr=sheet_attr(sheet) or ctry.get("attr") or "",
                                      mode="band", lo=lo, hi=hi, price=t["price"],
                                      fee=t.get("fee"), nextkg=None,
                                      first_kg=None, next_kg=None))
                add_group(sheet, cn, zone, "-", "band", 6000, lead, limits,
                          attr=sheet_attr(sheet) or ctry.get("attr") or "")
            if has_fn:
                for t in dedupe_bands(ctry.get("fn_tiers", [])):
                    lo, hi = t["band"] if t.get("band") else (0.0, 999.0)
                    tiers.append(dict(sheet=sheet, country=cn, zone=zone, line="-",
                                      attr=sheet_attr(sheet) or ctry.get("attr") or "",
                                      mode="firstnext", lo=lo, hi=hi, price=t.get("first"),
                                      fee=ctry.get("fee"), nextkg=t.get("nextkg"),
                                      first_kg=ctry.get("first_kg"), next_kg=ctry.get("next_kg")))
                add_group(sheet, cn, zone, "-", "firstnext", 6000, lead, limits,
                          attr=sheet_attr(sheet) or ctry.get("attr") or "")

    # ---- 专线 (三条产品线各自成组) ----
    for x in divrates:
        cn = (x["country"] or "").strip()
        cn = ALIAS.get(cn, cn)
        if not cn:
            continue
        sheet = x["sheet"]
        line = x["line"]
        tiers.append(dict(sheet=sheet, country=cn, zone="-", line=line,
                          mode="divider", lo=x["lo"], hi=x["hi"], price=x["price"],
                          fee=x.get("fee"), nextkg=None, first_kg=None, next_kg=None))
        add_group(sheet, cn, "-", line, "divider", x["div"], "", x.get("limits"))

    groups.sort(key=lambda g: (ORDER.index(g["country"]) if g["country"] in ORDER else 99,
                                g["sheet"], g["line"], g["zone"]))
    tiers.sort(key=lambda t: (t["sheet"], t["country"], t["line"], t["lo"]))

    covered = sorted({g["country"] for g in groups},
                     key=lambda c: ORDER.index(c) if c in ORDER else 99)
    missing = [c for c in ORDER if c not in covered]

    payload = {
        # 下拉只列用户日常使用的国家; groups/tiers 保留报价表全部国家, 便于扩展
        "countries": [dict(name=c, label=c) for c in PREFERRED if c in covered],
        "groups": groups,
        "tiers": tiers,
        "meta": {
            "source": "广州市盛途科技渠道整合报价-2026-10-26.xlsx",
            "channels": len({g["sheet"] for g in groups}),
            "groups": len(groups),
            "tiers": len(tiers),
            "countries": len(covered),
            "missing": missing,
        },
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    print(f"国家 {len(covered)}  渠道组 {len(groups)}  费率档 {len(tiers)}  "
          f"渠道 {payload['meta']['channels']}")
    print("缺报价:", missing if missing else "无")
    for c in covered:
        n = len([g for g in groups if g["country"] == c])
        print(f"   {c:8s} {n:2d} 个渠道组")
    print("written", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
