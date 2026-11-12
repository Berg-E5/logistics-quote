#!/usr/bin/env bash
#
# 把镜像推到 Docker Hub
#
# 用法 (在服务器上):
#   bash deploy/docker-push.sh utism              # 推 utism/quote:latest
#   bash deploy/docker-push.sh utism 20261111-1   # 同时推一个带版本号的 tag
#
# 前提:
#   1. Docker Hub 网站上已经建好一个叫 quote 的仓库 (建议设私有)
#   2. 这台机器上已经 docker login 过
#
# 没登录会提示登录:
#   docker login
#   Username: utism
#   Password: <你的密码或 Access Token>
#
# 建议用 Access Token 而不是账户密码:
#   Docker Hub → Account Settings → Personal Access Tokens → Generate
#   (Read/Write 权限, 用完可以随时撤销)
#
set -euo pipefail

NS="${1:-utism}"
REPO="${2:-quote}"
IMAGE="${NS}/${REPO}"
LOCAL="quote:latest"

echo "=== 推到 docker.io/${IMAGE} ==="

# 没登录就提示一下
if [ ! -f /root/.docker/config.json ] || ! grep -q 'auths' /root/.docker/config.json 2>/dev/null; then
  echo "!! 这台机器还没登录 Docker Hub"
  echo "   先跑:  docker login"
  echo "   用户名: $NS"
  echo "   密码用 Docker Hub 的 Access Token 更安全 (Account Settings → Personal Access Tokens)"
  echo
  read -rp "现在登录? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) docker login ;;
    *) echo "已取消"; exit 1 ;;
  esac
fi

# 有本地镜像就用, 没有就 build
if ! docker image inspect "$LOCAL" >/dev/null 2>&1; then
  echo "本地没有 $LOCAL, 尝试从发布服务器重新 build..."
  echo "提示: 在有源码的机器上跑 bash deploy/release.sh, 或者先 docker load"
  exit 1
fi

docker tag "$LOCAL" "${IMAGE}:latest"
echo "已 tag: ${IMAGE}:latest"

echo
echo "=== push ==="
docker push "${IMAGE}:latest"

# 可选: 再推一个带版本号的 tag (同一个镜像)
if [ -n "${3:-}" ]; then
  docker tag "$LOCAL" "${IMAGE}:${3}"
  echo
  echo "=== push ${IMAGE}:${3} ==="
  docker push "${IMAGE}:${3}"
fi

echo
echo "=========================================================="
echo " 推完了。"
echo
echo "   别人装 (仓库是公开的, 不用登录):"
echo "     docker pull ${IMAGE}:latest"
echo "     docker run -d --name quote --restart unless-stopped \\"
echo "       -p 127.0.0.1:8792:8792 \\"
echo "       -v /var/lib/quote/data:/app/data \\"
echo "       -e ADMIN_PASSWORD='你的密码' \\"
echo "       ${IMAGE}:latest"
echo "=========================================================="
