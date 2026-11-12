"""
把「费率库」(报价表) + 「定价规则」(物流定价计算器) 合并成网站数据。

两份表的渠道命名不同, 需要映射:
  报价表 channel 名              ->  原表 channel
  云途全球专线挂号（特惠普货）    ->  云途 / 云途小包
  云途全球专线挂号（特惠带电）    ->  云途 / 云途小包
  云途全球专线挂号（标快普货）    ->  云途 / 云途小包
  云途全球服装专线挂号            ->  云途 / 云途小包
  云途全球化妆品类专线挂号        ->  云途 / 云途小包
  云途全球泡货专线挂号(特惠普货)  ->  云途 / 云途小包
  云途岛屿专线（特惠普货）        ->  云途 / 云途小包
  云途商派专线（特惠普货）        ->  云途 / 云途小包
  三态重货-普货                  ->  三态 / 三态重货
  三态中包-普货                  ->  三态 / 三态重货
  三态专选                      ->  三态 / 三态重货
  三态免泡大货专线（普货）        ->  三态 / 三态重货
  三态特惠专线（普货）            ->  三态 / 三态重货
  三态美国中包（带电）            ->  三态 / 三态重货
  欧盟P线 / 欧盟D线 / 英国专线 / 德国专线 / 美国Ⅱ号线 -> 杰航 / 对应专线
  4PX全球专线特快-普货/带电      ->  递四方
  4PX美国商派专线-普货           ->  递四方
  义速宝全球特惠专线BS(普货)     ->  YDH义速宝
  亚马逊义速宝全球快捷(普货/带电)->  YDH义速宝
  金马/美森 各专线                ->  (原表没有, 走纯费率库)

定价规则只对「原表有的渠道」生效; 其余渠道走报价表费率库。
"""
import os
import json
import sys
import os, os, collections

WEB = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(WEB, "data.json")
# 定价规则: 优先用公开脱敏版 (公式骨架, 价格已清零), 有完整版就用完整版。
# 公开版进 GitHub 仓库, 完整版只留在服务器 —— 网站按报价表取价, 两者结果一致。
RULES_CANDIDATES = ["calc_rules_public.json", "calc_rules.json"]
RULES = next((os.path.join(WEB, c) for c in RULES_CANDIDATES
              if os.path.exists(os.path.join(WEB, c))), os.path.join(WEB, RULES_CANDIDATES[0]))
OUT = os.path.join(WEB, "data_v2.js")

# 报价表渠道 -> (原表渠道, 原表小节)
CHANNEL_MAP = [
    ("云途全球专线挂号（特惠普货）", "云途", "云途小包"),
    ("云途全球专线挂号（特惠带电）", "云途", "云途小包"),
    ("云途全球泡货专线挂号(特惠普货)", "云途", "云途小包"),
    ("三态重货-普货", "三态", "三态重货"),
    ("三态中包-普货", "三态", "三态重货"),
    ("三态专选", "三态", "三态重货"),
    ("三态免泡大货专线（普货）", "三态", "三态重货"),
    ("三态免泡大货专线（带电）", "三态", "三态重货"),
    ("三态特惠专线（普货）", "三态", "三态重货"),
    ("三态美国中包（带电）", "三态", "三态重货"),
    ("欧盟P线", "杰航", "欧盟P线"),
    ("欧盟D线", "杰航", "欧盟D线"),
    ("英国专线", "杰航", "英国专线"),
    ("德国专线", "杰航", "德国专线"),
    ("美国Ⅱ号线", "杰航", "美国专线"),
    ("4PX全球专线特快-普货", "递四方", "递四方"),
    ("4PX全球专线特快-带电", "递四方", "递四方"),
    ("4PX美国商派专线-普货", "递四方", "递四方"),
    ("义速宝全球特惠专线BS(普货)", "YDH义速宝", "YDH"),
    ("亚马逊义速宝全球快捷(普货)", "YDH义速宝", "YDH"),
    ("亚马逊义速宝全球快捷(带电)", "YDH义速宝", "YDH"),
]


DIVR = os.path.join(WEB, "div_rules.json")
SURR = os.path.join(WEB, "surcharges.json")
SRC_XLSX = (r"C:\Users\Administrator\AppData\Local\hermes\attachments"
             r"\广州市盛途科技渠道整合报价-2026-10-26-2.xlsx")
