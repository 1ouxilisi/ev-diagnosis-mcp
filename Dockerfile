FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY assets ./assets

# 零第三方依赖，不需要 npm install
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
