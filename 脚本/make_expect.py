"""
生成验证基准:
  1. 用 LibreOffice 重算《物流定价计算器.xlsx》 (改几组输入)
  2. 读回每个国家行的 M(定价成本) N/O/P(售价) U(毛利) D(运费)
  3. 存成 expect_calc.json 供 engine.js 比对

每组输入: (长,宽,高,重量,属性,采购价,到账)
"""
import json, os, shutil, subprocess, glob
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)                 # 网站根目录
WEB = HERE                                   # 基准文件写在脚本目录 (verify_calc.js 从同目录读)
TMP = os.path.join(HERE, "verify_calc_tmp")  # LibreOffice 临时目录
# 原计算器路径: 优先读 原表路径.txt, 没有再退回默认位置
_CFG = os.path.join(HERE, "原表路径.txt")
if os.path.exists(_CFG):
    SRC = open(_CFG, encoding="utf-8").read().strip()
else:
    SRC = r"D:\Desktop\物流定价计算器.xlsx"

# 几组不同尺寸/重量/属性的输入
INPUT_SETS = [
    (50, 40, 35, 4, "普货", 490, 1500),     # 原表默认值
    (30, 20, 15, 1, "普货", 490, 1500),     # 小件
    (60, 50, 40, 12, "普货", 300, 900),     # 泡货
    (40, 30, 20, 5, "带电", 490, 1500),     # 带电
    (25, 20, 15, 0.5, "普货", 100, 600),    # 轻小件
]

# 表结构: sheet -> (小节名, 行范围, 输入行, 国家列)
SECTIONS = {
    "云途": [("云途小包", 8, 25, 3), ("云途大货", 32, 41, 29)],
    "杰航": [("欧盟P线", 8, 16, 3), ("欧盟D线", 21, 28, 3),
             ("英国专线", 33, 33, 3), ("德国专线", 38, 38, 3), ("美国专线", 43, 43, 3)],
    "YDH义速宝": [("YDH", 8, 12, 3)],
    "三态": [("三态重货", 8, 22, 3), ("三态大货", 32, 41, 3)],
    "递四方": [("递四方", 8, 19, 3)],
}


def recalc(inp, tag):
    """改输入 -> LibreOffice 重算 -> 读回结果。"""
    d = os.path.join(TMP, tag)
    if os.path.isdir(d):
        shutil.rmtree(d)
    os.makedirs(d)
    src = os.path.join(d, "in.xlsx")
    shutil.copy(SRC, src)
    wb = openpyxl.load_workbook(src)
    for sheet, secs in SECTIONS.items():
        ws = wb[sheet]
        for sec, r0, r1, inrow in secs:
            L, W, H, kg, attr, buy, recv = inp
            ws.cell(row=inrow, column=5).value = L
            ws.cell(row=inrow, column=6).value = W
            ws.cell(row=inrow, column=7).value = H
            ws.cell(row=inrow, column=8).value = kg
            ws.cell(row=inrow, column=9).value = attr
            ws.cell(row=inrow, column=11).value = buy
            ws.cell(row=inrow, column=12).value = recv
    wb.save(src)

    prof = (os.path.join(d, "p")).replace("\\", "/")
    subprocess.run([r"C:\Program Files\LibreOffice\program\soffice.exe", "--headless",
                    "--norestore", f"-env:UserInstallation=file:///{prof}",
                    "--convert-to", "xlsx", "--outdir", os.path.join(d, "o"), src],
                   capture_output=True, timeout=600)
    outs = glob.glob(os.path.join(d, "o", "*.xlsx"))
    if not outs:
        raise RuntimeError(f"{tag}: 无输出")
    return openpyxl.load_workbook(outs[0], data_only=True)


