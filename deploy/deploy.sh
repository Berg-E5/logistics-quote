#!/usr/bin/env bash
# 物流报价网站 —— 更新已安装的服务器
#
# 用法:
#   bash deploy/deploy.sh root@169.40.117.164 quote.byberg.store
#
# 数据目录不会被覆盖。部署前会先生成一次加密备份，然后更新 Python venv、
# systemd、nginx 和安全响应头，最后做本机与公网自检。
set -euo pipefail

HOST="${1:-root@169.40.117.164}"
DOMAIN="${2:-quote.byberg.store}"
LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_DIR="/var/www/${DOMAIN}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)

if ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$'; then
  echo "域名不合法: $DOMAIN" >&2
  exit 1
fi

echo "=== 部署目标: ${HOST} (${DOMAIN}) ==="
echo "[1/6] 上传程序文件"
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$REMOTE_DIR'"
tar czf - -C "$LOCAL" server public deploy |
  ssh "${SSH_OPTS[@]}" "$HOST" "tar xzf - -C '$REMOTE_DIR'"

echo "[2/6] 更新锁定 Python 环境并备份当前数据"
ssh "${SSH_OPTS[@]}" "$HOST" "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  command -v node >/dev/null 2>&1 || { echo '服务器缺 Node 18+'; exit 1; }
  node -v
  command -v python3 >/dev/null 2>&1 || { echo '服务器缺 python3'; exit 1; }
  python3 -m venv '$REMOTE_DIR/.venv' 2>/dev/null ||
    { apt-get update && apt-get install -y --no-install-recommends python3-venv &&
      python3 -m venv '$REMOTE_DIR/.venv'; }
  '$REMOTE_DIR/.venv/bin/python' -m pip install --disable-pip-version-check --no-cache-dir \
    --only-binary=:all: --no-deps --require-hashes \
    -r '$REMOTE_DIR/deploy/python-requirements.txt'
  id -u quote >/dev/null 2>&1 || useradd --system --home-dir '$REMOTE_DIR' --shell /usr/sbin/nologin quote
  chown -R quote:quote '$REMOTE_DIR/.venv'
  install -m 0700 '$REMOTE_DIR/deploy/backup.sh' /usr/local/sbin/quote-backup
  install -m 0644 '$REMOTE_DIR/deploy/quote-backup.service' /etc/systemd/system/quote-backup.service
  install -m 0644 '$REMOTE_DIR/deploy/quote-backup.timer' /etc/systemd/system/quote-backup.timer
  if [ ! -f /etc/quote-backup.env ]; then
    printf 'SITE=%s\nDEST=/root/backups\nKEEP=14\nKEY_FILE=/root/.quote-backup.key\n' \
      '$REMOTE_DIR' > /etc/quote-backup.env
    chmod 600 /etc/quote-backup.env
  fi
  systemctl daemon-reload
  systemctl enable --now quote-backup.timer
  systemctl start quote-backup.service
"

echo "[3/6] 更新并重启后端"
ssh "${SSH_OPTS[@]}" "$HOST" "
  set -e
  sed 's#/var/www/quote.byberg.store#$REMOTE_DIR#g' \
    '$REMOTE_DIR/deploy/quote-server.service' > /etc/systemd/system/quote-server.service
  systemctl daemon-reload
  systemctl enable quote-server
  systemctl restart quote-server
  sleep 2
  systemctl is-active --quiet quote-server
  journalctl -u quote-server -n 8 --no-pager
"

echo "[4/6] 更新 nginx"
ssh "${SSH_OPTS[@]}" "$HOST" "
  set -e
  cp '$REMOTE_DIR/deploy/nginx-quote.conf' /etc/nginx/sites-available/${DOMAIN}
  ln -sf /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}
  nginx -t
  systemctl reload nginx
"

echo "[5/6] 检查 HTTPS 证书"
if ssh "${SSH_OPTS[@]}" "$HOST" "test -f /etc/letsencrypt/live/${DOMAIN}/fullchain.pem"; then
  echo "  证书已存在；日常续签由 certbot.timer 负责"
else
  ssh "${SSH_OPTS[@]}" "$HOST" "
    apt-get install -y certbot python3-certbot-nginx
    certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos --redirect \
      --register-unsafely-without-email
  "
fi

echo "[6/6] 自检"
ssh "${SSH_OPTS[@]}" "$HOST" "
  set -e
  code=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8792/api/version)
  [ \"\$code\" = 200 ]
  curl -sI https://${DOMAIN}/ | grep -qi 'content-security-policy:'
  curl -sI https://${DOMAIN}/ | grep -qi 'strict-transport-security:'
  systemctl is-active --quiet quote-server
  systemctl is-active --quiet quote-backup.timer
  echo '  后端、HTTPS、CSP、HSTS、每日备份均正常'
"

echo
echo "=== 部署完成 ==="
echo "  前端: https://${DOMAIN}/"
echo "  后台: https://${DOMAIN}/admin"
