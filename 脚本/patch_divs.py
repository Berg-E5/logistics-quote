#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
就地修补某个账号的 rates.json 的体积重除数 (只改除数, 不动价格)。

为什么需要它:
    这次改的是「报价表口径的体积重除数」, 价格完全没变。
    如果重跑整条 pipeline 覆盖数据, 会把用户自己上传的价格表 (档数不同)
    一起换掉 —— 不可逆。所以只把受影响的除数字段就地更新。

用法:
    python3 脚本/patch_divs.py <rates.json> [div_rules.json] [--dry]

例:
    python3 脚本/patch_divs.py /var/www/quote.byberg.store/data/users/Berg/rates.json
"""
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from div_apply import load_div_rules, apply_div   # noqa: E402


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry" in sys.argv
    if not args:
        print("用法: patch_divs.py <rates.json> [div_rules.json] [--dry]")
        return 2

    target = os.path.abspath(args[0])
    divrules = load_div_rules(args[1] if len(args) > 1 else None)
    if not divrules:
        print("没读到 div_rules.json, 退出")
        return 3

    with open(target, encoding="utf-8") as f:
        doc = json.load(f)
    data = doc.get("data") or doc
    groups = data.get("groups") or []

    before = {}
    for g in groups:
        before[id(g)] = (g.get("countryDiv"), g.get("countryDivSrc"))

    hit, uncertain = apply_div(groups, divrules, rules=data.get("rules"), keep_existing=True)

    # 数据包里的 divRules 字段也要同步更新, 否则它跟 groups 里的 countryDiv 对不上
    if isinstance(data.get("divRules"), dict):
        data["divRules"] = divrules

    changed = 0
    for g in groups:
        o = before[id(g)]
        n = (g.get("countryDiv"), g.get("countryDivSrc"))
        if o != n:
            changed += 1
    # 原来没有 countryDiv 的 (None -> 数字) 也算变了
    changed = sum(1 for g in groups
                  if before[id(g)][0] != g.get("countryDiv"))

    print(f"{target}")
    print(f"  groups {len(groups)}, 命中除数 {hit}, 标记不确定 {uncertain}, 除数变化 {changed}")

    if dry:
        print("  (dry-run, 未写盘)")
        return 0

    data["rev"] = int(doc.get("rev") or 0) + 1
    doc["rev"] = data["rev"]
    doc["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    data["updatedAt"] = doc["updatedAt"]
    if "data" not in doc:
        doc["data"] = data

    bak = target + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
    shutil.copy(target, bak)
    print(f"  备份 {bak}")

    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    os.replace(tmp, target)
    print(f"  已写入, rev -> {data['rev']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
