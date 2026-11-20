#!/usr/bin/env bash
#
# 物流报价网站 —— 一键安装到一台新服务器
#
#   sudo bash install.sh <域名> [安装目录] [跳过SSL]
#
#   例: sudo bash install.sh quote.example.com
#       sudo bash install.sh quote.example.com /var/www/quote.example.com skip-ssl
#
# 做的事:
#   1. 自动安装 Node 18+ / nginx / python3 / openpyxl / certbot
#   2. 把程序文件复制到安装目录
#   3. 装 systemd 单元并启动
#   4. 装 nginx 反代并申请 HTTPS 证书
#   5. 启用证书自动续签
#   6. 建 admin 账号 (密码随机, 打印在最后)
#   7. 自检
#
# 数据说明:
#   从发布包 (install-remote.sh / fetch-release.sh 取得) 装的 -> 自带现成报价数据
#   从 GitHub 源码装的 (bootstrap.sh / git clone) -> 空站, 只有程序, 装完提示会说明
#
# 这个脚本可以在新服务器上跑, 也可以反复跑 (幂等: 重复跑会覆盖程序文件, 不动数据目录)
#
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "!! 请用 root 运行，例如: sudo bash deploy/install.sh <域名>" >&2
  exit 1
fi

DOMAIN="${1:-}"
DIR="${2:-}"
SKIP_SSL="${3:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
PORT=8792
SVC=quote-server
SVC_USER=quote
SSL_OK=0

if [ -z "$DOMAIN" ]; then
  echo "用法: sudo bash install.sh <域名> [安装目录] [skip-ssl]"
  echo "  域名不要带 https://, 例如 quote.example.com"
  exit 1
fi
if ! echo "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$'; then
  echo "域名不合法: $DOMAIN"
  exit 1
fi
if [ -z "$DIR" ]; then
  DIR="/var/www/$DOMAIN"
fi

# 部署包的根目录 (install.sh 在 deploy/ 下, 上一级就是根)
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "==> 部署包目录: $SRC"
# 自检: install.sh 必须放在部署包自己的 deploy/ 目录下。
# 单独把它复制到别处跑的话, SRC 会算错 (比如变成 /), 复制出来的目录是空的,
# 服务起来就报 "Cannot find module .../server/server.js"。
if [ ! -d "$SRC/server" ] || [ ! -f "$SRC/server/server.js" ]; then
  echo
  echo "!! 找不到程序文件 (期望 $SRC/server/server.js)"
  echo "   install.sh 必须从部署包里跑, 比如:"
  echo "     cd <部署包目录> && bash deploy/install.sh <域名>"
  echo "   部署包目录: $SRC"
  exit 1
fi
echo "==> 域名: $DOMAIN"
echo "==> 安装目录: $DIR"
echo

# ---------------------------------------------------------------- 1. 依赖
echo "==> [1/7] 检测并安装系统依赖"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "${major:-0}" -ge 18 ]
}

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  export NEEDRESTART_MODE=a
  echo "    包管理器: apt"
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg tar openssl nginx python3 python3-pip python3-venv
  apt-get install -y --no-install-recommends certbot python3-certbot-nginx
  if ! node_ok; then
    echo "    安装 Node.js 22 LTS (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then PKG=dnf; else PKG=yum; fi
  echo "    包管理器: $PKG"
  $PKG install -y ca-certificates curl tar openssl nginx python3 python3-pip
  if ! $PKG install -y certbot python3-certbot-nginx; then
    echo "    补充 EPEL 源后重试 certbot"
    $PKG install -y epel-release || true
    $PKG install -y certbot python3-certbot-nginx
  fi
  if ! node_ok; then
    echo "    安装 Node.js 22 LTS (NodeSource)"
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    $PKG install -y nodejs
  fi
  if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
    $PKG install -y policycoreutils-python-utils || true
    setsebool -P httpd_can_network_connect 1 2>/dev/null || true
  fi
else
  echo "!! 暂不支持当前系统：找不到 apt-get、dnf 或 yum" >&2
  exit 1
fi

