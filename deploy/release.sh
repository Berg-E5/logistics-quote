#!/usr/bin/env bash
#
# 物流报价网站 —— 发布一个可安装的版本
#
# 用法 (在本地项目根目录跑):
#   bash deploy/release.sh
#   bash deploy/release.sh root@169.40.117.164
#
# 做的事:
#   1. 把 deploy/ 里的安装脚本同步到服务器站点目录
#   2. 在服务器上打包站点目录 (= 线上正在跑的版本, 含报价表原件)
#   3. 放进 /root/quote-release/, 刷新 quote-install-latest.tar.gz
#   4. 写 SHA256SUMS + README + fetch-release.sh
#
# 为什么在服务器上打包:
#   - 站点目录里 scripts/ 带着「报价表.xlsx」「原计算器.xlsx」原件, 本地没有
#   - 打出来的包 = 线上正在跑的版本, 不会出现「本地改了但没部署」的错位
#
# 发布目录里的东西:
#   quote-install-latest.tar.gz          <- 固定名, 拉这个就行
#   quote-install-YYYYMMDD-HHMMSS.tar.gz <- 历史版本
#   SHA256SUMS                           <- 校验和
#   README.txt                           <- 怎么取、怎么装
#   fetch-release.sh                     <- 一条命令拉取并安装
#
# 换一台新服务器时:
#   scp root@<发布机>:/root/quote-release/fetch-release.sh .
#   sudo bash fetch-release.sh <你的域名>
#
set -euo pipefail

LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="/var/www/quote.byberg.store"
RELEASE_DIR="/root/quote-release"
SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new"
TS="$(date +%Y%m%d-%H%M%S)"
PKG="quote-install-${TS}.tar.gz"

# 参数: 第一个非 -- 开头的当主机名; --push 表示发布完顺便推到 Docker Hub
# (用服务器上已存的登录凭据, 不碰密码)
HOST="root@169.40.117.164"
DO_PUSH=0
for a in "$@"; do
  case "$a" in
    --push) DO_PUSH=1 ;;
    *) HOST="$a" ;;
  esac
done

echo "=== 发布到 $HOST ==="
echo "    本地目录: $LOCAL"
echo "    包名:     $PKG"

# ---------- 1. 同步安装脚本到站点目录 ----------
echo
echo "[1/4] 同步安装脚本到站点目录"
for f in install.sh fetch-release.sh release.sh; do
  scp $SSH_OPTS -q "$LOCAL/deploy/$f" "$HOST:$SITE/deploy/$f"
  echo "    deploy/$f"
done

# ---------- 2. 服务器上打包 ----------
echo
echo "[2/4] 在服务器上打包"
# 不进包的东西:
#   __pycache__ / *.bak          编译缓存和备份
#   后台地址.txt                   里面有后台凭据
#   data/admin.token              管理令牌, 新站自己生成
#   data/users/*/sessions.json    登录会话
#   deploy/quote-install-*.tar.gz 发布包本身 (别把旧包打进新包)
ssh $SSH_OPTS "$HOST" "
set -e
cd '$SITE'
tar czf '$RELEASE_DIR/$PKG' \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='*.bak' \
  --exclude='后台地址.txt' --exclude='admin.token' \
  --exclude='sessions.json' --exclude='deploy/quote-install-*.tar.gz' \
  server public scripts deploy index.html \
  data/users.json data/secret.key data/fx.json data/users \
  使用说明.md 部署说明.md
ls -la '$RELEASE_DIR/$PKG'
"

# ---------- 3. Docker 镜像 (可选, 装了 docker 才做) ----------
echo
echo "[3/5] 导出 Docker 镜像"
if ssh $SSH_OPTS "$HOST" "command -v docker >/dev/null 2>&1"; then
  ssh $SSH_OPTS "$HOST" "
set -e
rm -rf /root/quote-docker-build && mkdir -p /root/quote-docker-build
cd '$SITE'
cp -r server public scripts /root/quote-docker-build/
cp index.html /root/quote-docker-build/
mkdir -p /root/quote-docker-build/docker
"
  for f in Dockerfile .dockerignore docker-compose.yml; do
    scp $SSH_OPTS -q "$LOCAL/$f" "$HOST:/root/quote-docker-build/$f"
  done
  scp $SSH_OPTS -q "$LOCAL/docker/entrypoint.sh" "$HOST:/root/quote-docker-build/docker/entrypoint.sh"
  ssh $SSH_OPTS "$HOST" "
set -e
cd /root/quote-docker-build
docker build -t quote:latest . 2>&1 | tail -3
docker save quote:latest | gzip -6 > '$RELEASE_DIR/quote-docker-latest.tar.gz'
ls -la '$RELEASE_DIR/quote-docker-latest.tar.gz'
"
else
  echo "    服务器没装 docker, 跳过镜像导出"
