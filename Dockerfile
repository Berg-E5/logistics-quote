# ============================================================
#  物流报价网站 —— Docker 镜像
#
#  构建:
#    docker build -t quote:latest .
#
#  运行 (数据挂到宿主机, 换镜像不动数据):
#    docker run -d --name quote \
#      -p 127.0.0.1:8792:8792 \
#      -v /var/lib/quote/data:/app/data \
#      -e ADMIN_PASSWORD='你的密码' \
#      quote:latest
#
#  镜像里**不含**任何数据 (报价表/账号/价格)。
#  账号在首次启动时创建, 密码用 ADMIN_PASSWORD 环境变量指定
#  (不给就随机生成并打进日志)。
# ============================================================

FROM node:22-bookworm-slim

# python3 + openpyxl 只有「整表导入」需要 (读报价表 xlsx),
# 但一起装进镜像, 目标服务器就不用另外配环境了。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip tini \
 && pip3 install --no-cache-dir --break-system-packages openpyxl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 只拷程序 —— 报价表原件、账号、价格数据一律不进镜像
COPY server/ ./server/
COPY public/ ./public/
COPY scripts/ ./scripts/
# 站点根目录没有 engine.js / data_v2.js, 从 public/ 取 (离线双击 index.html 用)
COPY index.html ./
COPY public/engine.js ./engine.js
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 数据目录 (运行时由 volume 覆盖, 这里只是给个默认位置)
RUN mkdir -p /app/data

# 容器里必须监听 0.0.0.0, 127.0.0.1 的话端口映射出去连不上
ENV NODE_ENV=production \
    PORT=8792 \
    HOST=0.0.0.0

EXPOSE 8792

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8792)+'/api/version',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

# tini 做 PID 1, 容器能正确收到停止信号
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