hash -r
node_ok || { echo "!! Node.js 安装后仍不是 18+" >&2; exit 1; }
command -v nginx >/dev/null 2>&1 || { echo "!! nginx 安装失败" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "!! python3 安装失败" >&2; exit 1; }
if [ "$SKIP_SSL" != "skip-ssl" ]; then
  command -v certbot >/dev/null 2>&1 || { echo "!! certbot 安装失败" >&2; exit 1; }
fi
echo "    node    $(node -v)"
echo "    python3 $(python3 -V 2>&1 | awk '{print $2}')"
echo "    nginx   $(nginx -v 2>&1 | sed 's#nginx version: ##')"
[ "$SKIP_SSL" = "skip-ssl" ] || echo "    certbot $(certbot --version 2>&1 | awk '{print $2}')"
HAVE_NGINX=1

# 证书申请需要 80/443 可达；只放行 Web 端口，不碰 SSH。
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  echo "    ufw 已放行 HTTP/HTTPS"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null
  firewall-cmd --permanent --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
  echo "    firewalld 已放行 HTTP/HTTPS"
fi

# ---------------------------------------------------------------- 2. 目录
echo
echo "==> [2/7] 建目录并复制程序"
mkdir -p "$DIR"
# 数据目录单独处理: 已有数据不覆盖 (重装时保留)
if [ -d "$DIR/data" ]; then
  echo "    数据目录已存在, 保留不动: $DIR/data"
else
  mkdir -p "$DIR/data"
  # 端口: 优先沿用上次装过的那个 —— install.sh 是幂等的, 重跑不该每次都换端口。
  #
  # 端口被占时怎么判断"占的是不是我们自己": 不能靠进程名 —— systemd 单元跑的是
  # node, 进程名 (comm) 里根本没有 quote-server。改读 systemd 单元里记的端口来比对。
  # 不停服务, 所以重装期间站点不会断。
  OWN_PORT=""
  if systemctl cat "$SVC" 2>/dev/null | grep -qE '^Environment=PORT='; then
    OWN_PORT="$(systemctl cat "$SVC" 2>/dev/null | sed -n 's/^Environment=PORT=\([0-9][0-9]*\).*/\1/p' | head -1)"
  fi
  if [ -f "$DIR/data/port" ]; then
    PREV="$(cat "$DIR/data/port" 2>/dev/null || true)"
    if echo "$PREV" | grep -Eq '^[0-9]+$' && [ "$PREV" -ge 8792 ] && [ "$PREV" -le 8899 ]; then
      PORT="$PREV"
    fi
  fi
  if command -v ss >/dev/null 2>&1; then
    while ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; do
      # 占用者就是我们自己的服务 -> 沿用这个端口, 不换
      if [ -n "$OWN_PORT" ] && [ "$PORT" = "$OWN_PORT" ]; then break; fi
      PORT=$((PORT + 1))
      [ "$PORT" -le 8899 ] || { echo "找不到可用端口 (8792-8899)" >&2; exit 1; }
    done
  fi
  echo "$PORT" > "$DIR/data/port"
fi

copy_dir() {
  local src="$1" dst="$2"
  [ -d "$src" ] || return 0
  mkdir -p "$dst"
  # --exclude 掉 pycache 和备份
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude '__pycache__' --exclude '*.bak' --exclude '后台地址.txt' "$src"/ "$dst"/
  else
    cp -a "$src"/. "$dst"/
    find "$dst" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
  fi
}

# 脚本目录两个名字都试: 发布包里叫 scripts/, GitHub 仓库里叫 脚本/
for d in server public scripts deploy 脚本; do
  if [ -d "$SRC/$d" ]; then
    copy_dir "$SRC/$d" "$DIR/$d"
    echo "    $d/  已复制"
  fi
done
for f in index.html engine.js data_v2.js LICENSE; do
  [ -f "$SRC/$f" ] || continue
  # 安装目录 == 解包目录时会撞上 "are the same file" 并让 set -e 掐断整个脚本
  if [ -e "$DIR/$f" ] && [ "$SRC/$f" -ef "$DIR/$f" ]; then
    echo "    $f  已在安装目录, 跳过"
  else
    cp -f "$SRC/$f" "$DIR/$f" && echo "    $f  已复制"
  fi
