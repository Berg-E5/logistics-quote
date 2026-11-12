#!/usr/bin/env python3
"""
抓实时汇率, 写成 data/fx.json 供网站读取。

用法:
    python3 fetch_fx.py            # 抓取并写入 data/fx.json
    python3 fetch_fx.py --stdout   # 只打印, 不写文件

数据源 (按优先级):
    1. 中国银行外汇牌价  www.boc.cn/sourcedb/whpj/index.html
       取「现汇卖出价」—— 客户把外币卖给中行能拿到的价格, 贴近实际结汇。
       牌价单位是「100 外币兑人民币」, 要除 100。几分钟更新一次, 覆盖 45 个币种。
    2. open.er-api.com   国际中间价 (免费, 每日更新) —— 补中行没覆盖的币种
    3. frankfurter.app   ECB 每日定盘 —— 最后兜底

换算:   1 外币 = ? 人民币  ->  fx = 1 / (1 CNY = ? 外币)

写出的格式:
    { "date": "2026-11-11", "updatedAt": "...", "source": "boc.cn",
      "rates": { "美国": 6.6918, ... } }
"""
import datetime
import html
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "fx.json")

# 国家 -> 币种代码
CURS = {
    "美国": "USD", "加拿大": "CAD", "墨西哥": "MXN", "澳大利亚": "AUD",
    "英国": "GBP", "法国": "EUR", "德国": "EUR", "意大利": "EUR",
    "西班牙": "EUR", "比利时": "EUR", "波兰": "PLN", "瑞典": "SEK",
    "爱尔兰": "EUR", "沙特阿拉伯": "SAR", "阿联酋": "AED",
}
# 币种代码 -> 中行牌价表里的中文名
BOC_NAMES = {
    "USD": "美元", "CAD": "加拿大元", "MXN": "墨西哥比索", "AUD": "澳大利亚元",
    "GBP": "英镑", "EUR": "欧元", "PLN": "波兰兹罗提", "SEK": "瑞典克朗",
    "SAR": "沙特里亚尔", "AED": "阿联酋迪拉姆",
}
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
UA = {"User-Agent": "quote-fx/1.0"}


def _get(url, ua=None):
    """取回原始字节 (中行是 HTML, 其它源是 JSON)"""
    req = urllib.request.Request(url, headers={"User-Agent": ua or UA["User-Agent"]})
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read()


def _get_json(url):
    return json.loads(_get(url).decode("utf-8"))


def _num(text):
    """从单元格文本里抽数字 —— 牌价可能带千分位、空格、全角字符"""
    if not text:
        return None
    m = re.search(r"[\d,，]+\.?\d*", text.replace("\xa0", " "))
    if not m:
        return None
    try:
        return float(m.group().replace(",", "").replace("，", ""))
    except ValueError:
        return None


def fetch_boc():
    """中国银行外汇牌价 -> 1 外币 = ? 人民币 (现汇卖出价)

    返回 (rates_by_country, date, source)。
    中行没覆盖到的币种不返回, 留给后备源补。
    """
    page = _get("https://www.boc.cn/sourcedb/whpj/index.html", ua=BROWSER_UA).decode("utf-8", "ignore")

    # 只取牌价表那一段, 避免页面别处有干扰表格
    i = page.find('id="priceTable"')
    if i < 0:
        raise RuntimeError("中行页面里找不到 priceTable (页面结构可能改了)")
    body = page[i:]

    # 每行: 货币名称 | 现汇买入价 | 现钞买入价 | 现汇卖出价 | 现钞卖出价 | 中行折算价 | 发布日期
    table = {}
    published = ""
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", body, re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        if len(tds) < 6:
            continue
        vals = [html.unescape(re.sub(r"<[^>]+>", "", t)).strip() for t in tds]
        name = vals[0]
        if not name or name == "货币名称":
            continue
        sell = _num(vals[3])          # 现汇卖出价
        if sell is None or sell <= 0:
            continue
        table[name] = sell
        if len(vals) > 6 and vals[6] and not published:
            published = vals[6]

    out = {}
    for cn, code in CURS.items():
        boc_name = BOC_NAMES.get(code)
        if boc_name and boc_name in table:
            # 牌价单位: 100 外币兑人民币
            out[cn] = round(table[boc_name] / 100.0, 4)

    if not out:
        raise RuntimeError("中行牌价解析出来是空的")

    # 发布日期 "2026/11/11 09:55:02" -> date "2026-11-11" + publishedAt "2026-11-11 09:55"
    date = ""
    published_at = ""
    m = re.search(r"(\d{4})/(\d{1,2})/(\d{1,2})", published)
    if m:
        date = "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))
        published_at = date
        t2 = re.search(r"(\d{1,2}):(\d{2})", published)
        if t2:
            published_at += " %s:%s" % (t2.group(1).zfill(2), t2.group(2))
    return out, date, "boc.cn", published_at


