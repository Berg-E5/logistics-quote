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

FROM node:22.23.5-bookworm-slim

COPY deploy/python-requirements.txt /tmp/python-requirements.txt

# Python 依赖固定在独立 venv 中，并对 wheel 做哈希校验。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv tini gosu \
 && python3 -m venv /opt/quote-venv \
 && /opt/quote-venv/bin/pip install --disable-pip-version-check --no-cache-dir \
      --only-binary=:all: --no-deps --require-hashes -r /tmp/python-requirements.txt \
 && rm -f /tmp/python-requirements.txt \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 应用会解析上传的 XLSX，不用 root 运行。
RUN groupadd --system --gid 10001 quote \
 && useradd --system --uid 10001 --gid quote --home-dir /app --shell /usr/sbin/nologin quote

# 只拷程序 —— 报价表原件、账号、价格数据一律不进镜像
COPY server/ ./server/
COPY public/ ./public/
COPY 脚本/ ./scripts/
COPY LICENSE ./
# 站点根目录没有 engine.js / data_v2.js, 从 public/ 取 (离线双击 index.html 用)
COPY index.html ./
COPY public/engine.js ./engine.js
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 数据目录 (运行时由 volume 覆盖, 这里只是给个默认位置)
RUN mkdir -p /app/data \
 && touch /app/data_v2.js /app/public/data_v2.js \
 && chown -R quote:quote /app/data /app/data_v2.js /app/public/data_v2.js

# 容器里必须监听 0.0.0.0, 127.0.0.1 的话端口映射出去连不上
ENV NODE_ENV=production \
    PORT=8792 \
    HOST=0.0.0.0 \
    QUOTE_PYTHON=/opt/quote-venv/bin/python \
    QUOTE_IMPORT_CONCURRENCY=1 \
    QUOTE_IMPORT_PREVIEW_MINUTES=30

EXPOSE 8792

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8792)+'/api/version',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

# tini 做 PID 1, 容器能正确收到停止信号
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
