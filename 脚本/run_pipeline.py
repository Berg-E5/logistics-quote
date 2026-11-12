#!/usr/bin/env python3
"""
服务端整表抽取 —— 收到新的报价表后跑一遍流水线, 输出合并好的数据集。

用法:
    python3 run_pipeline.py <报价表路径> <输出json路径>

做的事 (顺序固定):
    extract3.py            抽费率库
    extract_divider.py     抽专线
    extract_surcharges.py  抽尺寸限制 + 附加费
    extract_div_rules.py   抽逐国体积重除数
    extract_calc_rules.py  抽《物流定价计算器》的定价规则 (可选, 缺文件就跳过)
    pack_data.py           打包 data.json
    merge_data.py          合并 -> data_v2.js

数据源写在同目录的 源文件路径.txt / 原表路径.txt, 运行前会自动更新。
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable

# (脚本, 是否必需, 中文步骤名, 权重)
# 权重 = 这一步大概占整次导入多少时间 (总和 100)。
# 各脚本实测耗时: extract3 11.7s / extract_divider 11.2s / extract_surcharges 11.0s
#                extract_div_rules 67.5s (大头!) / pack_data 0.1s / merge_data 1.9s
# 均匀分 7 步会让进度条在第一步就冲到 86%, 然后卡住不动 —— 权重必须按耗时给。
STEPS = [
    ("extract3.py", True, "抽取费率档", 11),
    ("extract_divider.py", True, "抽取专线三线", 10),
    ("extract_surcharges.py", True, "抽取尺寸限制与附加费", 10),
    ("extract_div_rules.py", True, "抽取逐国体积重除数", 61),
    ("extract_calc_rules.py", False, "抽取定价规则", 5),   # 原计算器没变时可跳过
    ("pack_data.py", True, "打包数据", 1),
    ("merge_data.py", True, "合并并生成数据文件", 2),
]


def log(msg):
    print(f"[pipeline] {msg}", flush=True)


def step_mark(kind, i, total, name, weight=0):
    """进度标记 —— 服务端靠它算进度条。

    格式: [pipeline] STEP <i>/<total> <name> w=<weight>   (开始)
           [pipeline] DONE <i>/<total> <name> w=<weight>   (完成)
    权重是这一步占整次导入的时间份额, 服务端按累计权重算百分比。
    """
    print(f"[pipeline] {kind} {i}/{total} {name} w={weight}", flush=True)


def main():
    if len(sys.argv) < 3:
        print("用法: run_pipeline.py <报价表> <输出json>", file=sys.stderr)
        return 2
    src = os.path.abspath(sys.argv[1])
    out = os.path.abspath(sys.argv[2])

    if not os.path.exists(src):
        print(f"报价表不存在: {src}", file=sys.stderr)
        return 3

    # 告诉各抽取脚本数据源在哪
    with open(os.path.join(HERE, "源文件路径.txt"), "w", encoding="utf-8") as f:
        f.write(src)
    calc = os.path.join(HERE, "原计算器.xlsx")
    calc_cfg = os.path.join(HERE, "原表路径.txt")
    if os.path.exists(calc):
        with open(calc_cfg, "w", encoding="utf-8") as f:
            f.write(calc)

    t0 = time.time()
    total = len(STEPS)
    for idx, (script, required, cn_name, weight) in enumerate(STEPS, start=1):
        p = os.path.join(HERE, script)
        if not os.path.exists(p):
            if required:
                print(f"缺少脚本: {script}", file=sys.stderr)
                return 4
            continue
        if script == "extract_calc_rules.py" and not os.path.exists(calc):
            log("跳过 extract_calc_rules.py (没有原计算器文件)")
            step_mark("DONE", idx, total, cn_name, weight)
            continue

        step_mark("STEP", idx, total, cn_name, weight)
        step_t0 = time.time()
        # 流式跑: 子脚本的输出边跑边转发 (capture_output 会把中间进度全吞掉)
        proc = subprocess.Popen([PY, p], cwd=HERE,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace")
        tail = []
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            tail.append(line)
            if len(tail) > 60:
                tail.pop(0)
            # 子脚本自己的输出也透出去, 后面可能带行级进度
            print(f"[pipeline]   {line}", flush=True)
        rc = proc.wait()
        if rc != 0:
            log(f"{script} 失败:")
            for l in tail[-20:]:
                print(l, file=sys.stderr)
            return 5
        step_mark("DONE", idx, total, cn_name, weight)
        log(f"  {script} ok ({time.time() - step_t0:.1f}s)")

    # merge_data.py 产出 data_v2.js, 从里面取 JSON
    js = os.path.join(HERE, "data_v2.js")
    if not os.path.exists(js):
        print("没生成 data_v2.js", file=sys.stderr)
        return 6
    raw = open(js, encoding="utf-8").read()
    i, j = raw.find("{"), raw.rfind("}")
    if i < 0 or j < 0:
        print("data_v2.js 格式不对", file=sys.stderr)
        return 7
    data = json.loads(raw[i:j + 1])
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    log(f"完成, 用时 {time.time() - t0:.1f}s, "
        f"{len(data.get('tiers', []))} 条费率档 -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
