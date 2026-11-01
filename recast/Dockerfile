FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates python3 curl \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
ENV NODE_ENV=production DATA_DIR=/data PORT=4000
VOLUME /data
EXPOSE 4000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
