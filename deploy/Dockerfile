# syntax=docker/dockerfile:1.7
#
# OpenGrid container image. Build from the repository root:
#
#   docker build -f deploy/Dockerfile -t opengrid .
#
# Stage 1 builds the Leptos web client (trunk -> crates/web/dist) and then the
# server, which embeds that dist directory into the binary. Stage 2 is a slim
# Debian runtime with only the binary, CA certificates and time zone data.

ARG RUST_IMAGE=rust:1-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim

FROM ${RUST_IMAGE} AS builder
ARG TRUNK_VERSION=0.21.14

RUN rustup target add wasm32-unknown-unknown
# Pinned trunk, built from crates.io with its lockfile.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install trunk --locked --version "${TRUNK_VERSION}"

WORKDIR /src
COPY . .

# The web client must be built first: the server embeds crates/web/dist.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    set -eux; \
    rustup show active-toolchain; \
    (cd crates/web && trunk build --release); \
    test -f crates/web/dist/index.html; \
    cargo build --release --locked -p opengrid; \
    install -m 0755 target/release/opengrid /usr/local/bin/opengrid

FROM ${RUNTIME_IMAGE}

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates tzdata; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system --gid 10001 opengrid; \
    useradd --system --uid 10001 --gid opengrid --home-dir /data \
        --no-create-home --shell /usr/sbin/nologin opengrid; \
    mkdir -p /data; \
    chown opengrid:opengrid /data

COPY --from=builder /usr/local/bin/opengrid /usr/local/bin/opengrid

ENV OPENGRID_DATA_DIR=/data \
    OPENGRID_BIND=0.0.0.0:8080

VOLUME /data
EXPOSE 8080
USER opengrid

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["opengrid", "healthcheck"]

ENTRYPOINT ["opengrid"]
CMD ["serve"]