# ---- 数据源: 由 更新报价.py 写入 源文件路径.txt ----
_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "源文件路径.txt")
if os.path.exists(_CFG):
    SRC_XLSX = open(_CFG, encoding="utf-8").read().strip()



sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from div_apply import apply_div  # noqa: E402


def main():
    data = json.load(open(DATA, encoding="utf-8"))
    if not os.path.exists(RULES):
        print("缺定价规则文件: %s" % " / ".join(RULES_CANDIDATES), file=sys.stderr)
        return 9
    rules = json.load(open(RULES, encoding="utf-8"))
    print("定价规则: %s (%d 条)" % (os.path.basename(RULES), len(rules)))
    divrules = json.load(open(DIVR, encoding="utf-8")) if os.path.exists(DIVR) else {}
    surrules = json.load(open(SURR, encoding="utf-8")) if os.path.exists(SURR) else {}

    # ---- 规则按 (渠道, 小节, 国家, 分区) 索引 ----
    # zone 统一归一化: 空 -> "-"  (报价表用 "-", 原表用 "")
    def nz(z):
        """分区归一化: 空 -> "-"; "一区" -> "1区" (原表中文数字 vs 报价表阿拉伯数字)。"""
        z = (z or "").strip()
        if not z:
            return "-"
        return z.replace("一区", "1区").replace("二区", "2区") \
                .replace("三区", "3区").replace("四区", "4区") \
                .replace("五区", "5区").replace("六区", "6区")

    # 国家名归一化: 原表用简称, 报价表用全称
    ALIAS = {"沙特": "沙特阿拉伯"}

    def nc(c):
        c = (c or "").strip()
        return ALIAS.get(c, c)

    rule_idx = {}
    untrusted = 0
    for r in rules:
        r["zone"] = nz(r["zone"])
        # 原表公式引用了非输入行的规则不可信 (复制粘贴错误), 不用于计算
        if r.get("trusted") is False:
            untrusted += 1
            continue
        key = f"{r['channel']}|{r['section']}|{nc(r['country'])}|{r['zone']}"
        rule_idx[key] = r
    print("规则", len(rule_idx), "条 (剔除不可信", untrusted, "条)")

    # ---- 只保留当前报价表里存在的渠道 (防止旧数据残留) ----
    src_sheets = set()
    if os.path.exists(SRC_XLSX):
        import openpyxl as _ox
        _wb = _ox.load_workbook(SRC_XLSX, read_only=True, data_only=True)
        src_sheets = {n.strip() for n in _wb.sheetnames}
        _wb.close()
    if src_sheets:
        before = len(data["groups"])
        data["groups"] = [g for g in data["groups"] if g["sheet"] in src_sheets]
        data["tiers"] = [t for t in data["tiers"] if t["sheet"] in src_sheets]
        # 国家列表也按剩下的渠道重算
        keep = {g["country"] for g in data["groups"]}
        data["countries"] = [c for c in data["countries"] if c["name"] in keep]
        print(f"渠道过滤: {before} -> {len(data['groups'])} 组 "
              f"(报价表 {len(src_sheets)} sheet)")

    # ---- 逐国体积重除数 (共用逻辑: 脚本/div_apply.py) ----
    divcount, uncertaint = apply_div(data["groups"], divrules, rules=data.get("rules"))
    print(f"逐国体积除数 覆盖 {divcount} 组, 标记不确定 {uncertaint} 组")

    # ---- 币种标注 (仅供参考; 报价表与原计算器全部以人民币计价) ----
    CUR = {"美国": "USD", "加拿大": "CAD", "墨西哥": "MXN", "澳大利亚": "AUD",
           "英国": "GBP", "沙特阿拉伯": "SAR", "阿联酋": "AED"}
    for g in data["groups"]:
        g["currency"] = CUR.get(g["country"], "EUR")
        g["fx"] = 0          # 0 = 不做货币换算, 由用户按当天汇率手填

    # ---- 尺寸限制 + 附加费 (来自报价表逐国说明) ----
    # 报价表里同一个国家有多种写法, 查表时逐个试
    CTRY_ALIAS = {
        "沙特阿拉伯": ["沙特阿拉伯", "沙特"],
        "阿联酋": ["阿联酋", "阿拉伯联合酋长国", "阿拉伯联合大公国"],
    }
    limcount = surcount = 0
    for g in data["groups"]:
        rec = surrules.get(g["sheet"])
        if not rec:
            continue
        bcs = rec.get("byCountry", {})
        bc = None
        # 优先取有实际内容的别名项 (有些别名项是空壳)
        for nm in CTRY_ALIAS.get(g["country"], [g["country"]]):
            hit = bcs.get(nm)
            if hit and (hit.get("lim") or hit.get("sur")):
                bc = hit
                break
        if bc is None:
            for nm in CTRY_ALIAS.get(g["country"], [g["country"]]):
                if nm in bcs:
                    bc = bcs[nm]
                    break
        dflt = rec.get("default") or {}
        lim = {}
        sur = []
        if bc:
            lim.update(bc.get("lim") or {})
            sur.extend(bc.get("sur") or [])
        if not bc or not bc.get("lim"):
            lim.update(dflt.get("lim") or {})
        if not bc or not bc.get("sur"):
            sur.extend(dflt.get("sur") or [])
        # 同一渠道的 alt 规则也并进来 (三态的第二个表头块)
        for alt in rec.get("__alt") or []:
            lim.update({k: v for k, v in (alt.get("lim") or {}).items() if k not in lim})
            sur.extend(alt.get("sur") or [])
        # 去重
        seen = set()
        uniq = []
        for s in sur:
            k = (s.get("name"), s.get("fee"))
            if k in seen:
                continue
            seen.add(k)
            uniq.append(s)
        if lim:
            g["lim"] = lim
            limcount += 1
        if uniq:
            g["sur"] = uniq
            surcount += 1
    print(f"尺寸限制 覆盖 {limcount} 组, 附加费 覆盖 {surcount} 组")

    # ---- 给每个渠道组打上 ruleKey ----
    mapped = 0
    unmapped = collections.Counter()
    for g in data["groups"]:
        hit = None
        gzone = nz(g["zone"])
        for qname, ch, sec in CHANNEL_MAP:
            if g["sheet"] == qname:
                key = f"{ch}|{sec}|{nc(g['country'])}|{gzone}"
                if key in rule_idx:
                    hit = rule_idx[key]
                break
        if hit:
            g["ruleKey"] = f"{hit['channel']}|{hit['section']}|{nc(hit['country'])}|{nz(hit['zone'])}"
            g["ruleType"] = hit["type"]
            g["srcChannel"] = hit["channel"]
            g["srcSection"] = hit["section"]
            mapped += 1
        else:
            g["ruleKey"] = None
            unmapped[g["sheet"]] += 1

    print(f"组 {len(data['groups'])}, 匹配到定价规则 {mapped}, 未匹配 {sum(unmapped.values())}")
    for k, v in unmapped.most_common():
        print(f"   无规则: {k:34s} {v} 组")

    # ---- 输出 ----
    payload = dict(data)
    payload["rules"] = list(rule_idx.values())
    payload["divRules"] = divrules
    # ---- 元信息: 渠道清单 + 正确的数据源名 ----
    from collections import Counter as _C
    _cnt = _C(g["sheet"] for g in data["groups"])
    payload["meta"] = dict(data.get("meta", {}))
    payload["meta"].update(
        source="广州市盛途科技渠道整合报价-2026-10-26-2.xlsx",
        channels=len(_cnt),
        groups=len(data["groups"]),
        tiers=len(data["tiers"]),
        countries=len(data["countries"]),
        countriesAll=len({g["country"] for g in data["groups"]}),
        channelList=[dict(sheet=s, groups=n,
                          attr=sorted({g.get("attr") or "通用"
                                       for g in data["groups"] if g["sheet"] == s}))
                     for s, n in sorted(_cnt.items(), key=lambda x: (-x[1], x[0]))],
    )
    payload["meta"]["rules"] = len(rule_idx)
    payload["meta"]["mapped"] = mapped
    payload["meta"]["source2"] = "物流定价计算器.xlsx"

    js = "window.DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";"
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)
    print("written", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