fi

# ---------- 4. latest + 校验和 ----------
echo
echo "[4/5] 刷新 latest + SHA256SUMS"
ssh $SSH_OPTS "$HOST" "cd '$RELEASE_DIR' && \
  cp -f '$PKG' quote-install-latest.tar.gz && \
  sha256sum quote-install-latest.tar.gz '$PKG' > SHA256SUMS && \
  if [ -f quote-docker-latest.tar.gz ]; then sha256sum quote-docker-latest.tar.gz >> SHA256SUMS; fi && \
  chmod 644 quote-install-latest.tar.gz '$PKG' SHA256SUMS && \
  ls -la quote-install-latest.tar.gz '$PKG' SHA256SUMS"

# ---------- 5. README + 拉包脚本 ----------
echo
echo "[5/5] 写 README + 拉包脚本"
cat > /tmp/quote-release-README.txt <<EOF
物流报价网站 —— 发布目录
================================

最省事的一条命令 (新服务器上直接跑):
    scp root@169.40.117.164:/root/quote-release/fetch-release.sh .
    sudo bash fetch-release.sh <你的域名>

或者手工拉 (两步):
    scp root@169.40.117.164:/root/quote-release/quote-install-latest.tar.gz .
    tar xzf quote-install-latest.tar.gz -C /opt/quote
    cd /opt/quote && sudo bash deploy/install.sh <你的域名>

带数据装 (原来的账号直接能用):
    包里已经带了 data/users.json + data/secret.key + 各账号的价格数据。
    想装空站就: cd /opt/quote && rm -rf data/users.json data/secret.key data/users

校验:
    sha256sum -c SHA256SUMS

文件说明:
    quote-install-latest.tar.gz          固定名, 永远是最新版本
    quote-install-*.tar.gz               历史版本 (带时间戳)
    quote-docker-latest.tar.gz           Docker 镜像 (docker load 用)
    SHA256SUMS                           校验和
    fetch-release.sh                     一条命令拉取并安装

【Docker 方式】目标服务器只要装了 docker, 不用装 node/nginx/python。
仓库是公开的, 直接 run 就行 (会自动拉镜像):
    docker run -d --name quote --restart unless-stopped \\
      -p 127.0.0.1:8792:8792 \\
      -v /var/lib/quote/data:/app/data \\
      -e ADMIN_PASSWORD='你的密码' \\
      utism/quote:latest

离线环境 (拉不到 Hub) 才用镜像文件:
    scp root@169.40.117.164:/root/quote-release/quote-docker-latest.tar.gz .
    docker load -i quote-docker-latest.tar.gz
    # 容器里的账号: 首次启动自动建 admin, 密码看 docker logs quote
    # 端口只绑 127.0.0.1, 由宿主 nginx 反代并管证书

依赖: node 18+ / nginx / python3 + openpyxl (只有整表导入需要 openpyxl)

这个包是「线上正在跑的版本」打出来的, 装了就能直接用。
镜像里不含任何数据 (报价表/账号/价格), 数据靠 volume 挂进来或后台导入。
EOF
scp $SSH_OPTS -q /tmp/quote-release-README.txt "$HOST:$RELEASE_DIR/README.txt"
# 拉包脚本也放进发布目录 —— 否则新服务器要先有包才能拿到拉包的脚本 (循环依赖)
scp $SSH_OPTS -q "$LOCAL/deploy/fetch-release.sh" "$HOST:$RELEASE_DIR/fetch-release.sh"
ssh $SSH_OPTS "$HOST" "chmod 644 '$RELEASE_DIR/README.txt' '$RELEASE_DIR/fetch-release.sh' && ls -la '$RELEASE_DIR'"

# ---------- 6. 可选: 推到 Docker Hub ----------
if [ "$DO_PUSH" = "1" ]; then
  echo
  echo "[6/6] 推到 Docker Hub"
  ssh $SSH_OPTS "$HOST" "docker tag quote:latest utism/quote:latest && docker push utism/quote:latest 2>&1 | tail -3" \
    || echo "    push 失败 (服务器可能没登录 docker, 先在服务器上 docker login)"
else
  echo
  echo "    (想同时推 Docker Hub 就加 --push: bash deploy/release.sh --push)"
fi

echo
echo "=========================================================="
echo " 发布完成。"
echo
echo "   拉最新版:"
echo "     scp root@169.40.117.164:$RELEASE_DIR/quote-install-latest.tar.gz ."
echo
echo "   校验和:"
ssh $SSH_OPTS "$HOST" "cat '$RELEASE_DIR/SHA256SUMS'"
echo "=========================================================="
