# Cross-compiles the extension for both Lambda architectures (static musl via cargo-zigbuild) on
# the build host's own platform. scripts/build.mjs uses it when `cargo zigbuild` is not installed:
#   docker build -f packages/layer/extension/Dockerfile --output type=local,dest=<dir> packages/layer/extension
# packages/api/Dockerfile has the same stage (its build context is the repository root).
FROM --platform=$BUILDPLATFORM rust:1.91-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages ziglang==0.13.0 cargo-zigbuild==0.20.1 \
 && rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
WORKDIR /src
ENV TARGETS="--target x86_64-unknown-linux-musl --target aarch64-unknown-linux-musl"
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo zigbuild --locked --release $TARGETS && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo zigbuild --locked --release $TARGETS \
 && mkdir /out \
 && cp target/x86_64-unknown-linux-musl/release/ivy-extension /out/ivy-extension-x86_64 \
 && cp target/aarch64-unknown-linux-musl/release/ivy-extension /out/ivy-extension-arm64

FROM scratch
COPY --from=build /out/ /
