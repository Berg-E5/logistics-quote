#!/usr/bin/env bash
#
# 物流报价网站 —— 一条命令安装 (curl | bash 友好)
#
#   curl -fsSL https://raw.githubusercontent.com/Berg-E5/logistics-quote/main/deploy/bootstrap.sh \
#     | sudo bash -s -- <你的域名> [安装目录] [skip-ssl]
#
# 做的事:
#   1. 检查 docker:
#      有 -> 直接跑 Docker 版 (最省事, 不用 node/nginx/python)
#      没有 -> 下载程序包 + 跑 install.sh (装 systemd + nginx + 证书)
#   2. 建 admin 账号并打印密码
#   3. 自检
#
# 程序包从 GitHub 拉 (公开仓库, 不需要登录):
#   https://github.com/Berg-E5/logistics-quote/archive/refs/heads/main.tar.gz
#
# 只想用 Docker 的话更短:
#   docker run -d --name quote --restart unless-stopped \
#     -p 127.0.0.1:8792:8792 -v /var/lib/quote/data:/app/data \
#     -e ADMIN_PASSWORD='你的密码' utism/quote:latest
#
set -euo pipefail

DOMAIN="${1:-}"
DIR="${2:-}"
SKIP_SSL="${3:-}"
REPO_URL="https://github.com/Berg-E5/logistics-quote"
IMAGE="utism/quote:latest"
WORK="/opt/quote-bootstrap"

if [ -z "$DOMAIN" ]; then
  echo "用法:"
  echo "  curl -fsSL $REPO_URL/raw/main/deploy/bootstrap.sh | sudo bash -s -- <你的域名> [安装目录] [skip-ssl]"
  echo
  echo "  例:"
  echo "  curl -fsSL $REPO_URL/raw/main/deploy/bootstrap.sh | sudo bash -s -- quote.example.com"
  echo
  echo "  只想用 Docker (最短):"
  echo "  docker run -d --name quote --restart unless-stopped \\"
  echo "    -p 127.0.0.1:8792:8792 -v /var/lib/quote/data:/app/data \\"
  echo "    -e ADMIN_PASSWORD='你的密码' $IMAGE"
  exit 1
fi

echo "=== 物流报价网站 安装 ==="
echo "    域名: $DOMAIN"
if command -v docker >/dev/null 2>&1; then
  echo "    (第二个参数 = 数据目录; 留空用 /var/lib/quote/data)"
else
  echo "    (第二个参数 = 安装目录; 留空用 /var/www/<域名>)"
fi

# ---------- 1. 有 docker 就走 docker ----------
if command -v docker >/dev/null 2>&1; then
  echo
  echo "[1/3] 检测到 docker, 用 Docker 方式装"
  # Docker 模式下第二个参数就是「数据目录」(原生模式下是「安装目录」)
  if [ -n "$DIR" ]; then
    DATA_DIR="$DIR"
  else
    DATA_DIR="/var/lib/quote/data"
  fi
  mkdir -p "$DATA_DIR"
  ADMIN_PASS="${ADMIN_PASSWORD:-}"
  echo "    数据目录: $DATA_DIR"
  docker rm -f quote >/dev/null 2>&1 || true
  if [ -n "$ADMIN_PASS" ]; then
    docker run -d --name quote --restart unless-stopped \
      -p 127.0.0.1:8792:8792 \
      -v "$DATA_DIR:/app/data" \
      -e ADMIN_PASSWORD="$ADMIN_PASS" \
      "$IMAGE" >/dev/null
  else
    docker run -d --name quote --restart unless-stopped \
      -p 127.0.0.1:8792:8792 \
      -v "$DATA_DIR:/app/data" \
      "$IMAGE" >/dev/null
  fi
  sleep 6
  echo
  echo "[2/3] 容器状态"
  docker ps --filter name=quote --format '    {{.Status}}  {{.Ports}}'
  echo
  echo "[3/3] 自检"
  for u in / /admin /admin/changes /admin/users; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8792$u" || echo 000)
    printf '    %-16s %s\n' "$u" "$code"
  done
  echo
  echo "=========================================================="
  echo " 装好了 (Docker)。"
  echo
  echo "   前台:   http://127.0.0.1:8792/"
  echo "   后台:   http://127.0.0.1:8792/admin"
  echo "   账号:   admin"
  echo "   密码:   docker logs quote  (或 docker logs quote | grep 密码)"
  echo
  echo "   注意: 端口只绑在本机 127.0.0.1。要对外访问, 在宿主机上配 nginx 反代:"
  echo "     proxy_pass http://127.0.0.1:8792;"
  echo "=========================================================="
  exit 0
fi

# ---------- 2. 没 docker: 下载程序 + 装 ----------
echo
echo "[1/3] 没检测到 docker, 走原生安装 (需要 node 18+ / nginx / python3)"
command -v node >/dev/null 2>&1 || {
  echo "!! 没装 node。先装:"
  echo "   apt-get update && apt-get install -y nginx python3 python3-pip"
  echo "   curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"
  exit 1
}

echo "    下载程序包..."
mkdir -p "$WORK"
if ! curl -fsSL --retry 3 "$REPO_URL/archive/refs/heads/main.tar.gz" | tar xz -C "$WORK" 2>/dev/null; then
  echo "!! 下载失败。检查这台机器能不能访问 github.com"
  echo "   (可以用 Docker 方式: 装个 docker 再跑这个脚本, 或者直接用前面那条 docker run)"
  exit 1
fi
PKGDIR="$WORK/logistics-quote-main"
[ -d "$PKGDIR" ] || PKGDIR=$(find "$WORK" -maxdepth 1 -type d -name 'logistics-quote*' | head -1)
echo "    解到了: $PKGDIR"

echo
echo "[2/3] 安装"
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
echo "=========================================================="
