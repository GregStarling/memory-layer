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

RUN mkdir -p /data

EXPOSE 3100
VOLUME ["/data"]

CMD ["node", "./bin/memory-server.mjs", "serve", "--transport", "http", "--port", "3100"]
