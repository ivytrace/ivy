# Build context: repository root (see deploy/docker-compose.yml).

# The layer's Lambda extension (Rust), cross-compiled for both Lambda architectures on the build
# host's platform, so a multi-arch image build compiles it natively instead of under emulation.
# Dependencies are compiled in their own layer, so source-only changes reuse them from the cache.
FROM --platform=$BUILDPLATFORM rust:1.91-slim-bookworm AS extension
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages ziglang==0.13.0 cargo-zigbuild==0.20.1 \
 && rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
WORKDIR /src
ENV TARGETS="--target x86_64-unknown-linux-musl --target aarch64-unknown-linux-musl"
COPY packages/layer/extension/Cargo.toml packages/layer/extension/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo zigbuild --locked --release $TARGETS && rm -rf src
COPY packages/layer/extension/src ./src
RUN touch src/main.rs && cargo zigbuild --locked --release $TARGETS \
 && mkdir /out \
 && cp target/x86_64-unknown-linux-musl/release/ivy-extension /out/ivy-extension-x86_64 \
 && cp target/aarch64-unknown-linux-musl/release/ivy-extension /out/ivy-extension-arm64

FROM node:22-alpine AS build
ARG BUILD_UI=auto
RUN corepack enable && apk add --no-cache zip
WORKDIR /repo
COPY . .
RUN if [ "$BUILD_UI" != "false" ] && [ -f packages/ui/package.json ]; then UI_FILTER="--filter ./packages/ui..."; fi; \
    pnpm install --filter ./packages/api... --filter ./packages/layer... $UI_FILTER
COPY --from=extension /out /ext
RUN pnpm --filter ./packages/api build && IVY_EXTENSION_BIN_DIR=/ext pnpm --filter ./packages/layer build
RUN mkdir -p /out/ui && \
    if [ "$BUILD_UI" != "false" ] && [ -f packages/ui/package.json ]; then \
      pnpm --filter ./packages/ui build && cp -r packages/ui/dist/. /out/ui/; \
    else \
      echo "packages/ui not built; serving API only"; \
    fi

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 IVY_UI_DIR=/app/ui IVY_LAYER_ZIP=/app/layer.zip
COPY --from=build /repo/packages/api/dist/index.mjs ./server.mjs
COPY --from=build /repo/packages/api/dist/ingest.mjs /repo/packages/api/dist/tenants.mjs ./
COPY --from=build /repo/packages/layer/dist/layer.zip ./layer.zip
COPY --from=build /out/ui ./ui
USER node
EXPOSE 3000 4318
# The same image runs the ingest router: `node ingest.mjs` (see deploy/docker-compose.yml).
CMD ["node", "server.mjs"]