def collect(wb, inp, tag):
    cases = []
    L, W, H, kg, attr, buy, recv = inp
    for sheet, secs in SECTIONS.items():
        ws = wb[sheet]
        for sec, r0, r1, inrow in secs:
            # 往上找真正的表头行 (含 "定价成本" 或 "运费" 的那行)
            hdr = None
            for hr in range(r0 - 1, max(1, r0 - 12), -1):
                rowvals = [str(ws.cell(row=hr, column=c).value or "")
                           for c in range(1, 26)]
                if any("定价成本" in v for v in rowvals):
                    hdr = hr
                    break
            if hdr is None:
                hdr = r0 - 2
            cols = {}
            for c in range(1, 26):
                v = ws.cell(row=hdr, column=c).value
                if not v:
                    continue
                s = str(v)
                if "定价成本" in s:
                    cols["cost"] = c
                elif s.strip() == "运费":
                    cols["freight"] = c
                elif s.strip() in ("国家", "项目/国家"):
                    cols["country"] = c
                elif s.strip() == "汇率":
                    cols["fx"] = c
            # 三档售价标签在表头下一行 (hdr+1)。有 N/O/P(人民币) 和 R/S/T(外币) 两组,
            # 要取**人民币那组**: 从 "定价成本" 列往后找的第一组。
            cost_c = cols.get("cost")
            if cost_c:
                for c in range(cost_c + 1, 26):
                    s = str(ws.cell(row=hdr + 1, column=c).value or "").strip()
                    if s == "0.3":
                        cols["p30"] = c
                    elif s == "0.35":
                        cols["p35"] = c
                    elif s == "0.4":
                        cols["p40"] = c
                    elif s == "0.45":
                        cols["p45"] = c
                    elif s in ("0.3", "0.35", "0.4"):
                        pass
                    else:
                        # 遇到非数字标签就停 (人民币组结束)
                        if cols.get("p30"):
                            break
            # 毛利额: 云途/三态/YDH/递四方 是 U 列 (21), 杰航是 P 列 (定价成本列+1)
            if "profit" not in cols:
                pc = cols.get("cost")
                if pc:
                    # 从定价成本列往后找第一个有值的表头 (毛利额列没标题)
                    for c in range(pc + 1, min(pc + 4, 26)):
                        if ws.cell(row=hdr, column=c).value is None:
                            cols["profit"] = c
                            break
            last_cn = ""
            for r in range(r0, r1 + 1):
                cc = cols.get("country")
                cn = ws.cell(row=r, column=cc).value if cc else None
                if cn and str(cn).strip():
                    last_cn = str(cn).strip()
                zone = ""
                zc = ws.cell(row=r, column=3).value
                if zc and str(zc).strip() in ("一区","二区","三区","四区","五区","六区"):
                    zone = str(zc).strip()
                cost = ws.cell(row=r, column=cols["cost"]).value if "cost" in cols else None
                if cost is None:
                    continue
                if not isinstance(cost, (int, float)):
                    # 遇到中间的表头行 -> 跳过这一行, 重新探测列位
                    continue
                def gv(key):
                    c = cols.get(key)
                    v = ws.cell(row=r, column=c).value if c else None
                    if isinstance(v, (int, float)):
                        return v
                    return None
                fr_raw = ws.cell(row=r, column=cols["freight"]).value if "freight" in cols else None
                over = isinstance(fr_raw, str) and fr_raw.strip() != ""
                cases.append(dict(
                    label=f"{sheet}/{sec}/{last_cn}{zone}",
                    channel=sheet, section=sec, country=last_cn, zone=zone,
                    kg=kg, L=L, W=W, H=H, attr=attr, buy=buy, recv=recv,
                    total=round(float(cost), 2),
                    freight=round(float(gv("freight") or 0), 2),
                    over=over,
                    sell30=round(float(gv("p30") or 0), 2),
                    sell35=round(float(gv("p35") or 0), 2),
                    sell40=round(float(gv("p40") or 0), 2),
                    profit=round(recv - float(cost), 2),
                ))
    return cases


def main():
    if os.path.isdir(TMP):
        shutil.rmtree(TMP)
    os.makedirs(TMP)
    all_cases = []
    for i, inp in enumerate(INPUT_SETS):
        wb = recalc(inp, f"set{i}")
        cs = collect(wb, inp, f"set{i}")
        print(f"  输入 {inp}: 取到 {len(cs)} 行")
        all_cases.extend(cs)

    with open(os.path.join(WEB, "expect_calc.json"), "w", encoding="utf-8") as f:
        json.dump(dict(cases=all_cases), f, ensure_ascii=False, indent=1)
    print("written expect_calc.json", len(all_cases), "cases")


if __name__ == "__main__":
    main()
