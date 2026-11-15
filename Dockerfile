# Node runtime + ffmpeg + yt-dlp, nothing else.
FROM node:22-bookworm-slim

# ffmpeg is needed for MP3 extraction and for merging high-resolution video.
# The standalone Linux yt-dlp build has no Python dependency.
# On ARM hosts (Fly.io amd64 emulation avoided, Apple Silicon, Graviton) swap
# yt-dlp_linux for yt-dlp_linux_aarch64.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server.js index.html README.md ./
COPY assets ./assets

# Bind on all interfaces so the platform's router can reach us.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

EXPOSE 3000

USER node

CMD ["node", "server.js"]
