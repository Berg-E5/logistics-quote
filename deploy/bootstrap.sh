#!/usr/bin/env bash
#
# 物流报价网站 —— 一条命令安装 (curl | bash 友好)
#
#   curl -fsSL https://raw.githubusercontent.com/Berg-E5/logistics-quote/main/deploy/bootstrap.sh \
#     | sudo bash -s -- <你的域名> [安装目录] [skip-ssl]
#
# 做的事:
#   1. 从 GitHub 下载程序包 (公开仓库, 不需要登录)
#   2. 跑 install.sh: 自动装 Node/nginx/Python/证书 + 建 admin 账号 + 自检
#
# 数据说明:
#   这个脚本装的是**程序**, GitHub 仓库里不含报价数据 (报价表和账号数据都不在公开仓库里)。
#   装完是空站 —— 登录后自己上传报价表做整表导入。
#   想直接用现成数据, 改用带数据的发布包:
#     bash deploy/install-remote.sh root@目标服务器 <域名>
#
# 程序包从 GitHub 拉:
#   https://github.com/Berg-E5/logistics-quote/archive/refs/heads/main.tar.gz
#
# 想自己用 Docker 的话, 仓库里有 Dockerfile 和 docker-compose.yml, 从源码 build 即可:
#   git clone https://github.com/Berg-E5/logistics-quote.git && cd logistics-quote
#   docker compose up -d
#
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "!! 请用 sudo 运行这条安装命令" >&2
  exit 1
fi

DOMAIN="${1:-}"
DIR="${2:-}"
SKIP_SSL="${3:-}"
REPO_URL="https://github.com/Berg-E5/logistics-quote"
WORK="/opt/quote-bootstrap"

if [ -z "$DOMAIN" ]; then
  echo "用法:"
  echo "  curl -fsSL $REPO_URL/raw/main/deploy/bootstrap.sh | sudo bash -s -- <你的域名> [安装目录] [skip-ssl]"
  echo
  echo "  例:"
  echo "  curl -fsSL $REPO_URL/raw/main/deploy/bootstrap.sh | sudo bash -s -- quote.example.com"
  echo
  echo "  想用 Docker 的话, clone 下来用 docker compose up -d (从源码 build)"
  exit 1
fi

echo "=== 物流报价网站 安装 ==="
echo "    域名: $DOMAIN"
if command -v docker >/dev/null 2>&1; then
  echo "    (第二个参数 = 安装目录; 留空用 /var/www/<域名>)"
fi

# ---------- 1. 下载程序 ----------
echo
echo "[1/3] 下载程序"
if ! command -v tar >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y tar
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y tar
  elif command -v yum >/dev/null 2>&1; then
    yum install -y tar
  else
    echo "!! 缺少 tar，且无法识别包管理器" >&2
    exit 1
  fi
fi

echo "    下载程序包..."
mkdir -p "$WORK"
if ! curl -fsSL --retry 3 "$REPO_URL/archive/refs/heads/main.tar.gz" | tar xz -C "$WORK" 2>/dev/null; then
  echo "!! 下载失败。检查这台机器能不能访问 github.com"
  echo "   (或者手动 clone: git clone $REPO_URL && cd logistics-quote && sudo bash deploy/install.sh <域名>)"
  exit 1
fi
PKGDIR="$WORK/logistics-quote-main"
[ -d "$PKGDIR" ] || PKGDIR=$(find "$WORK" -maxdepth 1 -type d -name 'logistics-quote*' | head -1)
echo "    解到了: $PKGDIR"

echo
echo "[2/3] 安装（会自动安装 Node 18+、nginx、Python、openpyxl 和 certbot）"
cd "$PKGDIR"
if [ -n "$DIR" ]; then
  bash deploy/install.sh "$DOMAIN" "$DIR" "$SKIP_SSL"
else
  bash deploy/install.sh "$DOMAIN" '' "$SKIP_SSL"
fi

echo
echo "[3/3] 清理"
rm -rf "$WORK"

echo
echo "=========================================================="
echo " 装好了。回上面看后台地址和 admin 密码。"
echo
echo " 数据: 这条命令装的是**程序**, 不含报价数据 —— 登录后是空站。"
echo "       自己在后台「整表导入」上传报价表 xlsx 即可。"
echo "       想直接用现成数据: bash deploy/install-remote.sh root@<这台机器> <域名>"
echo "=========================================================="
