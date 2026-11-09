# Cadence server image: API + web UI in one Node process, data in /data.
#   docker build -f deploy/Dockerfile -t cadence .
#   docker run -p 8787:8787 -v cadence-data:/data -e CADENCE_PASSWORD=secret cadence
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
# server + web only: the Electron desktop workspace is not needed for the image
RUN npm ci --no-audit --no-fund --include-workspace-root -w @cadence/shared -w @cadence/server -w @cadence/web
COPY . .
RUN npm run build

FROM node:26-slim
LABEL org.opencontainers.image.title="Cadence" \
      org.opencontainers.image.description="Self-hosted, Strava-style training log fed by your Apple Health export" \
      org.opencontainers.image.source="https://github.com/mang0lo/cadence" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    CADENCE_MODE=server \
    CADENCE_DATA_DIR=/data \
    CADENCE_WEB_DIR=/app/web \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY --from=build /app/apps/server/dist/ ./server/
COPY --from=build /app/apps/web/dist/ ./web/
RUN mkdir -p /data /import && chown -R node:node /data /import
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
