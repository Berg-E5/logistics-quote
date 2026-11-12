#!/usr/bin/env bash
#
# 把代码推到 GitHub
#
# 用法:
#   bash deploy/push-github.sh <GitHub用户名> [仓库名] [公开|私有]
#
#   例: bash deploy/push-github.sh myname logistics-quote public
#
# 做的事:
#   1. 检查 gh CLI 登录状态 (没登录会提示)
#   2. 在 GitHub 上建仓库 (已存在就跳过)
#   3. 配 remote + push
#
# 没装 gh CLI 或者不想用 gh:
#   git remote add origin git@github.com:<用户名>/<仓库名>.git
#   git push -u origin main
#
set -euo pipefail

USER_NAME="${1:-}"
REPO="${2:-logistics-quote}"
VIS="${3:-public}"

if [ -z "$USER_NAME" ]; then
  echo "用法: bash deploy/push-github.sh <GitHub用户名> [仓库名] [public|private]"
  echo "  例: bash deploy/push-github.sh myname logistics-quote public"
  exit 1
fi

LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$LOCAL"

if ! command -v gh >/dev/null 2>&1; then
  echo "!! 没装 gh CLI"
  echo "   可以手工来:"
  echo "     git remote add origin git@github.com:$USER_NAME/$REPO.git"
  echo "     git push -u origin main"
  exit 1
fi

echo "=== 推到 GitHub: $USER_NAME/$REPO ($VIS) ==="

# ---------- 1. 登录状态 ----------
echo
echo "[1/4] 检查登录"
if ! gh auth status >/dev/null 2>&1; then
  echo "    gh 没登录。请在本机终端里跑一次:"
  echo
  echo "      gh auth login"
  echo
  echo "    (选 GitHub.com → HTTPS → 用浏览器登录 → 把验证码贴到终端)"
  echo
  echo "    登录完再回来跑这个脚本。"
  exit 1
fi
gh auth status 2>&1 | grep -i 'logged in' | head -2 | sed 's/^/    /'

# ---------- 2. 建仓库 ----------
echo
echo "[2/4] 建仓库"
if gh repo view "$USER_NAME/$REPO" >/dev/null 2>&1; then
  echo "    仓库已存在, 跳过"
else
  VIS_FLAG="--public"
  [ "$VIS" = "private" ] && VIS_FLAG="--private"
  gh repo create "$USER_NAME/$REPO" $VIS_FLAG \
    --description "物流报价系统: 按渠道/国家/重量/尺寸算运费、毛利和建议售价。Node 原生 http 后端 + Vue 3 后台 + Python 抽取管道, 零第三方运行时依赖。" \
    --disable-issues=false || {
      echo "!! 建仓库失败, 可能是仓库名被占了或者权限不够"
      exit 1
    }
  echo "    建好了 ($VIS)"
fi

# ---------- 3. remote ----------
echo
echo "[3/4] 配 remote"
REMOTE="https://github.com/$USER_NAME/$REPO.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
  echo "    origin -> $REMOTE"
else
  git remote add origin "$REMOTE"
  echo "    新增 origin -> $REMOTE"
fi

# ---------- 4. push ----------
echo
echo "[4/4] push"
git push -u origin main
echo
echo "=========================================================="
echo " 推完了: https://github.com/$USER_NAME/$REPO"
echo
echo " 顺带可以在仓库页做两件事 (可选):"
echo "   1. 设置 Description / Topics (topics 建议: logistics, pricing, nodejs, vue)"
echo "   2. 设置 Homepage 和仓库简介"
echo "=========================================================="
