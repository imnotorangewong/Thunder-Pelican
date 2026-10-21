# Canvas 游戏 + 骑手插画 + 排行榜服务，一个镜像。
#   docker build -t thunder-pelican .
#   docker run -d -p 8787:8787 -v tp-data:/data --name thunder-pelican thunder-pelican

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    STATIC_DIR=/site \
    DATA_FILE=/data/board.json \
    ALLOW_ORIGIN=*

# 服务端（零依赖，不需要 npm install）
COPY server/ /app/

# 站点：页面与音乐内嵌在 index.html，骑手插画按需从 assets/skins 加载。
# assets/screenshots 是 README 用的截图，不进镜像。
COPY index.html /site/index.html
COPY assets/skins/ /site/assets/skins/

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.js"]
