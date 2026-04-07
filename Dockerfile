# NodeSeek RSS Proxy Server
# 用于部署在 VPS 上，为 Cloudflare Workers 提供代理转发服务

FROM node:18-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm install express axios cors

# 复制代码
COPY proxy-server-express.js .

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# 启动
CMD ["node", "proxy-server-express.js"]
