#!/usr/bin/env bash
#
# 容器启动脚本: 准备数据目录 -> 首次启动建账号 -> 启动服务
#
set -e
cd /app

mkdir -p /app/data

# 首次启动 (data/users.json 不存在) 时建 admin 账号。
# ADMIN_PASSWORD 给了就用指定的, 没给就随机生成并打进日志。
if [ ! -f /app/data/users.json ]; then
  echo "[entrypoint] 首次启动, 创建 admin 账号..."
  if [ -n "${ADMIN_PASSWORD:-}" ]; then
    node server/user.js add admin "$ADMIN_PASSWORD"
  else
    node server/user.js add admin
  fi
  echo "[entrypoint] 账号建好了 (密码看上面那行, 或用 node server/user.js passwd admin 重置)"
fi

# data/users/<账号>/ 目录建好, 免得首次保存价格时报错
mkdir -p /app/data/users

echo "[entrypoint] 启动服务: 监听 0.0.0.0:${PORT:-8792}"
exec node server/server.js
