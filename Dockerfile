FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY bin ./bin
COPY src ./src
COPY README.md CHANGELOG.md LICENSE openapi.yaml ./
COPY docs ./docs

RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV MEMORY_TRANSPORT=http
ENV MEMORY_HOST=0.0.0.0
ENV MEMORY_PORT=3100
ENV MEMORY_DB_PATH=/data/memory.db

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/CHANGELOG.md ./CHANGELOG.md
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/openapi.yaml ./openapi.yaml
COPY --from=build /app/docs ./docs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data

EXPOSE 3100
VOLUME ["/data"]

# Liveness probe. Hits /healthz over loopback with NO auth header: /healthz (and
# /readyz) are exempt from authentication server-side, so a keyless probe returns
# 200 even when MEMORY_API_KEY is required. Uses ${MEMORY_PORT} so it tracks a
# non-default port. start-period is generous (40s) because first boot may run
# schema migrations and connect to Postgres; retries×interval (3×30s) gives ~90s
# of transient-failure tolerance after that before the container is marked
# unhealthy, so a slow response does not immediately flap.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MEMORY_PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# NOTE: the CMD deliberately does NOT hardcode --transport/--host/--port. If it
# did, the baked-in CLI flags would override the MEMORY_* env vars (the server's
# precedence is flag > env > default) and the entrypoint guard — which reflects
# that same precedence — could see a different config than the one that ships in
# this image's ENV. Leaving them out means MEMORY_TRANSPORT/MEMORY_HOST/
# MEMORY_PORT (set above) are the single source of truth, so env and args can
# never disagree. Override them at `docker run -e MEMORY_TRANSPORT=...` time.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "./bin/memory-server.mjs", "serve"]
