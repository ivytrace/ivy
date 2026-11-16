# The ingest image: one static binary (packages/ingest), built for the target platform with cargo-zigbuild.
#   docker build -f packages/ingest/Dockerfile packages/ingest
FROM --platform=$BUILDPLATFORM rust:1.91-slim-bookworm AS build
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages ziglang==0.13.0 cargo-zigbuild==0.20.1 \
 && rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
RUN T=$([ "$TARGETARCH" = arm64 ] && echo aarch64 || echo x86_64)-unknown-linux-musl \
 && mkdir src && echo 'fn main() {}' > src/main.rs && cargo zigbuild --locked --release --target $T && rm -rf src
COPY src ./src
RUN T=$([ "$TARGETARCH" = arm64 ] && echo aarch64 || echo x86_64)-unknown-linux-musl \
 && touch src/main.rs && cargo zigbuild --locked --release --target $T \
 && cp target/$T/release/ivy-ingest /ivy-ingest

FROM scratch
COPY --from=build /ivy-ingest /ivy-ingest
EXPOSE 4318
ENTRYPOINT ["/ivy-ingest"]
