#!/usr/bin/env bash
#
# 物流报价网站 —— 一条命令在远程服务器上装好
#
# 用法 (在本地项目根目录跑):
#   bash deploy/install-remote.sh root@新服务器 quote.example.com
#   bash deploy/install-remote.sh root@新服务器 quote.example.com /var/www/quote.example.com
#   bash deploy/install-remote.sh root@新服务器 quote.example.com '' skip-ssl
#
# 做的事:
#   1. 从发布服务器 (/root/quote-release/) 取最新安装包 (本地有就用本地)
#   2. scp 传到目标服务器
#   3. 在目标服务器上解压 + 跑 install.sh
#      (装 systemd + nginx + 证书 + 建 admin 账号 + 自检)
#
# 目标服务器要做的准备: node 18+ / nginx / python3, 以及能 ssh 回来的密钥
#
# 不想用 Docker 的话用这个; 有 Docker 的话更短:
#   docker login && docker run -d --name quote -p 127.0.0.1:8792:8792 \
#     -v /var/lib/quote/data:/app/data -e ADMIN_PASSWORD='xxx' utism/quote:latest
#
set -euo pipefail

TARGET="${1:-}"
DOMAIN="${2:-}"
DIR="${3:-}"
SKIP_SSL="${4:-}"

if [ -z "$TARGET" ] || [ -z "$DOMAIN" ]; then
  echo "用法: bash deploy/install-remote.sh <目标服务器> <域名> [安装目录] [skip-ssl]"
  echo "  例: bash deploy/install-remote.sh root@1.2.3.4 quote.example.com"
  exit 1
fi

LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_HOST="${QUOTE_RELEASE_HOST:-root@169.40.117.164}"
RELEASE_DIR="/root/quote-release"
SSH_OPTS="-o StrictHostKeyChecking=accept-new"
WORK="/tmp/quote-remote-$$"

echo "=== 远程安装 ==="
echo "    目标: $TARGET"
echo "    域名: $DOMAIN"
echo

# ---------- 1. 拿包 ----------
echo "[1/4] 取安装包"
PKG=""
if [ -f "$LOCAL/deploy/quote-install-latest.tar.gz" ]; then
  PKG="$LOCAL/deploy/quote-install-latest.tar.gz"
  echo "    用本地: $(basename "$PKG")"
elif [ -f "$RELEASE_DIR/quote-install-latest.tar.gz" ]; then
  # 脚本就在发布服务器上跑
  PKG="$RELEASE_DIR/quote-install-latest.tar.gz"
  echo "    用发布目录: $PKG"
else
  mkdir -p "$WORK"
  PKG="$WORK/quote-install-latest.tar.gz"
  echo "    从发布服务器拉: $RELEASE_HOST"
  scp $SSH_OPTS -q "$RELEASE_HOST:$RELEASE_DIR/quote-install-latest.tar.gz" "$PKG"
  echo "    拉好了 ($(du -h "$PKG" | cut -f1))"
fi

# ---------- 2. 传过去 ----------
echo
echo "[2/4] 传到 $TARGET"
scp $SSH_OPTS -q "$PKG" "$TARGET:/tmp/quote-install-latest.tar.gz"
echo "    传好了"

# ---------- 3. 远程安装 ----------
echo
echo "[3/4] 在 $TARGET 上安装"
if [ -n "$DIR" ]; then
  INSTALL_ARGS="'$DOMAIN' '$DIR' '$SKIP_SSL'"
else
  INSTALL_ARGS="'$DOMAIN' '' '$SKIP_SSL'"
fi
ssh $SSH_OPTS "$TARGET" "
set -e
mkdir -p /opt/quote
tar xzf /tmp/quote-install-latest.tar.gz -C /opt/quote
cd /opt/quote
bash deploy/install.sh $INSTALL_ARGS
"

# ---------- 4. 清理 ----------
echo
echo "[4/4] 清理临时文件"
ssh $SSH_OPTS "$TARGET" "rm -f /tmp/quote-install-latest.tar.gz" || true
rm -rf "$WORK"

echo
echo "=========================================================="
echo " 装好了。回上面看后台地址和 admin 密码。"
echo "=========================================================="