done
# 根目录缺 engine.js / data_v2.js 时, 从 public/ 补一份 (双击 index.html 离线用)
for f in engine.js data_v2.js; do
  if [ ! -f "$DIR/$f" ] && [ -f "$DIR/public/$f" ]; then
    cp -f "$DIR/public/$f" "$DIR/$f"
    echo "    $f  (从 public/ 补的, 供离线双击)"
  fi
done
# 文档
for f in 使用说明.md 部署说明.md; do
  [ -f "$SRC/$f" ] || continue
  if [ -e "$DIR/$f" ] && [ "$SRC/$f" -ef "$DIR/$f" ]; then
    echo "    $f  已在安装目录, 跳过"
  else
    cp -f "$SRC/$f" "$DIR/$f"
  fi
done

# 数据: 首次安装时带一份初始数据 (没有就建空壳)
if [ ! -f "$DIR/data/users.json" ]; then
  if [ -d "$SRC/data/users/admin" ]; then
    mkdir -p "$DIR/data/users/admin"
    cp -a "$SRC/data/users/admin/." "$DIR/data/users/admin/"
    echo "    站主初始价格数据已带上"
  fi
  [ -f "$SRC/data/fx.json" ] && cp -a "$SRC/data/fx.json" "$DIR/data/fx.json"
fi
chmod 700 "$DIR/data" 2>/dev/null || true

if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi
chown -R "$SVC_USER:$SVC_USER" "$DIR/data"
touch "$DIR/data_v2.js" "$DIR/public/data_v2.js"
chown "$SVC_USER:$SVC_USER" "$DIR/data_v2.js" "$DIR/public/data_v2.js"

# Python 依赖放独立 venv 并锁定哈希，不复用系统里版本不确定的 openpyxl。
PYTHON_BIN="$(command -v python3)"
VENV="$DIR/.venv"
REQUIREMENTS="$DIR/deploy/python-requirements.txt"
if [ ! -f "$REQUIREMENTS" ]; then
  echo "!! 缺少 Python 锁定依赖文件: $REQUIREMENTS" >&2
  exit 1
fi
if ! "$PYTHON_BIN" -m venv "$VENV"; then
  echo "!! 创建 Python venv 失败，请确认 python3-venv 已安装" >&2
  exit 1
fi
"$VENV/bin/python" -m pip install --disable-pip-version-check --no-cache-dir \
  --only-binary=:all: --no-deps --require-hashes -r "$REQUIREMENTS"
chown -R "$SVC_USER:$SVC_USER" "$VENV"
runuser -u "$SVC_USER" -- "$VENV/bin/python" -c \
  "import openpyxl, defusedxml; assert openpyxl.__version__ == '3.1.5', openpyxl.__version__"
echo "    Python venv + openpyxl 3.1.5 已就绪"

# 先在服务启动前建账号，随机密码会直接打印在安装输出里，而不是只进 journal。
cd "$DIR"
if ! runuser -u "$SVC_USER" -- node server/user.js list 2>/dev/null | grep -q 'admin'; then
  echo
  echo "==> 建 admin 账号"
  runuser -u "$SVC_USER" -- node server/user.js add admin
fi

# ---------------------------------------------------------------- 3. systemd
echo
echo "==> [3/7] 装 systemd 单元"
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/${SVC}.service <<EOF
[Unit]
Description=物流报价网站后端 (Node)
After=network.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$DIR
ExecStart=$NODE_BIN server/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=QUOTE_PYTHON=$VENV/bin/python
Environment=QUOTE_IMPORT_CONCURRENCY=1
Environment=QUOTE_IMPORT_PREVIEW_MINUTES=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
CapabilityBoundingSet=
SystemCallArchitectures=native
ReadWritePaths=$DIR/data $DIR/data_v2.js $DIR/public/data_v2.js
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ${SVC} >/dev/null 2>&1 || true
systemctl restart ${SVC}
sleep 3
if systemctl is-active --quiet ${SVC}; then
  echo "    ${SVC} 已启动"
else
  echo "!! ${SVC} 没起来, 看日志:"
  journalctl -u "$SVC" -n 30 --no-pager 2>/dev/null || true
  exit 1
fi