def fetch_erapi():
    """1 CNY = X 外币"""
    d = _get_json("https://open.er-api.com/v6/latest/CNY")
    if d.get("result") != "success":
        raise RuntimeError("er-api 返回异常: " + str(d)[:150])
    rates = d["rates"]
    out = {cn: round(1.0 / rates[cur], 4) for cn, cur in CURS.items()}
    raw = d.get("time_last_update_utc", "")
    try:
        date = datetime.datetime.strptime(raw[:16], "%a, %d %b %Y").strftime("%Y-%m-%d")
    except ValueError:
        date = raw[:10]
    return out, date, "open.er-api.com", ""


def fetch_frankfurter():
    """1 CNY = X 外币 (ECB 每日定盘)"""
    codes = ",".join(sorted(set(CURS.values())))
    d = _get_json("https://api.frankfurter.app/latest?from=CNY&to=" + codes)
    rates = d["rates"]
    out = {cn: round(1.0 / rates[cur], 4) for cn, cur in CURS.items()}
    return out, d.get("date", ""), "frankfurter.app", ""


def collect():
    """按优先级取汇率: 主源覆盖不到的币种用后备源补, 后备源不覆盖主源的值。"""
    merged = {}
    sources = []
    date = ""
    published_at = ""
    errs = []
    for fn in (fetch_boc, fetch_erapi, fetch_frankfurter):
        try:
            fx, d, src, pub = fn()
        except Exception as e:
            errs.append("%s: %s" % (fn.__name__, e))
            continue
        sources.append(src)
        if d and not date:
            date = d
        if pub and not published_at:
            published_at = pub
        for cn, v in fx.items():
            merged.setdefault(cn, v)
        if len(merged) >= len(CURS):
            break
    if not merged:
        raise RuntimeError("所有汇率源都失败: " + "; ".join(errs))
    if len(merged) < len(CURS):
        print("警告: 只拿到 %d/%d 个国家的汇率, 缺: %s"
              % (len(merged), len(CURS), "、".join(sorted(set(CURS) - set(merged)))),
              file=sys.stderr)
    return merged, date, "+".join(sources), published_at, errs


def main():
    try:
        fx, date, source, published_at, errs = collect()
    except Exception as e:
        print("抓汇率失败:", e, file=sys.stderr)
        return 1
    for e in errs:
        print("  (跳过)", e, file=sys.stderr)

    print("汇率取数日 %s  来源 %s%s"
          % (date, source, ("  发布时间 " + published_at) if published_at else ""))
    for cn in CURS:
        if cn in fx:
            print("  %-10s 1 %s = %s 元" % (cn, CURS[cn], fx[cn]))

    if "--stdout" in sys.argv:
        return 0

    payload = {
        "date": date,
        "updatedAt": datetime.datetime.now(datetime.timezone.utc)
                     .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source,
        "publishedAt": published_at,
        "rates": fx,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)
    print("已写入", os.path.normpath(OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
