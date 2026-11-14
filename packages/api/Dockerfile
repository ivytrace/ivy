# Build context: repository root (see deploy/docker-compose.yml).
FROM node:22-alpine AS build
ARG BUILD_UI=auto
RUN corepack enable && apk add --no-cache zip
WORKDIR /repo
COPY . .
RUN if [ "$BUILD_UI" != "false" ] && [ -f packages/ui/package.json ]; then UI_FILTER="--filter ./packages/ui..."; fi; \
    pnpm install --filter ./packages/api... --filter ./packages/layer... $UI_FILTER
RUN pnpm --filter ./packages/api build && pnpm --filter ./packages/layer build
RUN mkdir -p /out/ui && \
    if [ "$BUILD_UI" != "false" ] && [ -f packages/ui/package.json ]; then \
      pnpm --filter ./packages/ui build && cp -r packages/ui/dist/. /out/ui/; \
    else \
      echo "packages/ui not built; serving API only"; \
    fi

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 IVY_UI_DIR=/app/ui IVY_LAYER_ZIP=/app/layer.zip
COPY --from=build /repo/packages/api/dist/server.mjs ./server.mjs
COPY --from=build /repo/packages/layer/dist/layer.zip ./layer.zip
COPY --from=build /out/ui ./ui
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
