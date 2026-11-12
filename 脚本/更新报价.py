"""
一键更新报价数据。

这个脚本只更新【本地离线副本】(网站根目录的 data_v2.js),
所以双击 index.html 能看到新价格。
要更新【线上网站】请用 推送报价.py (它会走后台 API, 按账号隔离写入)。

用法:
    python 更新报价.py                    # 自动找最新报价表
    python 更新报价.py "D:\\Desktop\\新报价.xlsx"   # 指定报价表
    python 更新报价.py --dry              # 只跑流程, 不覆盖网站

流程:
    1. 找到新的渠道整合报价表 (参数 > 脚本目录/新报价表.xlsx > 已知位置里最新的)
    2. 写入 源文件路径.txt (所有抽取脚本都从这里读数据源)
    3. 依次抽取: 费率库 / 专线 / 尺寸附加费 / 逐国除数 / 定价规则
    4. 打包 + 合并 -> data_v2.js
    5. 对比新旧数据, 列出改了哪些价格
    6. 备份并覆盖网站目录里的 data_v2.js
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)                 # 网站根目录
DATA_JS = os.path.join(SITE, "data_v2.js")
CFG = os.path.join(HERE, "源文件路径.txt")

# 找报价表时会看的位置
SEARCH_DIRS = [
    HERE,                                                    # 脚本目录 (把新表放这里最省事)
    r"D:\Desktop",
    os.path.join(os.path.expanduser("~"), "Desktop"),
    os.path.join(os.environ.get("APPDATA", ""), "Local", "hermes", "attachments"),
]
# 报价表文件名里带这些字样才算数
QUOTE_HINT = ("渠道整合报价", "盛途")
EXCLUDE = ("物流定价计算器", "定价计算器")


def log(msg):
    print(msg, flush=True)


def find_quote_table(arg=None):
    """返回一个最可能的新报价表路径。"""
    if arg:
        if not os.path.exists(arg):
            sys.exit(f"找不到文件: {arg}")
        return os.path.abspath(arg)

    cands = []
    for d in SEARCH_DIRS:
        if not d or not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            if not f.lower().endswith(".xlsx"):
                continue
            if not any(h in f for h in QUOTE_HINT):
                continue
            if any(h in f for h in EXCLUDE):
                continue
            p = os.path.join(d, f)
            if p.lower().startswith("~$"):
                continue
            cands.append(p)
    if not cands:
        sys.exit("没找到报价表。\n"
                 "  · 把新报价表放到 脚本\\ 目录下再跑一次\n"
                 "  · 或直接指定: python 更新报价.py \"D:\\path\\新报价.xlsx\"")
    cands.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return cands[0]


def current_source():
    if os.path.exists(CFG):
        return open(CFG, encoding="utf-8").read().strip()
    return None


def run(script, must=True):
    p = os.path.join(HERE, script)
    if not os.path.exists(p):
        if must:
            sys.exit(f"缺少脚本: {p}")
        return None
    log(f"  → {script}")
    r = subprocess.run([sys.executable, p], cwd=HERE, capture_output=True, text=True)
    if r.returncode != 0:
        if must:
            log(r.stdout[-1500:])
            log(r.stderr[-1500:])
            sys.exit(f"{script} 运行失败")
        log(f"  (跳过 {script}: 运行失败)")
        return None
    return r.stdout


def read_data_js(path):
    """从 data_v2.js 里取出 JSON 部分。"""
    raw = open(path, encoding="utf-8").read()
    i = raw.find("{")
    j = raw.rfind("}")
    if i < 0 or j < 0:
        return None
    return json.loads(raw[i:j + 1])


def load_tiers(js_path):
    """从 data_v2.js 里读出费率档, 变成可比对的字典。"""
    if not os.path.exists(js_path):
        return {}
    data = read_data_js(js_path)
    if not data:
        return {}
    out = {}
    for t in data.get("tiers", []):
        key = "|".join([t.get("sheet", ""), t.get("country", ""), t.get("zone", ""),
                        t.get("line", ""), t.get("attr", ""), t.get("mode", ""),
                        str(t.get("lo")), str(t.get("hi"))])
        out[key] = (t.get("price"), t.get("fee"))
    return out


def diff_tiers(old, new):
    changed, added, removed = [], [], []
    for k, v in new.items():
        if k not in old:
            added.append(k)
        elif old[k] != v:
            changed.append((k, old[k], v))
    for k in old:
        if k not in new:
            removed.append(k)
    return changed, added, removed


def show_diff(changed, added, removed, limit=25):
    def fmt(k):
        parts = k.split("|")
        return f"{parts[0]} / {parts[1]} / {parts[2]} / {parts[4] or '通用'} / " \
               f"{parts[3]} {parts[5]} {parts[6]}-{parts[7]}kg"

    log("")
    if changed:
        log(f"【价格变动】{len(changed)} 条")
        for k, o, n in changed[:limit]:
            log(f"  {fmt(k)}")
            log(f"      运费 {o[0]} → {n[0]}   挂号费 {o[1]} → {n[1]}")
        if len(changed) > limit:
            log(f"  ... 还有 {len(changed) - limit} 条")
    if added:
        log(f"【新增】{len(added)} 条")
        for k in added[:10]:
            log(f"  {fmt(k)}")
    if removed:
        log(f"【删除】{len(removed)} 条")
        for k in removed[:10]:
            log(f"  {fmt(k)}")
    if not (changed or added or removed):
        log("【价格变动】没有变化")


def main():
    dry = "--dry" in sys.argv
    arg = None
    for a in sys.argv[1:]:
        if not a.startswith("--"):
            arg = a

    src = find_quote_table(arg)
    log(f"报价表: {src}")
    log(f"大小:   {os.path.getsize(src):,} 字节")
    log(f"修改时间: {time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(src)))}")

    prev = current_source()
    if prev and os.path.abspath(prev) == os.path.abspath(src) and not arg:
        log("提示: 用的是同一份报价表 (要重跑就直接再点一次)")

    # 1) 写配置 (报价表 + 原计算器)
    open(CFG, "w", encoding="utf-8").write(os.path.abspath(src))
    calc_cfg = os.path.join(HERE, "原表路径.txt")
    if not os.path.exists(calc_cfg):
        guess = r"D:\Desktop\物流定价计算器.xlsx"
        if os.path.exists(guess):
            open(calc_cfg, "w", encoding="utf-8").write(guess)
    log("\n[1/4] 抽取")
    run("extract3.py")             # 费率库
    run("extract_divider.py")      # 专线
    run("extract_surcharges.py")   # 尺寸限制 + 附加费
    run("extract_div_rules.py")    # 逐国体积重除数
    # 定价规则来自《物流定价计算器》, 那份没变就不重抽 (失败也不影响报价更新)
    if run("extract_calc_rules.py", must=False) is None:
        log("  (跳过定价规则)")

    # 2) 打包合并
    log("\n[2/4] 合并")
    run("pack_data.py")
    run("merge_data.py")

    js = os.path.join(HERE, "data_v2.js")
    if not os.path.exists(js):
        sys.exit("没生成 data_v2.js")
    shutil.copy(js, os.path.join(HERE, "data_v2.json"))
    # 顺便转成可读的 json
    data = read_data_js(js)
    if data:
        meta = data.get("meta", {})
        log(f"  {meta.get('channels')} 个渠道 · {meta.get('groups')} 组报价 · "
            f"{meta.get('tiers')} 条费率档")

    # 3) 对比价格
    log("\n[3/4] 比对价格变化")
    old = load_tiers(DATA_JS)
    new = load_tiers(js)
    changed, added, removed = diff_tiers(old, new)
    show_diff(changed, added, removed)

    # 4) 部署
    log("\n[4/4] 部署")
    if dry:
        log("  --dry 模式, 不覆盖网站")
        return 0
    if os.path.exists(DATA_JS):
        bak = DATA_JS + ".bak"
        shutil.copy(DATA_JS, bak)
        log(f"  旧版备份: {bak}")
    shutil.copy(js, DATA_JS)
    log(f"  已更新: {DATA_JS}")
    log("\n完成。打开 index.html 就能看到新价格。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
