#!/usr/bin/env bash
#
# 物流报价网站 —— 在一台新服务器上, 一条命令拉包并安装
#
# 用法 (在新服务器上跑, root 权限):
#   bash fetch-release.sh <你的域名>
#   bash fetch-release.sh <你的域名> /var/www/quote.example.com
#   bash fetch-release.sh <你的域名> /var/www/quote.example.com skip-ssl
#
# 做的事:
#   1. 从发布服务器 (/root/quote-release/) 拉 quote-install-latest.tar.gz
#   2. 校验 SHA256
#   3. 解到 /opt/quote
#   4. 调 install.sh 完成安装 (systemd + nginx + 证书 + admin 账号)
#
# 需要: 能 ssh 到发布服务器 (有密钥或用密码), 以及 node/nginx/python3
#
set -euo pipefail

DOMAIN="${1:-}"
DIR="${2:-/var/www/quote.byberg.store}"
SKIP_SSL="${3:-}"
SRC="${QUOTE_RELEASE_HOST:-root@169.40.117.164}"
RELEASE_DIR="/root/quote-release"
SSH_OPTS="-o StrictHostKeyChecking=accept-new"

if [ -z "$DOMAIN" ]; then
  echo "用法: sudo bash fetch-release.sh <你的域名> [安装目录] [skip-ssl]"
  echo "  例: sudo bash fetch-release.sh quote.example.com"
  echo "  发布源可以用环境变量换: QUOTE_RELEASE_HOST=user@host"
  exit 1
fi

WORK=/tmp/quote-fetch
mkdir -p "$WORK"
cd "$WORK"

echo "==> [1/4] 从 $SRC 拉发布包"
if ! scp $SSH_OPTS -q "$SRC:$RELEASE_DIR/quote-install-latest.tar.gz" . 2>/dev/null; then
  echo "!! 拉不到发布包。请检查:"
  echo "   - 能不能 ssh 到 $SRC:  ssh $SRC"
  echo "   - 或者手工下载后重跑本脚本 (包里已有 deploy/install.sh)"
  exit 1
fi
ls -la quote-install-latest.tar.gz

echo
echo "==> [2/4] 校验"
if scp $SSH_OPTS -q "$SRC:$RELEASE_DIR/SHA256SUMS" . 2>/dev/null && command -v sha256sum >/dev/null 2>&1; then
  if sha256sum -c SHA256SUMS --ignore-missing 2>&1 | grep -q ': OK'; then
    echo "    校验通过"
  else
    echo "!! 校验失败, 包可能传坏了, 停在这里"
    sha256sum -c SHA256SUMS --ignore-missing || true
    exit 1
  fi
else
  echo "    (拿不到校验文件, 跳过)"
fi

echo
echo "==> [3/4] 解包到 /opt/quote"
mkdir -p /opt/quote
tar xzf quote-install-latest.tar.gz -C /opt/quote
echo "    解好了: $(ls /opt/quote | tr '\n' ' ')"

echo
echo "==> [4/4] 安装"
cd /opt/quote
bash deploy/install.sh "$DOMAIN" "$DIR" "$SKIP_SSL"

echo
echo "=========================================================="
echo " 装完了。回上面看后台地址和 admin 密码。"
echo "=========================================================="
