# syntax=docker/dockerfile:1.7
#
# OpenGrid container image. Build from the repository root:
#
#   docker build -f deploy/Dockerfile -t opengrid .
#
# Stage 1 (node) builds the React + TypeScript web client with Vite into
# web/dist. Stage 2 (rust) builds the server, which embeds web/dist into the
# binary. Stage 3 is a slim Debian runtime with only the binary, CA
# certificates and time zone data: no Node and no Rust toolchain at runtime.

ARG NODE_IMAGE=node:24-bookworm-slim
ARG RUST_IMAGE=rust:1-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim

# ---------------------------------------------------------------- web client
FROM ${NODE_IMAGE} AS web
WORKDIR /src/web
# Dependencies first, so source edits don't invalidate the npm layer.
# --ignore-scripts: no install-time scripts from third-party packages.
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts
COPY web/ ./
RUN npm run build && test -f dist/index.html

# -------------------------------------------------------------------- server
FROM ${RUST_IMAGE} AS builder
WORKDIR /src
COPY . .
# The server embeds web/dist at compile time (rust-embed).
COPY --from=web /src/web/dist ./web/dist
# The repo's rust-toolchain.toml asks for the wasm32 target (not needed for the
# server) and would make rustup download a second toolchain on every cold build.
# Use the toolchain that ships in the rust image instead.
RUN rm -f rust-toolchain.toml
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    set -eux; \
    rustup show active-toolchain; \
    cargo build --release --locked -p opengrid; \
    install -m 0755 target/release/opengrid /usr/local/bin/opengrid

# ------------------------------------------------------------------- runtime
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
