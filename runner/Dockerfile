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
ARG TARGETARCH

FROM node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS node

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS base

FROM base AS downloads-amd64
ADD --checksum=sha256:60f6a3b611f06c0561933bdbc66e7288a172bffcd76f02c221ad6f3ac866f440 \
    https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.306.tgz /dl/claude.tgz
ENV CLAUDE_SHA256=520bc6c1f40af466bd03a278b5ae1af1a2938bc7de5b9e5cb15526da20d71cfe

FROM base AS downloads-arm64
ADD --checksum=sha256:f788551166758d3ae3b9d7422426ff6eabf59e14aefcd714c4cf4bcda0170a2c \
    https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-0.3.306.tgz /dl/claude.tgz
ENV CLAUDE_SHA256=77d257d5e8b8730ec61d5a4992a8eb65550aaf9589f464988aa1a9684338d801

FROM downloads-${TARGETARCH} AS downloads
RUN tar -xzf /dl/claude.tgz -C /dl && echo "${CLAUDE_SHA256}  /dl/package/claude" | sha256sum -c -

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
COPY --from=downloads --chmod=0755 /dl/package/claude /usr/local/bin/claude
COPY --chmod=0644 runner/managed-settings.json /etc/claude-code/managed-settings.json
COPY --chmod=0644 plugin/hooks/guard.ts plugin/hooks/require-gates.ts plugin/hooks/format-typecheck.ts plugin/hooks/ledger.ts /opt/software-factory/hooks/
COPY --chmod=0644 plugin/hooks/lib/ /opt/software-factory/hooks/lib/
COPY --chmod=0644 runner/egress/proxy.ts /opt/software-factory/egress/proxy.ts
RUN node --version && claude --version && bwrap --version && socat -V | head -n 2 && git --version
USER 10001:10001
RUN node -e 'const fs = require("node:fs"); JSON.parse(fs.readFileSync("/etc/claude-code/managed-settings.json", "utf8")); for (const f of ["hooks/guard.ts", "hooks/require-gates.ts", "hooks/format-typecheck.ts", "hooks/ledger.ts", "hooks/lib/io.ts", "egress/proxy.ts"]) fs.accessSync("/opt/software-factory/" + f, fs.constants.R_OK)'
