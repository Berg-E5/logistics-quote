"""
把本地抽取好的报价数据推送到后台服务器。

用法:
    python 推送报价.py
    python 推送报价.py --url https://xxx --user admin --pass 密码

    前提:
    脚本/后台地址.txt 里写两行:
        地址 (https://quote.byberg.store)
        用户名 (admin)
    密码三种给法 (优先级从高到低):
        python 推送报价.py --pass 你的密码
        set QUOTE_ADMIN_PASSWORD=你的密码 && python 推送报价.py
        python 推送报价.py          # 交互输入, 不回显
    用的是后台网页同一套账号密码 —— 先登录拿会话 cookie, 再推送。
"""
import http.cookiejar
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = os.path.join(HERE, "后台地址.txt")
JS = os.path.join(HERE, "data_v2.js")

# 保持会话 cookie
_opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def read_cfg():
    """地址/用户名从 后台地址.txt 读; 密码按这个顺序找, 绝不落盘明文:

    1. 命令行 --pass
    2. 环境变量 QUOTE_ADMIN_PASSWORD
    3. 交互输入 (getpass, 不回显)
    4. 后台地址.txt 的第三行 (旧格式, 用过一次就会提示删掉)
    """
    url = user = pw = None
    if os.path.exists(CFG):
        lines = [l.strip() for l in open(CFG, encoding="utf-8").read().split("\n")
                 if l.strip()]
        if len(lines) > 0:
            url = lines[0]
        if len(lines) > 1:
            user = lines[1]
        if len(lines) > 2:
            pw = lines[2]          # 旧格式: 明文密码
    if "--url" in sys.argv:
        i = sys.argv.index("--url")
        if i + 1 < len(sys.argv): url = sys.argv[i + 1]
    if "--user" in sys.argv:
        i = sys.argv.index("--user")
        if i + 1 < len(sys.argv): user = sys.argv[i + 1]
    if "--pass" in sys.argv:
        i = sys.argv.index("--pass")
        if i + 1 < len(sys.argv): pw = sys.argv[i + 1]
    env_pw = os.environ.get("QUOTE_ADMIN_PASSWORD")
    if env_pw:
        pw = env_pw
    if not pw:
        try:
            import getpass
            pw = getpass.getpass("请输入 %s 的密码: " % user)
        except Exception:
            pw = input("请输入 %s 的密码: " % user)
    return url, user, pw


def run_pipeline():
    """跑一遍抽取流水线, 生成 脚本\\data_v2.js"""
    steps = ["extract3.py", "extract_divider.py", "extract_surcharges.py",
             "extract_div_rules.py", "extract_calc_rules.py",
             "pack_data.py", "merge_data.py"]
    for s in steps:
        p = os.path.join(HERE, s)
        if not os.path.exists(p):
            print(f"  (跳过 {s})")
            continue
        print(f"  → {s}")
        r = subprocess.run([sys.executable, p], cwd=HERE, capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stdout[-800:]); print(r.stderr[-800:])
            print(f"{s} 失败")
            sys.exit(1)


def http_json(url, method="GET", body=None, timeout=120):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json; charset=utf-8"} if data else {}
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with _opener.open(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        sys.exit(f"请求失败 HTTP {e.code}: {detail}")
    except Exception as e:
        sys.exit(f"请求失败: {e}")


def login(url, user, pw):
    r = http_json(url.rstrip("/") + "/api/login", "POST",
                  {"username": user, "password": pw}, timeout=30)
    print(f"  登录成功: {r.get('user')}")


def push(url, data):
    return http_json(url.rstrip("/") + "/api/import", "POST",
                     {"data": data, "note": "整表导入"})


def main():
    url, user, pw = read_cfg()
    if os.path.exists(CFG):
        lines = [l.strip() for l in open(CFG, encoding="utf-8").read().split("\n") if l.strip()]
        if len(lines) > 2 and lines[2] == pw:
            print("提示: 后台地址.txt 里存着明文密码, 已帮你删掉这一行。")
            open(CFG, "w", encoding="utf-8").write("\n".join(lines[:2]) + "\n")
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--url" and i + 1 < len(args):
            url = args[i + 1]
        if a == "--user" and i + 1 < len(args):
            user = args[i + 1]
        if a == "--pass" and i + 1 < len(args):
            pw = args[i + 1]
    if not url:
        sys.exit("没找到后台地址。请在 脚本\\后台地址.txt 写第一行, 或用 --url 指定。")
    if not user or not pw:
        sys.exit("没找到账号密码。请在 脚本\\后台地址.txt 写第二、三行 "
                 "(用户名 / 密码), 或用 --user / --pass 指定。")

    print(f"目标后台: {url}")
    print(f"账号: {user}")

    print("\n[1/3] 抽取")
    run_pipeline()

    print("\n[2/3] 读取数据")
    raw = open(JS, encoding="utf-8").read()
    i, j = raw.find("{"), raw.rfind("}")
    if i < 0 or j < 0:
        sys.exit("data_v2.js 格式不对")
    data = json.loads(raw[i:j + 1])
    meta = data.get("meta", {})
    print(f"  {meta.get('channels')} 个渠道 · {len(data.get('tiers', []))} 条费率档")

    print("\n[3/3] 登录并推送")
    login(url, user, pw)
    r = push(url, data)
    print(f"  成功 · 数据版本 v{r.get('rev')} · {r.get('updatedAt')}")
    print("\n完成。前端一分钟内会自动同步, 或刷新页面。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