# ---------------------------------------------------------------- 4. nginx
if [ "$HAVE_NGINX" = "1" ]; then
  echo
  echo "==> [4/7] 配 nginx"
  if [ -d /etc/nginx/sites-available ]; then
    if [ -f "/etc/nginx/sites-available/${DOMAIN}" ]; then
      NGINX_SITE="/etc/nginx/sites-available/${DOMAIN}"
      NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"
    else
      NGINX_SITE="/etc/nginx/sites-available/${DOMAIN}.conf"
      NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}.conf"
    fi
  else
    mkdir -p /etc/nginx/conf.d
    NGINX_SITE="/etc/nginx/conf.d/quote-${DOMAIN}.conf"
    NGINX_ENABLED=""
  fi
  cat > "$NGINX_SITE" <<EOF
# 物流报价网站 —— $DOMAIN
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    server_tokens off;
    client_max_body_size 64m;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    proxy_hide_header X-Content-Type-Options;
    proxy_hide_header X-Frame-Options;
    proxy_hide_header Referrer-Policy;
    proxy_hide_header Permissions-Policy;
    proxy_hide_header Content-Security-Policy;
    proxy_hide_header Strict-Transport-Security;

    # ACME http-01 challenge —— 证书续签要用, 永不要动
    location ^~ /.well-known/acme-challenge/ {
        root $DIR;
    }

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
  if [ -n "$NGINX_ENABLED" ]; then
    mkdir -p /etc/nginx/sites-enabled
    ln -sf "$NGINX_SITE" "$NGINX_ENABLED"
  fi
  nginx -t
  # nginx 可能是"装了但没启动"(云镜像 / 容器里很常见), 而 reload 对一个
  # 停止的服务是无效的 —— 结果配置写好了, 站点却打不开。
  # 这里 enable + restart: 保证一定在跑, 而且重启机器后会自动拉起。
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl restart nginx
  systemctl is-active --quiet nginx || {
    echo "    nginx 启动失败" >&2
    systemctl status nginx --no-pager -n 20 >&2
    exit 1
  }
  echo "    nginx 已配好 (80 端口)"
else
  echo
  echo "==> [4/7] 跳过 nginx (没装)"
fi

# ---------------------------------------------------------------- 5. 账号
echo
echo "==> [5/7] 建 admin 账号"
cd "$DIR"
if node server/user.js list 2>/dev/null | grep -q 'admin'; then
  echo "    admin 已存在, 跳过 (要改密码: runuser -u $SVC_USER -- node server/user.js passwd admin)"
else
  runuser -u "$SVC_USER" -- node server/user.js add admin || true
fi

# ---------------------------------------------------------------- 6. SSL
if [ "$HAVE_NGINX" = "1" ] && [ "$SKIP_SSL" != "skip-ssl" ]; then
  echo
  echo "==> [6/7] 申请 HTTPS 证书"
  echo "    需要: 域名已解析到这台机器, 防火墙/安全组已放行 80 和 443"
  CERTBOT_ARGS=(--nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect)
  if [ -n "$CERTBOT_EMAIL" ]; then
    CERTBOT_ARGS+=(--email "$CERTBOT_EMAIL")
  else
    CERTBOT_ARGS+=(--register-unsafely-without-email)
  fi
  if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    CERTBOT_ARGS+=(--reinstall)
  fi
  if certbot "${CERTBOT_ARGS[@]}"; then
    SSL_OK=1
    echo "    HTTPS 证书已申请并配置自动跳转"
  else
    echo "!! HTTPS 申请失败。请确认 $DOMAIN 已解析到本机，80/443 已放行。"
    echo "   修复后可重跑: certbot --nginx -d $DOMAIN --redirect"
  fi

  # Certbot 的 systemd timer 是首选；没有 timer 时补一个系统 cron。
  if systemctl enable --now certbot.timer >/dev/null 2>&1 \
      && systemctl is-active --quiet certbot.timer; then
    echo "    自动续签: certbot.timer 已启用"
  else
    cat > /etc/cron.d/certbot-quote <<'EOF'
17 3 * * * root certbot renew --quiet --deploy-hook "systemctl reload nginx"
EOF
    chmod 644 /etc/cron.d/certbot-quote
    echo "    自动续签: 已安装每日 certbot renew cron"
  fi
else
  echo
  echo "==> [6/7] 跳过 SSL"
fi

