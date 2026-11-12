#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
物流报价网站 —— 推到 GitHub (走 API, 不依赖 git push 的网络通路)

为什么需要这个:
    这台机器直连 github.com:443 不通 (SSH 443 / api.github.com 通),
    所以 `git push` 会失败。但 GitHub 的 Git Data API 走 api.github.com 是通的,
    所以改用 API 推 —— 效果和 git push 一样。

用法:
    python deploy/push_github_api.py                       # 推 main
    python deploy/push_github_api.py --repo 用户名/仓库名     # 换仓库
    python deploy/push_github_api.py --dry-run              # 只看会传什么

前提:
    本机装了 gh 并且登录过:  gh auth login
    (token 从 gh auth token 拿, 不落在文件里)

内容保证:
    上传的是 **git 索引里的原始 blob** (用 git cat-file 取), 不是工作区文件。
    Windows 上 core.autocrlf=true 时工作区是 CRLF、索引里是 LF ——
    传工作区文件会让远程存成 CRLF, shell 脚本在 Linux 上会报 "bad interpreter"。
"""
import argparse, base64, json, os, shutil, subprocess, sys, urllib.error, urllib.request

REPO = "Berg-E5/logistics-quote"
BRANCH = "main"

# Windows 上 PATH 里的 git/gh 可能指向 WindowsApps, 从别的 python 进程调它会被 ACL 拦
# (PermissionError: WinError 5)。所以要逐个候选真跑一下 --version, 跑得通才用。
GIT = None
GH = None


def _hermes_tools(name):
    """Hermes 自带工具目录里的可执行文件 (按版本倒序)"""
    local = os.environ.get("LOCALAPPDATA", "")
    if not local:
        return []
    import glob
    base = os.path.join(local, "hermes", "tools")
    out = []
    for pat in (os.path.join(base, name + "-*", "cmd", name + ".exe"),
                os.path.join(base, name + "-*", "bin", name + ".exe"),
                os.path.join(base, name + "-*", "**", name + ".exe")):
        out += sorted(glob.glob(pat), reverse=True)
    return out


def _find(name, extra=()):
    """逐个候选真跑一次 --version 才知道能不能用。
    只跑 --version 不够: WindowsApps 里的 git --version 能过, 别的子命令会被 ACL 拦。"""
    cands = []
    for c in extra + _hermes_tools(name):
        if c not in cands:
            cands.append(c)
    w = shutil.which(name)
    if w and w not in cands:
        cands.append(w)
    for c in cands:
        try:
            p = subprocess.run([c, "--version"], capture_output=True, timeout=20)
            if p.returncode != 0:
                continue
            if name == "git":
                p2 = subprocess.run([c, "rev-parse", "--git-dir"], capture_output=True, timeout=20)
                if p2.returncode != 0:
                    continue
            return c
        except Exception:
            continue
    return None


def find_git():
    extra = [r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files\Git\bin\git.exe",
             "/usr/bin/git", "/usr/local/bin/git"]
    return _find("git", extra) or "git"


def find_gh():
    extra = [r"C:\Program Files\GitHub CLI\gh.exe", "/usr/bin/gh", "/usr/local/bin/gh"]
    return _find("gh", extra) or "gh"


def sh(*args, binary=False, env=None):
    e = dict(os.environ)
    e.update(env or {})
    p = subprocess.run(list(args), capture_output=True, env=e)
    if p.returncode != 0:
        raise RuntimeError("%s 失败: %s" % (" ".join(args), p.stderr.decode("utf-8", "replace")[:300]))
    return p.stdout if binary else p.stdout.decode("utf-8", "replace").strip()


def get_token():
    global GH
    GH = GH or find_gh()
    try:
        t = sh(GH, "auth", "token")
        if t:
            return t.strip()
    except Exception:
        pass
    raise SystemExit("!! 拿不到 gh 的 token。先在本机跑:  gh auth login")


class Git:
    def __init__(self, repo, token):
        self.api = "https://api.github.com/repos/" + repo
        self.hdr = {
            "Authorization": "token " + token,
            "Content-Type": "application/json",
            "Accept": "application/vnd.github+json",
            "User-Agent": "quote-push",
        }

    def call(self, method, path, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(self.api + path, data=body, method=method, headers=self.hdr)
        try:
            r = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            raise RuntimeError("%s %s -> %s %s" % (method, path, e.code, e.read().decode("utf-8", "replace")[:250]))
        return json.loads(r.read().decode())

    def blob_exists(self, sha):
        try:
            self.call("GET", "/git/blobs/" + sha)
            return True
        except RuntimeError:
            return False

    def put_blob(self, content_bytes):
        r = self.call("POST", "/git/blobs", {
            "content": base64.b64encode(content_bytes).decode(),
            "encoding": "base64",
        })
        return r["sha"]


def local_index():
    """本地 main 的最后一个 commit 的 tree, 以及 (path, mode, sha) 列表"""
    tree = sh(GIT, "rev-parse", "main^{tree}")
    out = sh(GIT, "-c", "core.quotepath=false", "ls-tree", "-r", tree)
    items = []
    for line in out.split("\n"):
        if not line.strip():
            continue
        meta, path = line.split("\t", 1)
        mode, typ, sha = meta.split()
        items.append((path, mode, sha))
    return tree, items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=REPO)
    ap.add_argument("--branch", default=BRANCH)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--message", default=None)
    a = ap.parse_args()

    global GIT
    GIT = GIT or find_git()
    print("=== 推到 GitHub: %s (%s) ===" % (a.repo, a.branch))
    print("  git:", GIT)
    g = Git(a.repo, get_token())

    # 远程现状
    try:
        head = g.call("GET", "/git/ref/heads/" + a.branch)
        remote_sha = head["object"]["sha"]
        print("  远程 HEAD:", remote_sha[:12])
    except Exception:
        remote_sha = None
        print("  远程还没有这个分支")

    tree, items = local_index()
    print("  本地 tree :", tree[:12], "| 文件", len(items))

    # 哪些 blob 远程没有 -> 用 git cat-file 取索引里的原始内容上传
    print("\n[1/3] 传 blob")
    uploaded = 0
    for path, mode, sha in items:
        if g.blob_exists(sha):
            continue
        content = sh(GIT, "cat-file", "blob", sha, binary=True)
        new_sha = g.put_blob(content)
        if new_sha != sha:
            raise SystemExit("!! %s 的 blob sha 对不上 (本地 %s / 远程 %s)" % (path, sha[:12], new_sha[:12]))
        uploaded += 1
    print("  新传 %d 个, 复用 %d 个" % (uploaded, len(items) - uploaded))

    # 建 tree
    print("\n[2/3] 建 tree")
    entries = [{"path": p, "mode": m, "type": "blob", "sha": s} for p, m, s in items]
    t = g.call("POST", "/git/trees", {"tree": entries})
    print("  tree:", t["sha"][:12], "| 与本地一致:", t["sha"] == tree)

    # 建 commit (parent = 远程 HEAD)
    print("\n[3/3] 建 commit + 更新分支")
    msg = a.message or ("同步 %d 个文件 (%s)" % (len(items), tree[:8]))
    # 日期统一用 UTC: GitHub 存 UTC, 本地也用 UTC 才不会每次 sha 都变
    stamp = sh(GIT, "log", "-1", "--format=%cI", "main")
    payload = {
        "message": msg,
        "tree": t["sha"],
        "parents": [remote_sha] if remote_sha else [],
        "author": {"name": sh(GIT, "config", "user.name"), "email": sh(GIT, "config", "user.email"), "date": stamp},
        "committer": {"name": sh(GIT, "config", "user.name"), "email": sh(GIT, "config", "user.email"), "date": stamp},
    }
    c = g.call("POST", "/git/commits", payload)
    print("  commit:", c["sha"][:12])
    if a.dry_run:
        print("\n(--dry-run, 没有更新分支)")
        return
    g.call("PATCH", "/git/refs/heads/" + a.branch, {"sha": c["sha"], "force": True})
    print("\n完成: https://github.com/%s/tree/%s" % (a.repo, a.branch))
    print("  commit:", c["sha"])
    print("  文件数:", len(items))


if __name__ == "__main__":
    main()
