"""
刷新网站里的参考汇率 (本地离线版用)。

用法:
    python update_fx.py            # 刷新 index.html + public/index.html, 并写 data/fx.json
    python update_fx.py --show     # 只打印, 不改文件

数据由 fetch_fx.py 抓取 (主源: 中国银行外汇牌价 www.boc.cn 现汇卖出价;
失败退回 open.er-api.com / frankfurter.app 补缺)
换算:   1 外币 = ? 人民币  ->  fx = 1 / (1 CNY = ? 外币)

注: 线上网站的汇率由服务器自动刷新 (每 3 小时), 不需要跑这个脚本。
"""
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.request

SITE = r"D:\Desktop\物流报价查询网站"
TARGETS = [os.path.join(SITE, "index.html"),
           os.path.join(SITE, "public", "index.html")]
FX_JSON = os.path.join(SITE, "data", "fx.json")
API = "https://open.er-api.com/v6/latest/CNY"

# 国家 -> 币种
CURS = {
    "美国": "USD", "加拿大": "CAD", "墨西哥": "MXN", "澳大利亚": "AUD",
    "英国": "GBP", "法国": "EUR", "德国": "EUR", "意大利": "EUR",
    "西班牙": "EUR", "比利时": "EUR", "波兰": "PLN", "瑞典": "SEK",
    "爱尔兰": "EUR", "沙特阿拉伯": "SAR", "阿联酋": "AED",
}


def fetch():
    req = urllib.request.Request(API, headers={"User-Agent": "fx-refresh/1.0"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        d = json.loads(resp.read().decode("utf-8"))
    if d.get("result") != "success":
        raise RuntimeError("汇率接口返回异常: " + str(d)[:200])
    rates = d["rates"]
    out = {cn: round(1.0 / rates[cur], 4) for cn, cur in CURS.items()}
    raw = d.get("time_last_update_utc", "")      # 'Sat, 07 Nov 2026 00:02:31 +0000'
    try:
        date = datetime.datetime.strptime(raw[:16], "%a, %d %b %Y").strftime("%Y-%m-%d")
    except ValueError:
        date = raw[:10]
    return out, date


def main():
    if "--show" in sys.argv:
        r = subprocess.run([sys.executable, os.path.join(SITE, "脚本", "fetch_fx.py"), "--stdout"],
                           capture_output=True, text=True)
        print(r.stdout or r.stderr)
        return r.returncode

    # 抓汇率 (fetch_fx.py 会写 data/fx.json)
    r = subprocess.run([sys.executable, os.path.join(SITE, "脚本", "fetch_fx.py")],
                       capture_output=True, text=True)
    print(r.stdout or "", end="")
    if r.returncode != 0:
        print(r.stderr, file=sys.stderr)
        return r.returncode

    j = json.load(open(FX_JSON, encoding="utf-8"))
    fx, date = j["rates"], j["date"]

    block = "const FX_REF = {\n" + "".join(
        f"  '{k}': {v},\n" for k, v in fx.items()) + "};\n"

    for target in TARGETS:
        if not os.path.exists(target):
            print("跳过 (不存在):", target)
            continue
        t = open(target, encoding="utf-8").read()
        t2, n = re.subn(r"(const|let) FX_REF = \{.*?\n\};\n", block, t, count=1, flags=re.S)
        if n != 1:
            print("没找到 FX_REF 块, 未修改:", target)
            continue
        t2 = re.sub(r"// FX_DATE: 参考汇率取数日 [^\n(]*",
                    f"// FX_DATE: 参考汇率取数日 {date} ", t2)
        t2 = re.sub(r"(const|let) FX_DATE = '[^']*'",
                    f"let FX_DATE = '{date}'", t2)
        # 离线版没有服务端, 把来源和牌价发布时间也写进去, 让文案显示「中国银行现汇卖出价」
        src = j.get("source", "")
        pub = j.get("publishedAt", "") or date
        t2 = re.sub(r"(const|let) FX_SOURCE = '[^']*'",
                    f"let FX_SOURCE = '{src}'", t2)
        t2 = re.sub(r"(const|let) FX_PUBLISHED = '[^']*'",
                    f"let FX_PUBLISHED = '{pub}'", t2)
        open(target, "w", encoding="utf-8", newline="").write(t2)
        print("已更新", target)

    print(f"完成, 汇率取数日 {date}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
