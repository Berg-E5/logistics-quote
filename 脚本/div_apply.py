#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
体积重除数的应用逻辑 —— merge_data.py 和 patch_divs.py 共用这一份,
免得两处逻辑漂移。

规则 (用户定的):
    1. sheet 备注区 写的逐国除数  -> 用它
    2. sheet 备注区 没有、但总目录写了 -> 用总目录的
    3. 两处都没有 -> 标「不确定」(countryDivUncertain), 不用硬编码值兜底
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# 专线 (欧盟P/D线等) 与泡货产品线有自己固定的除数, 不套用逐国规则
SKIP_SHEETS = ("云途全球泡货专线挂号(特惠普货)",)


def load_div_rules(path=None):
    p = path or os.path.join(HERE, "div_rules.json")
    if not os.path.exists(p):
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _has_normal_rule(g, rulemap):
    """这个组有没有可用的原计算器渠道除数 (rule.type == 'normal' 且 rule.div)。"""
    rk = g.get("ruleKey")
    if not rk:
        return None
    r = rulemap.get(tuple(rk.split("|")))
    if r and r.get("type") == "normal" and r.get("div"):
        return r
    return None


def apply_div(groups, divrules, rules=None, keep_existing=False):
    """就地给 groups 打 countryDiv / countryDivSrc / countryDivUncertain。

    只动除数相关的字段, 价格和档位一律不碰。

    keep_existing=True  (就地修补已有数据时用):
        新规则给不出值时, 保留数据里原有的 countryDiv。
        理由: 那些值是更早一版从报价表正确抽出来的, 不该被降级成「不确定」。
    keep_existing=False (全新抽取时用):
        给不出值就标「不确定」, 不用硬编码值兜底。

    返回 (命中数, 不确定数)
    """
    hit = 0
    uncertain = 0
    rulemap = {}
    for r in (rules or []):
        rulemap[(r.get("channel"), r.get("section"), r.get("country"), r.get("zone"))] = r
    for g in groups:
        prev_div = g.get("countryDiv")
        prev_src = g.get("countryDivSrc")
        # 清掉上一轮的结果 (keep_existing 时先留着原值)
        g.pop("countryDiv", None)
        g.pop("countryDivSrc", None)
        g.pop("countryDivMinKg", None)
        g.pop("countryDivUncertain", None)
        if keep_existing and prev_div is not None:
            g["countryDiv"] = prev_div
            g["countryDivSrc"] = prev_src or "legacy"

        dr = divrules.get(g.get("sheet"))
        if not dr:
            continue
        if g.get("mode") == "divider" or g.get("sheet") in SKIP_SHEETS:
            continue

        bc = (dr.get("byCountry") or {}).get(g.get("country"))
        if isinstance(bc, dict) and bc.get("div"):
            g["countryDiv"] = bc["div"]
            g["countryDivSrc"] = bc.get("src", "sheet")
            if bc.get("minKg") is not None:
                g["countryMinKg"] = bc["minKg"]
            hit += 1
        else:
            other = dr.get("other")
            if isinstance(other, dict) and other.get("div"):
                # sheet 备注区明写「其他国家：长*宽*高cm/N」
                g["countryDiv"] = other["div"]
                g["countryDivSrc"] = "other"
                if other.get("minKg") is not None:
                    g["countryMinKg"] = other["minKg"]
                hit += 1
            elif keep_existing and g.get("countryDiv") is not None:
                # 保留原有值 (原来就从报价表抽到的, 不降级)
                pass
            elif _has_normal_rule(g, rulemap):
                # 有原计算器的渠道除数 (引擎会用它) -> 有来源, 不是不确定
                pass
            elif g.get("mode") == "divider" and g.get("div"):
                # 专线三线: 除数写在报价表表头里 (体积/6000 / 10000 / 18000) -> 有来源
                pass
            else:
                # 报价表 (备注区 + 总目录) 都没给这个国家的除数,
                # 原计算器也没有 -> 引擎会用硬编码的 6000 兜底, 标「不确定」
                g["countryDivUncertain"] = True
                uncertain += 1
    return hit, uncertain
