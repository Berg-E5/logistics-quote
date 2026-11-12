#!/usr/bin/env bash
#
# 把 Docker Hub 的令牌写进 GitHub Secrets, 让 Actions 能自动推镜像
#
# 用法:
#   bash deploy/setup-github-secrets.sh <令牌文件> [仓库]
#   DOCKERHUB_TOKEN=xxx bash deploy/setup-github-secrets.sh
#
# 令牌文件放哪都行, 但**别提交进 git** (deploy/.dockerhub-token 已在 .gitignore 里)。
#
# 令牌从哪来:
#   https://hub.docker.com/settings/security/access-tokens
#   → Generate new token → 勾 Write → Generate → 复制那串字符
#   (不要用账户密码; 不要用服务器上那个 OAuth token, 它会过期)
#
set -euo pipefail

FILE="${1:-}"
REPO="${2:-Berg-E5/logistics-quote}"
USERNAME="${DOCKERHUB_USERNAME:-utism}"

TOKEN=""
if [ -n "$FILE" ] && [ -f "$FILE" ]; then
  TOKEN="$(head -n1 "$FILE" | tr -d '\r\n')"
elif [ -n "${DOCKERHUB_TOKEN:-}" ]; then
  TOKEN="$DOCKERHUB_TOKEN"
fi

if [ -z "$TOKEN" ]; then
  echo "用法: bash deploy/setup-github-secrets.sh <令牌文件> [仓库]"
  echo
  echo "令牌从 Docker Hub 生成:"
  echo "  https://hub.docker.com/settings/security/access-tokens"
  echo "  → Generate new token → 勾 Write → Generate"
  echo
  echo "把令牌存进一个文件 (第一行就是令牌), 然后把路径传进来。"
  exit 1
fi

if [ ${#TOKEN} -lt 20 ]; then
  echo "!! 令牌看起来不对 (长度 ${#TOKEN})"
  exit 1
fi

command -v gh >/dev/null 2>&1 || {
  echo "!! 没装 gh CLI。装完再跑: gh auth login"
  exit 1
}

echo "=== 写 GitHub Secrets ($REPO) ==="
gh secret set DOCKERHUB_USERNAME --repo "$REPO" --body "$USERNAME"
echo "  DOCKERHUB_USERNAME = $USERNAME"
gh secret set DOCKERHUB_TOKEN --repo "$REPO" --body "$TOKEN"
echo "  DOCKERHUB_TOKEN    = (已加密写入, 读不出来了)"

echo
echo "=== 当前仓库的 Secrets ==="
gh secret list --repo "$REPO"

echo
echo "=========================================================="
echo " 配好了。"
echo
echo " 现在往 main 推代码, Actions 会自动重建镜像并推到 Docker Hub。"
echo " 也可以手动触发: 仓库 Actions 页 → 推 Docker 镜像到 Docker Hub → Run workflow"
echo "=========================================================="
