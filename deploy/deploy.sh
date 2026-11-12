#!/bin/bash
# 物流报价网站 —— 一键部署到服务器
#
# 用法 (在本地跑):
#   bash deploy/deploy.sh <服务器> <域名>
#   bash deploy/deploy.sh root@169.40.117.164 quote.byberg.store
#
# 做的事:
#   1. rsync/scp 上传 server/ public/ deploy/ 到服务器
#   2. 装 systemd 单元并启动
#   3. 装 nginx 站点配置并 reload
#   4. 申请 https 证书 (如果还没证书)
#   5. 验证

set -euo pipefail

HOST="${1:-root@169.40.117.164}"
DOMAIN="${2:-quote.byberg.store}"
LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR="/var/www/${DOMAIN}"
SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new"

echo "=== 部署目标: ${HOST} (${DOMAIN}) ==="

# ---------- 1. 上传 ----------
echo "[1/5] 上传文件"
ssh $SSH_OPTS "$HOST" "mkdir -p '${REMOTE_DIR}'"
for d in server public deploy; do
  echo "  → ${d}/"
  scp -r $SSH_OPTS -q "${LOCAL}/${d}" "$HOST:${REMOTE_DIR}/"
done
# 数据文件 (已有数据时不覆盖, 保留后台改过的价)
ssh $SSH_OPTS "$HOST" "mkdir -p '${REMOTE_DIR}/data'"

# ---------- 2. 后端 ----------
echo "[2/5] 启动后端"
ssh $SSH_OPTS "$HOST" "
  set -e
  if ! command -v node >/dev/null 2>&1; then
    echo '  没装 node, 正在装...'
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  node -v
  cp '${REMOTE_DIR}/deploy/quote-server.service' /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable quote-server
  systemctl restart quote-server
  sleep 2
  systemctl --no-pager --lines=5 status quote-server || true
"

# ---------- 3. nginx ----------
echo "[3/5] 配置 nginx"
ssh $SSH_OPTS "$HOST" "
  set -e
  cp '${REMOTE_DIR}/deploy/nginx-quote.conf' /etc/nginx/sites-available/${DOMAIN}
  ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}
  nginx -t
  systemctl reload nginx
"

# ---------- 4. 证书 ----------
echo "[4/5] 申请 https 证书"
if ssh $SSH_OPTS "$HOST" "test -f /etc/letsencrypt/live/${DOMAIN}/fullchain.pem"; then
  echo "  证书已存在, 跳过"
else
  ssh $SSH_OPTS "$HOST" "
    apt-get install -y certbot python3-certbot-nginx || true
    certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos \
      --register-unsafely-without-email || \
    certbot --nginx -d ${DOMAIN} --register-unsafely-without-email
  "
fi

# ---------- 5. 验证 ----------
echo "[5/5] 验证"
ssh $SSH_OPTS "$HOST" "
  echo '  本机:'
  curl -s -o /dev/null -w '    /api/version  %{http_code}\n' http://127.0.0.1:8792/api/version
  curl -s http://127.0.0.1:8792/api/version; echo
"
echo "  公网:"
curl -s -o /dev/null -w "    https://${DOMAIN}/          %{http_code}\n" "https://${DOMAIN}/"
curl -s -o /dev/null -w "    https://${DOMAIN}/api/version %{http_code}\n" "https://${DOMAIN}/api/version"

echo
echo "=== 部署完成 ==="
echo "  前端:   https://${DOMAIN}/"
echo "  后台:   https://${DOMAIN}/admin"
echo "  管理令牌: ssh ${HOST} 'cat ${REMOTE_DIR}/data/admin.token'"
echo
echo "  本地推送新报价: 在 脚本\\后台地址.txt 写好地址和令牌, 然后"
echo "    python 脚本\\推送报价.py"
