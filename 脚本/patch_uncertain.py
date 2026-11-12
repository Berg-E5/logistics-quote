#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
就地给「没有真实除数来源」的渠道组补 countryDivUncertain 标记。

背景
----
引擎(engine.js)判断除数「不确定」看的是 ``q.countryDivUncertain`` 这个字段::

    out.divUncertain = !!(preferRates && q.countryDivUncertain && !q.countryDiv);

但线上/本地的 rates.json 里, 只有真正「不确定」的组才有这个字段 —— 而按
``div_apply.py`` 的判定逻辑, admin 的 552 组全部有真实来源 (390 个来自报价表
备注区/总目录, 3 个来自原计算器规则, 159 个是专线三条线的固定除数), 所以
**一个字段都没有**, 于是即使将来某个组真的不确定, 引擎也不会标出来。

Berg 的账号有 92 组是「g.div 硬编码的 6000」—— 那是 ``pack_data.py`` 写死的
假值, 不是真实来源, 按 Berg 定的规则应该显示「不确定」。

本脚本只**加标记**, 不碰任何价格 / 档位 / 除数数值, 所以可以安全重跑。

用法
----
    python3 脚本/patch_uncertain.py            # 干跑 (只报告)
    python3 脚本/patch_uncertain.py --apply     # 真改
    python3 脚本/patch_uncertain.py --apply --server /var/www/quote.byberg.store

判定逻辑跟 engine.js 的除数优先级完全一致:
    1) countryDiv                     -> 报价表备注区 / 总目录 / 人工填写  (有来源)
    2) rule.div 且 rule.type=='normal' -> 原《物流定价计算器》规则          (有来源)
    3) mode=='divider' 且 group.div    -> 专线三条线 ÷6000/÷10000/÷18000  (有来源)
    4) 其余                            -> pack_data 硬编码的 6000        (无来源 = 不确定)
"""
import argparse
import json
import os
import sys

DEFAULT_ROOT = r"D:\Desktop\物流报价查询网站"


def build_rule_map(rules):
    m = {}
    for r in rules or []:
        m["%s|%s|%s|%s" % (r.get("channel"), r.get("section"),
                           r.get("country"), r.get("zone"))] = r
    return m


def classify(g, rule_map):
    """返回 (div, src, uncertain)"""
    if g.get("countryDiv"):
        src = g.get("countryDivSrc")
        name = {"catalog": "总目录", "sheet": "备注区·本国家",
                "other": "备注区·其他国家", "manual": "人工填写"}.get(src, "报价表")
        return g["countryDiv"], name, False
    r = rule_map.get(g.get("ruleKey"))
    if r and r.get("type") == "normal" and r.get("div"):
        return r["div"], "原计算器规则", False
    if g.get("mode") == "divider" and g.get("div"):
        return g["div"], "专线固定", False
    return g.get("div") or 6000, "兜底 (不确定)", True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT, help="项目根目录 (本地) ")
    ap.add_argument("--server", help="服务器目录, 与 --root 二选一")
    ap.add_argument("--apply", action="store_true", help="真改 (默认干跑)")
    ap.add_argument("--users", default="admin,Berg", help="处理哪些账号, 逗号分隔")
    args = ap.parse_args()

    root = args.server or args.root
    users_dir = os.path.join(root, "data", "users")
    if not os.path.isdir(users_dir):
        print("找不到用户数据目录:", users_dir)
        return 1

    users = [u.strip() for u in args.users.split(",") if u.strip()]
    total_changed = 0
    for who in users:
        path = os.path.join(users_dir, who, "rates.json")
        if not os.path.exists(path):
            print("[%s] 跳过: 没有 rates.json" % who)
            continue
        doc = json.load(open(path, encoding="utf-8"))
        data = doc.get("data") or {}
        groups = data.get("groups") or []
        rule_map = build_rule_map(data.get("rules"))

        to_set = []
        to_clear = []
        for g in groups:
            _, _, uncertain = classify(g, rule_map)
            cur = g.get("countryDivUncertain")
            if uncertain and cur is not True:
                to_set.append(g)
            elif not uncertain and cur is True:
                to_clear.append(g)

        print("[%s] groups=%d  需要标记不确定=%d  需要清除标记=%d"
              % (who, len(groups), len(to_set), len(to_clear)))
        for g in to_set[:8]:
            print("    + 不确定: %s / %s  (div=%s)" % (g.get("sheet"), g.get("country"), g.get("div")))
        if len(to_set) > 8:
            print("    ... 还有 %d 组" % (len(to_set) - 8))

        if not args.apply:
            continue
        if not to_set and not to_clear:
            continue

        for g in to_set:
            g["countryDivUncertain"] = True
        for g in to_clear:
            g.pop("countryDivUncertain", None)

        # 原子写
        tmp = path + ".tmp-uncertain"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
        os.replace(tmp, path)
        print("    已写入 %s" % path)
        total_changed += 1

    if not args.apply:
        print("\n干跑完成, 没改任何文件 (加 --apply 才真改)")
    else:
        print("\n完成, 改了 %d 个账号" % total_changed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
