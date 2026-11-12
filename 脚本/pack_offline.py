#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打包「本地双击离线版」给用户。

离线版 = 一个文件夹, 双击 index.html 就能用 (file:// 协议, 不需要服务器):
    index.html      前台页面 (自带内联 CSS, 不依赖外部文件)
    engine.js       计算引擎
    data_v2.js      报价数据快照

打包前会检查:
  1. 三份副本 (根目录 / public/ / 脚本/) 内容一致 —— 不一致先同步, 免得
     离线版和线上算出不一样的价
  2. index.html 里的内联 CSS 是最新的 (sync_ui_css --check)
  3. data_v2.js 里的除数字段没有漏

用法:
    python 脚本/pack_offline.py                    # 打包到 打包/物流报价查询-离线版-YYYYMMDD.zip
    python 脚本/pack_offline.py --out D:\\somewhere
"""
import os
import shutil
import subprocess
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PACK_DIR = os.path.join(ROOT, "打包")

NEEDED = ["index.html", "engine.js", "data_v2.js"]


def run(script, *args):
    r = subprocess.run([sys.executable, os.path.join(HERE, script), *args],
                       cwd=ROOT, capture_output=True, text=True)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def main():
    out_dir = PACK_DIR
    if "--out" in sys.argv:
        i = sys.argv.index("--out")
        out_dir = os.path.abspath(sys.argv[i + 1])

    print("=== 1/4 检查副本一致性 ===")
    rc, out = run("sync_copies.py", "--check")
    print(out.strip())
    if rc != 0:
        print("\n副本不一致 —— 先跑一次  python 脚本/sync_copies.py  再打包")
        return 1

    print("\n=== 2/4 检查内联 CSS 是否最新 ===")
    rc, out = run("sync_ui_css.py", "--check")
    print(out.strip())
    if rc != 0:
        print("\n内联 CSS 漂移 —— 先跑一次  python 脚本/sync_ui_css.py  再打包")
        return 1

    print("\n=== 3/4 检查数据 ===")
    import json
    raw = open(os.path.join(ROOT, "data_v2.js"), encoding="utf-8").read()
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
    gs = d.get("groups") or []
    withdiv = sum(1 for g in gs if g.get("countryDiv"))
    print(f"  groups {len(gs)}, tiers {len(d.get('tiers') or [])}, 有逐国除数 {withdiv}")
    if not gs or not d.get("tiers"):
        print("  数据不完整, 拒绝打包")
        return 1

    print("\n=== 4/4 打包 ===")
    os.makedirs(out_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M")
    stage = os.path.join(out_dir, "_stage_" + stamp)
    if os.path.exists(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)
    for f in NEEDED:
        shutil.copy(os.path.join(ROOT, f), os.path.join(stage, f))
    # 带上一份说明, 免得用户不知道怎么用
    for doc in ("使用说明.md",):
        p = os.path.join(ROOT, doc)
        if os.path.exists(p):
            shutil.copy(p, os.path.join(stage, doc))
    readme = os.path.join(stage, "怎么用.txt")
    with open(readme, "w", encoding="utf-8") as f:
        f.write(
            "物流报价查询 · 离线版\n"
            "=====================\n\n"
            "双击 index.html 就能用, 不需要联网, 不需要装任何东西。\n\n"
            "· Chrome / Edge 直接双击打开即可\n"
            f"· 打包时间: {time.strftime('%Y-%m-%d %H:%M')}\n"
            f"· 费率档: {len(d.get('tiers') or [])} 条, 渠道组 {len(gs)} 个\n\n"
            "注意: 离线版用的是打包那一刻的汇率, 用之前记得改汇率框。\n"
            "线上 https://quote.byberg.store 的汇率每 3 小时自动刷新, 更准。\n"
        )
    zip_path = os.path.join(out_dir, "物流报价查询-离线版-" + stamp + ".zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(os.listdir(stage)):
            z.write(os.path.join(stage, f), f)
    shutil.rmtree(stage)

    size = os.path.getsize(zip_path)
    print(f"  {zip_path}  ({size/1024:.0f} KB)")
    print(f"  内含: {', '.join(sorted(os.listdir(stage)) if False else NEEDED + ['怎么用.txt'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
