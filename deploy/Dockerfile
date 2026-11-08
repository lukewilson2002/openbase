# syntax=docker/dockerfile:1.7
#
# OpenBase container image. Build from the repository root:
#
#   docker build -f deploy/Dockerfile -t openbase .
#
# Stage 1 (node) builds the React + TypeScript web client with Vite into
# web/dist. Stage 2 (rust) builds the server, which embeds web/dist into the
# binary. The last stage is a slim Debian 13 (trixie) runtime with only the
# binary, CA certificates, time zone data and ffmpeg: no Node and no Rust
# toolchain at runtime.
# The default target (`docker build` without --target) builds everything from
# source and runs on any architecture Docker can build for (linux/amd64 and
# linux/arm64 are the tested ones).
#
# The release workflow (.github/workflows/release.yml) uses three more targets
# so that the web client is built once and the binary in the published image is
# byte-for-byte the one attached to the GitHub Release:
#
#   --target binary            exports just /openbase (docker build --output)
#   --build-arg WEB_DIST=web-prebuilt
#                              take the web client from ./.web-dist instead of
#                              building it with Node
#   --target runtime-prebuilt  the runtime image around a binary the workflow
#                              already built: ./release-bin/<arch>/openbase
#
# People who build locally never need these.

# The base images are written out in the FROM lines below, pinned by digest, so that Dependabot
# (the docker ecosystem for /deploy) can propose updates for them. The tag is for people, the
# digest is what is actually pulled: a re-tagged or compromised upstream image cannot reach a
# build unnoticed.
# Where the server build takes the web client from: `web-built` (built below by
# Node, the default) or `web-prebuilt` (a ./.web-dist directory in the build
# context, used by the release workflow).
ARG WEB_DIST=web-built

# ---------------------------------------------------------------- web client
FROM node:26-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS web
WORKDIR /src/web
# Dependencies first, so source edits don't invalidate the npm layer.
# --ignore-scripts: no install-time scripts from third-party packages.
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts
COPY web/ ./
RUN npm run build && test -f dist/index.html

FROM scratch AS web-built
COPY --from=web /src/web/dist /dist

FROM scratch AS web-prebuilt
COPY .web-dist/ /dist/

# Whichever of the two above WEB_DIST names (FROM can expand build args, COPY --from cannot).
FROM ${WEB_DIST} AS web-dist

# -------------------------------------------------------------------- server
# Debian 12 on purpose: the binary links glibc 2.36, so the release tarballs also run on older
# distributions. The runtime image below is newer, which is fine (glibc is backward compatible).
# The tag is the Rust version of rust-toolchain.toml; the build stops below if the two differ.
FROM rust:1.99.1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c AS builder
WORKDIR /src
COPY . .
# The server embeds web/dist at compile time (rust-embed).
COPY --from=web-dist /dist ./web/dist
# The repo's rust-toolchain.toml asks for the wasm32 target (not needed for the
# server) and would make rustup download a second toolchain on every cold build.
# Use the toolchain that ships in the rust image instead, after checking that it is
# the version rust-toolchain.toml pins (so CI, developers and the image agree).
RUN set -eu; \
    pinned=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml); \
    have=$(rustc --version | cut -d' ' -f2); \
    if [ "$pinned" != "$have" ]; then \
        echo "rust-toolchain.toml pins Rust $pinned but the builder image has $have: change the rust: tag in deploy/Dockerfile" >&2; \
        exit 1; \
    fi; \
    rm -f rust-toolchain.toml
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    set -eux; \
    rustup show active-toolchain; \
    cargo build --release --locked -p openbase; \
    install -m 0755 target/release/openbase /usr/local/bin/openbase

# The compiled binary on its own (docker build --target binary --output ...).
FROM scratch AS binary
COPY --from=builder /usr/local/bin/openbase /openbase

# ------------------------------------------------------------------- runtime
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS runtime-base

# ffmpeg takes the first frame of uploaded videos as their preview.
# `apt-get upgrade` because the digest-pinned base image is rebuilt by Debian only every
# so often, so it can lag a published security fix by days (Trivy flagged zlib1g that way);
# the packages come from Debian's signed security archive either way.
RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y --no-install-recommends; \
    apt-get install -y --no-install-recommends ca-certificates tzdata ffmpeg; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --system --gid 10001 openbase; \
    useradd --system --uid 10001 --gid openbase --home-dir /data \
        --no-create-home --shell /usr/sbin/nologin openbase; \
    mkdir -p /data; \
    chown openbase:openbase /data

ENV OPENBASE_DATA_DIR=/data \
    OPENBASE_BIND=0.0.0.0:8080

VOLUME /data
EXPOSE 8080
USER openbase

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["openbase", "healthcheck"]

ENTRYPOINT ["openbase"]
CMD ["serve"]

# Release workflow: the binary was built before (natively, or cross-compiled),
# one per architecture, under release-bin/<amd64|arm64>/openbase.
FROM runtime-base AS runtime-prebuilt
ARG TARGETARCH
COPY --chmod=0755 release-bin/${TARGETARCH}/openbase /usr/local/bin/openbase

# Default target: the binary built from source above. Keep this stage last.
FROM runtime-base AS runtime
COPY --from=builder /usr/local/bin/openbase /usr/local/bin/openbase
