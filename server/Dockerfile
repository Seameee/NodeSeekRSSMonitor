# ============================================================================
# 多阶段构建：构建期只做语法/依赖校验，运行期用纯净的 node:alpine
# 全程零第三方依赖 —— 不需要编译工具链，镜像因此非常小
# ============================================================================
ARG NODE_VERSION=24-alpine

# ─── 阶段 1：校验 ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS verify
WORKDIR /app
COPY package.json ./
COPY src ./src
# 逐个文件做语法检查，任何一个语法错误都让构建失败
RUN set -eux; \
    for f in src/*.js; do node --check "$f"; done; \
    echo "所有模块语法检查通过"

# ─── 阶段 2：运行 ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime

# 仅安装 curl 用于健康检查；tini 负责正确转发信号（PID 1 问题）
RUN apk add --no-cache tini curl

ENV NODE_ENV=production \
    DB_PATH=/data/nodeseek.db \
    HEALTH_PORT=8787

WORKDIR /app

COPY --from=verify /app/package.json ./package.json
COPY --from=verify /app/src ./src

# 数据目录交给 node 用户；容器以非 root 运行
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${HEALTH_PORT}/healthz >/dev/null || exit 1

# tini 作为 PID 1，确保 SIGTERM 能传到 node 并触发优雅退出
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