# ---------------------------------------------------------------- 6b. 备份
echo
echo "==> 配置每日加密备份"
install -m 0700 "$DIR/deploy/backup.sh" /usr/local/sbin/quote-backup
install -m 0644 "$DIR/deploy/quote-backup.service" /etc/systemd/system/quote-backup.service
install -m 0644 "$DIR/deploy/quote-backup.timer" /etc/systemd/system/quote-backup.timer
if [ ! -f /etc/quote-backup.env ]; then
  cat > /etc/quote-backup.env <<EOF
SITE=$DIR
DEST=/root/backups
KEEP=14
KEY_FILE=/root/.quote-backup.key
EOF
  chmod 600 /etc/quote-backup.env
fi
systemctl daemon-reload
systemctl enable --now quote-backup.timer >/dev/null
systemctl start quote-backup.service
systemctl is-active --quiet quote-backup.timer || {
  echo "!! 每日备份定时器没有启用" >&2
  exit 1
}
echo "    本地备份: /root/backups（AES-256 加密，保留 14 份）"
echo "    备份密钥: 见 /etc/quote-backup.env 的 KEY_FILE；请另存到密码管理器"

# ---------------------------------------------------------------- 7. 自检
echo
echo "==> [7/7] 自检"
FAIL=0
for u in / /admin /admin/changes /admin/users; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$u" || echo 000)
  printf '    %-16s %s\n' "$u" "$code"
  [ "$code" = "200" ] || FAIL=1
done
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/data" || echo 000)
echo "    /api/data        $code  (401 = 登录墙正常)"
if [ "$FAIL" = "1" ]; then
  echo
  echo "!! 有页面没起来, 查日志:"
    journalctl -u "$SVC" -n 30 --no-pager 2>/dev/null || true
  exit 1
fi
echo
# ---- 数据状态: 装完到底有没有数据 ----
HAS_TIERS=0
for f in "$DIR"/data/users/*/rates.json "$DIR"/data/rates.json; do
  [ -f "$f" ] || continue
  if grep -q '"tiers"' "$f" 2>/dev/null; then HAS_TIERS=1; break; fi
done
HAS_XLSX=0
for f in "$DIR"/scripts/*.xlsx "$DIR"/脚本/*.xlsx; do
  [ -f "$f" ] && HAS_XLSX=1 && break
done

echo "=========================================================="
echo " 装好了。"
echo
if [ "$SSL_OK" = "1" ]; then
  echo "   后台地址: https://$DOMAIN/admin"
else
  echo "   后台地址: http://$DOMAIN/admin"
fi
echo "   账号:     admin"
echo "   密码:     见上面 'node server/user.js add admin' 打印的那一行"
    echo "            (忘了就: cd $DIR && runuser -u $SVC_USER -- node server/user.js passwd admin)"
echo
if [ "$SSL_OK" = "1" ]; then
  echo "   改价记录:  https://$DOMAIN/admin/changes"
  echo "   用户管理:  https://$DOMAIN/admin/users"
else
  echo "   改价记录:  http://$DOMAIN/admin/changes"
  echo "   用户管理:  http://$DOMAIN/admin/users"
fi
# 脚本目录名: 仓库里叫 脚本/, 发布包里叫 scripts/ —— 实际找一下
SDIR=""
for d in "$DIR/scripts" "$DIR/脚本"; do
  [ -d "$d" ] && SDIR="$d" && break
done
[ -n "$SDIR" ] && echo "   整表导入:  后台上传报价表, 或 cd $SDIR && python3 run_pipeline.py"
echo
if [ "$HAS_TIERS" = "1" ]; then
  echo "   数据:       已带上现成报价数据, 登录后直接能用。"
else
  echo "   数据:       ** 空站 —— 这次装的是程序, 不含报价数据 **"
  echo
  echo "               想直接用现成数据, 换这个装法 (从发布服务器取带数据的包):"
  echo "                 bash deploy/install-remote.sh root@这台机器 $DOMAIN"
  echo
  if [ "$HAS_XLSX" = "1" ]; then
    echo "               或在后台「整表导入」上传报价表 xlsx 自行导入。"
  else
    echo "               当前目录里也没有报价表 xlsx, 整表导入需要另外提供。"
  fi
fi
echo "=========================================================="
