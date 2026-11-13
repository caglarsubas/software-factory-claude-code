# Runner image (ROADMAP P2-01, §3.2, Appendix B): one Claude Code session per container.
# Bases are pinned by digest and every download by SHA-256, which BuildKit checks on ADD; CI
# verifies each pinned download's publisher signature (gates/src/verify-tools.ts) before
# building. The CLI is the Agent SDK's own platform binary at the pinned version, and its hash
# must also equal the one the SDK's manifest.json lists (checked below and in a unit test).
# factoryctl tags the image with a hash of its build inputs (controller/src/runner/image.ts).
#
# The container runs as the operator's uid, with no capabilities, a read-only root, the
# runner's seccomp profile and an internal network whose only exit is the egress proxy
# (controller/src/runner/container.ts). Nothing under $FACTORY_HOME/secrets is ever mounted.
#
# The toolchain is the gate image's (gates/image/Dockerfile), so a builder runs a target's
# commands with the tools its gates use: Python from the same base, Node with npm and corepack
# (pnpm at the target's packageManager version), and uv. A unit test keeps the pins equal.
# No ENV here: the container's env is exactly the session's allowlist, which points the tools'
# caches at the task's own cache directory (controller/src/session/env.ts).
ARG TARGETARCH

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS node

FROM python:3.14.8-slim-trixie@sha256:f85c5697265c178cc6887276c55fe16cf3d14ca35c3df6a5eab3b360534a55d2 AS base

FROM base AS downloads-amd64
ADD --checksum=sha256:60f6a3b611f06c0561933bdbc66e7288a172bffcd76f02c221ad6f3ac866f440 \
    https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.306.tgz /dl/claude.tgz
ENV CLAUDE_SHA256=520bc6c1f40af466bd03a278b5ae1af1a2938bc7de5b9e5cb15526da20d71cfe
ADD --checksum=sha256:23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0 \
    https://github.com/astral-sh/uv/releases/download/0.12.21/uv-x86_64-unknown-linux-gnu.tar.gz /dl/uv.tar.gz

FROM base AS downloads-arm64
ADD --checksum=sha256:f788551166758d3ae3b9d7422426ff6eabf59e14aefcd714c4cf4bcda0170a2c \
    https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-0.3.306.tgz /dl/claude.tgz
ENV CLAUDE_SHA256=77d257d5e8b8730ec61d5a4992a8eb65550aaf9589f464988aa1a9684338d801
ADD --checksum=sha256:030b69227b40af8c1981b7301793dc66e71ed3c796ea8688209dd268bd91ec51 \
    https://github.com/astral-sh/uv/releases/download/0.12.21/uv-aarch64-unknown-linux-gnu.tar.gz /dl/uv.tar.gz

FROM downloads-${TARGETARCH} AS downloads
RUN tar -xzf /dl/claude.tgz -C /dl && echo "${CLAUDE_SHA256}  /dl/package/claude" | sha256sum -c - \
 && mkdir /dl/uv && tar -xzf /dl/uv.tar.gz -C /dl/uv --strip-components=1 --wildcards '*/uv' '*/uvx'

FROM base
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap=0.12.0-1~deb13u1 \
      ca-certificates=20250419 \
      git=1:2.47.3-0+deb13u1 \
      procps=2:4.0.4-9 \
      socat=1.8.0.3-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/*
# Directories first, readable by any uid: the runner runs as the operator's, and Claude Code runs
# on without its policy when it cannot read the managed settings (checked below as that user).
RUN install -d -m 0755 /etc/claude-code /opt/software-factory/hooks/lib /opt/software-factory/egress
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=downloads --chmod=0755 /dl/package/claude /usr/local/bin/claude
COPY --from=downloads --chmod=0755 /dl/uv/uv /dl/uv/uvx /usr/local/bin/
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable pnpm
COPY --chmod=0644 runner/managed-settings.json /etc/claude-code/managed-settings.json
COPY --chmod=0644 plugin/hooks/guard.ts plugin/hooks/require-gates.ts plugin/hooks/format-typecheck.ts plugin/hooks/ledger.ts /opt/software-factory/hooks/
COPY --chmod=0644 plugin/hooks/lib/ /opt/software-factory/hooks/lib/
COPY --chmod=0644 runner/egress/proxy.ts /opt/software-factory/egress/proxy.ts
RUN node --version && claude --version && bwrap --version && socat -V | head -n 2 && git --version \
 && python3 --version && uv --version && npm --version && corepack --version && test -x /usr/local/bin/pnpm
USER 10001:10001
RUN node -e 'const fs = require("node:fs"); JSON.parse(fs.readFileSync("/etc/claude-code/managed-settings.json", "utf8")); for (const f of ["hooks/guard.ts", "hooks/require-gates.ts", "hooks/format-typecheck.ts", "hooks/ledger.ts", "hooks/lib/io.ts", "egress/proxy.ts"]) fs.accessSync("/opt/software-factory/" + f, fs.constants.R_OK)'
