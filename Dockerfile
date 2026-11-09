FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY agent ./agent
ENV PORT=8787 \
    DATA_DIR=/data \
    NODE_ENV=production
EXPOSE 8787
VOLUME ["/data"]
# 健康检查：根路径返回控制台页面（无需令牌）
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8787/ > /dev/null 2>&1 || exit 1
CMD ["node", "server.mjs"]
