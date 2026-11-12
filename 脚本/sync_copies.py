#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
同步「同一份文件的多副本」。

这个项目里有些文件同时存在两份, 内容必须完全一致:

    engine.js          根目录 (本地双击离线版用)  +  public/ (线上静态资源)
    index.html         根目录 (本地双击离线版用)  +  public/ (线上静态资源)
    data_v2.js         根目录                     +  public/             +  脚本/ (pipeline 产出)

之前就是因为只改了其中一份、忘了另一份, 导致本地测试用的是旧引擎、
线上却是新的, 排查了很久 (2026-11-10)。

同步方向的原则: **mtime 最新的那份当源, 其余当目标**。
这样不管你改的是哪一份, 同步后都是最新的, 不会出现「把旧数据刷回去」。

用法:
    python 脚本/sync_copies.py            # 同步
    python 脚本/sync_copies.py --check    # 只检查有没有不一致 (退出码 1 = 有差异)
"""
import filecmp
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 需要保持一致的副本组 (每组内任意两份内容必须相同)
# 每组第一个是「权威源」—— 改完只改它, 再跑本脚本刷到其它副本。
#
# 为什么不用 mtime 最新的当源 (2026-11-10 踩过):
#   sync_ui_css.py 会同时写 public/index.html 和根目录 index.html, 两边 mtime
#   几乎一样; 于是「最新」是随机的, 把它当源就等于随机用旧内容覆盖新内容 ——
#   当时我改的是 public/index.html, 结果被根目录那份覆盖回去, 改动全丢。
#   现在改成「显式指定权威源」, 不猜。
GROUPS = [
    ["public/engine.js", "engine.js"],
    ["public/index.html", "index.html"],
    ["public/data_v2.js", "data_v2.js", os.path.join("脚本", "data_v2.js")],
]


def pick_source(paths):
    """返回该组的权威源 —— 第一个存在的路径。

    兼容旧调用名 newest(): 只是不再按 mtime 猜了。
    """
    for p in paths:
        if os.path.exists(p):
            return p
    return None


def _find_node():
    """找一个**真正能执行**的 node。

    踩过的坑:
      - which 出来的路径可能不带 .exe, 用完整路径调 subprocess 时 Windows 不再补后缀
      - Hermes 自带的 node 在 WindowsApps 下, 某些进程 (例如 documents venv 的
        python) 执行它会被 ACL 拒绝 (PermissionError: WinError 5)
    所以这里逐个候选试跑 `node --version`, 跑通了才用, 跑不通就换下一个。
    实在一个都跑不通, 返回 None —— 调用方应当**跳过检查**, 而不是判定文件坏了。
    """
    import shutil as _sh
    cands = []
    for w in (_sh.which("node"), _sh.which("node.exe")):
        if not w:
            continue
        cands.append(w)
        if not w.lower().endswith(".exe"):
            cands.append(w + ".exe")
    cands.append(r"C:\Program Files\nodejs\node.exe")
    for c in cands:
        if not c or not os.path.exists(c):
            continue
        try:
            r = subprocess.run([c, "--version"], capture_output=True, text=True, timeout=30)
            if r.returncode == 0:
                return c
        except Exception:
            continue
    return None


def looks_broken(path):
    """粗查文件是不是写坏了 —— 「最新当源」的前提是最新那份不是坏的。

    手滑写坏一个 engine.js, mtime 也会变新, 不查就会把坏的刷到所有副本。
    """
    try:
        if path.endswith(".js"):
            node = _find_node()
            if not node:
                return None          # 找不到能跑的 node, 跳过检查
            try:
                r = subprocess.run([node, "--check", path],
                                   capture_output=True, text=True, timeout=60)
            except Exception:
                # node 跑不动 (比如被 ACL 拒绝) —— 这说明不了文件有问题,
                # 跳过检查即可, 不能判成「坏了」。
                return None
            return r.returncode != 0
        if path.endswith(".json") or ".json" in path:
            import json as _json
            with open(path, encoding="utf-8") as f:
                _json.load(f)
            return False
    except Exception as e:
        return True
    return False


def main():
    # 这个脚本只在「本地开发目录」用:
    #   本地:  根目录有 index.html/engine.js/data_v2.js (离线版) + public/ (线上版)
    #   服务器: 只有 public/ 一份, 根目录那几份是死文件 (已删)
    # 在服务器上跑这个脚本只会把根目录重新建出来 —— 那不是我们想要的。
    # 判据: 根目录必须有 index.html (本地开发目录的标志)。
    if not os.path.exists(os.path.join(ROOT, "index.html")):
        print("这里没有本地开发副本 (根目录无 index.html), 跳过")
        return 0
    if not os.path.exists(os.path.join(ROOT, "public", "index.html")):
        print("这里不是网站开发目录 (没有 public/index.html), 跳过")
        return 0

    check = "--check" in sys.argv
    bad = []
    for group in GROUPS:
        paths = [os.path.join(ROOT, g) for g in group]
        src = pick_source(paths)
        if src is None:
            print(f"  [跳过] 整组都不存在: {', '.join(group)}")
            continue
        broken = looks_broken(src)
        if broken:
            print(f"  [拒绝] 最新的那份看着是坏的, 不敢拿它当源: {os.path.relpath(src, ROOT)}")
            print("             先手工确认这份文件没问题 (js 跑 node --check, json 看能否解析)")
            bad.append(os.path.relpath(src, ROOT))
            continue
        src_rel = os.path.relpath(src, ROOT)
        for dst in paths:
            if dst == src:
                continue
            dst_rel = os.path.relpath(dst, ROOT)
            if not os.path.exists(dst):
                print(f"  [新建] {dst_rel}  <- {src_rel}")
                if not check:
                    shutil.copy(src, dst)
                else:
                    bad.append(dst_rel)
                continue
            if filecmp.cmp(src, dst, shallow=False):
                continue
            print(f"  [不一致] {dst_rel}")
            print(f"             源 (最新): {src_rel}  "
                  f"{time.strftime('%m-%d %H:%M', time.localtime(os.path.getmtime(src)))}")
            print(f"             目标      : {dst_rel}  "
                  f"{time.strftime('%m-%d %H:%M', time.localtime(os.path.getmtime(dst)))}")
            if check:
                bad.append(dst_rel)
            else:
                # 覆盖前先备份, 免得手改的东西被静默冲掉
                bak = dst + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
                shutil.copy(dst, bak)
                shutil.copy(src, dst)
                print(f"             已同步 (旧文件备份为 {os.path.basename(bak)})")
    if check:
        if bad:
            print(f"\n{len(bad)} 个副本不一致, 跑一次  python 脚本/sync_copies.py")
            return 1
        print("\n所有副本一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
