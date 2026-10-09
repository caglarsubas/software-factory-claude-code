# Gate runner image (ROADMAP P0-06). Base images are pinned by digest and every download by
# SHA-256, which BuildKit checks on ADD. CI verifies each pinned download's signature or
# provenance (verify-tools.sh) before building. The runner tags the image with a hash of its
# build inputs, so any change here or in ../rules produces a new image.
ARG TARGETARCH

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS node

FROM python:3.14.8-slim-trixie@sha256:f85c5697265c178cc6887276c55fe16cf3d14ca35c3df6a5eab3b360534a55d2 AS base

FROM base AS downloads-amd64
ADD --checksum=sha256:40377e6572495412fb9ba0bc21c9401f73b72f1d2afd11b9931bc4a5ed622866 \
    https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.9/trufflehog_3.97.9_linux_amd64.tar.gz /dl/trufflehog.tar.gz
ADD --checksum=sha256:ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108 \
    https://github.com/google/osv-scanner/releases/download/v2.6.0/osv-scanner_linux_amd64 /dl/osv-scanner
ADD --checksum=sha256:d3195b9d8d5ae93179f6aa5f5daaba6a920a5a09d38c5d5ae5e60924050210c4 \
    https://github.com/opengrep/opengrep/releases/download/v1.30.1/opengrep_manylinux_x86 /dl/opengrep
ADD --checksum=sha256:23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0 \
    https://github.com/astral-sh/uv/releases/download/0.12.21/uv-x86_64-unknown-linux-gnu.tar.gz /dl/uv.tar.gz

FROM base AS downloads-arm64
ADD --checksum=sha256:372c568695d49e53517075b5f74d1ee9a19053f13661d689c7928ee1fc27d705 \
    https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.9/trufflehog_3.97.9_linux_arm64.tar.gz /dl/trufflehog.tar.gz
ADD --checksum=sha256:2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4 \
    https://github.com/google/osv-scanner/releases/download/v2.6.0/osv-scanner_linux_arm64 /dl/osv-scanner
ADD --checksum=sha256:a730f6fdce1e978ea29e610a2e0503bfe1ec31fce08979a9a84e3699f03e16ee \
    https://github.com/opengrep/opengrep/releases/download/v1.30.1/opengrep_manylinux_aarch64 /dl/opengrep
ADD --checksum=sha256:030b69227b40af8c1981b7301793dc66e71ed3c796ea8688209dd268bd91ec51 \
    https://github.com/astral-sh/uv/releases/download/0.12.21/uv-aarch64-unknown-linux-gnu.tar.gz /dl/uv.tar.gz

FROM downloads-${TARGETARCH} AS tools
RUN mkdir /out \
 && tar -xzf /dl/trufflehog.tar.gz -C /out trufflehog \
 && tar -xzf /dl/uv.tar.gz -C /out --strip-components=1 --wildcards '*/uv' '*/uvx' \
 && install -m 0755 /dl/osv-scanner /out/osv-scanner \
 && install -m 0755 /dl/opengrep /out/opengrep

FROM base
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=tools /out/ /usr/local/bin/
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable pnpm \
 && groupadd --gid 10001 gates \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin gates \
 && mkdir -p /data/candidate /data/base /cache /osv \
 && chown -R 10001:10001 /data /cache /osv \
 && node --version && uv --version && trufflehog --version && osv-scanner --version && opengrep --version
COPY rules/*.yaml /opt/gates/rules/
COPY image/osv-seed/ /opt/gates/osv-seed/
# Caches live on the per-target cache volume (/cache) and the shared OSV database volume (/osv);
# the root filesystem is read-only at run time.
ENV HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    COREPACK_HOME=/cache/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    pnpm_config_store_dir=/cache/pnpm-store \
    npm_config_cache=/cache/npm \
    UV_CACHE_DIR=/cache/uv \
    UV_PYTHON_INSTALL_DIR=/cache/uv-python \
    UV_LINK_MODE=copy \
    OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=/osv \
    SEMGREP_SEND_METRICS=off \
    OPENGREP_ENABLE_VERSION_CHECK=0
USER 10001:10001
WORKDIR /data/candidate
