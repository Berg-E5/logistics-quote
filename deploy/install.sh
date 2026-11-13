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
#   1. 检查 node / python3 / nginx
#   2. 装 python 依赖 (openpyxl, 整表导入用)
#   3. 把程序文件复制到安装目录
#   4. 装 systemd 单元并启动
#   5. 装 nginx 反代 (80 端口, HTTPS 可选)
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

DOMAIN="${1:-}"
DIR="${2:-/var/www/quote.byberg.store}"
SKIP_SSL="${3:-}"
PORT=8792
SVC=quote-server

if [ -z "$DOMAIN" ]; then
  echo "用法: sudo bash install.sh <域名> [安装目录] [skip-ssl]"
  echo "  域名不要带 https://, 例如 quote.example.com"
  exit 1
fi
if ! echo "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$'; then
  echo "域名不合法: $DOMAIN"
  exit 1
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
echo "==> [1/7] 检查依赖"
need_node=0
if command -v node >/dev/null 2>&1; then
  NV=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NV" -ge 18 ]; then
    echo "    node $(node -v)  OK"
  else
    echo "    node $(node -v) 版本太低, 需要 18+"
    need_node=1
  fi
else
  echo "    没装 node"
  need_node=1
fi
if [ "$need_node" = "1" ]; then
  echo
  echo "!! 请先装 Node.js 18+:"
  echo "     Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"
  echo "     RHEL/CentOS:   dnf install -y nodejs"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "!! 没装 python3, 整表导入会不可用 (其它功能正常)"
  echo "     apt-get install -y python3 python3-pip"
else
  echo "    python3 $(python3 -V 2>&1 | cut -d' ' -f2)  OK"
  if ! python3 -c "import openpyxl" 2>/dev/null; then
    echo "    装 openpyxl (整表导入要读报价表 xlsx)"
    python3 -m pip install --quiet openpyxl 2>/dev/null \
      || pip3 install --quiet openpyxl 2>/dev/null \
      || apt-get install -y python3-openpyxl 2>/dev/null \
      || echo "    !! openpyxl 装不上, 整表导入不可用 (其它功能正常)"
  fi
  python3 -c "import openpyxl" 2>/dev/null && echo "    openpyxl OK" || true
fi

HAVE_NGINX=0
command -v nginx >/dev/null 2>&1 && { HAVE_NGINX=1; echo "    nginx OK"; } || echo "    没装 nginx (装不了就只能用 IP+端口直连)"

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
for f in index.html engine.js data_v2.js; do
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
  if [ -f "$SRC/data/users.json" ]; then
    cp -a "$SRC/data/users."* "$DIR/data/" 2>/dev/null || true
    mkdir -p "$DIR/data/users"
    [ -d "$SRC/data/users" ] && cp -a "$SRC/data/users/." "$DIR/data/users/" 2>/dev/null || true
    echo "    初始数据已带上"
  fi
fi
chmod 700 "$DIR/data" 2>/dev/null || true

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
User=root
WorkingDirectory=$DIR
ExecStart=$NODE_BIN server/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
StandardOutput=append:/var/log/${SVC}.log
StandardError=append:/var/log/${SVC}.err.log

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
  tail -20 /var/log/${SVC}.err.log 2>/dev/null || true
  tail -20 /var/log/${SVC}.log 2>/dev/null || true
  exit 1
fi

# ---------------------------------------------------------------- 4. nginx
if [ "$HAVE_NGINX" = "1" ]; then
  echo
  echo "==> [4/7] 配 nginx"
  cat > /etc/nginx/sites-available/quote.byberg.store <<EOF
# 物流报价网站 —— $DOMAIN
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

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
  mkdir -p /etc/nginx/sites-enabled
  ln -sf /etc/nginx/sites-available/quote.byberg.store /etc/nginx/sites-enabled/quote.byberg.store
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
  echo "    admin 已存在, 跳过 (要改密码: node server/user.js passwd admin)"
else
  node server/user.js add admin || true
fi

# ---------------------------------------------------------------- 6. SSL
if [ "$HAVE_NGINX" = "1" ] && [ "$SKIP_SSL" != "skip-ssl" ]; then
  echo
  echo "==> [6/7] 申请 HTTPS 证书"
  echo "    需要: 域名已解析到这台机器, 防火墙/安全组已放行 80 和 443"
  if command -v certbot >/dev/null 2>&1; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email \
      --redirect || echo "!! certbot 失败, 可以之后手动跑: certbot --nginx -d $DOMAIN"
  else
    echo "    没装 certbot"
    echo "     apt-get install -y certbot python3-certbot-nginx"
    echo "     certbot --nginx -d $DOMAIN"
  fi
else
  echo
  echo "==> [6/7] 跳过 SSL"
fi

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
  tail -20 "/var/log/${SVC}.err.log" 2>/dev/null || true
  tail -20 "/var/log/${SVC}.log" 2>/dev/null || true
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
echo "   后台地址: http://$DOMAIN/admin  (配了 SSL 就是 https://$DOMAIN/admin)"
echo "   账号:     admin"
echo "   密码:     见上面 'node server/user.js add admin' 打印的那一行"
echo "            (忘了就: cd $DIR && node server/user.js passwd admin)"
echo
echo "   改价记录:  http://$DOMAIN/admin/changes"
echo "   用户管理:  http://$DOMAIN/admin/users"
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
