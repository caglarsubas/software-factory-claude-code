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
ADD --checksum=sha256:3e8a076433571db441447a85624fd9ce2a2fd50c326c0e7b456a034be3e443b2 \
    https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.286.tgz /dl/claude.tgz
ENV CLAUDE_SHA256=fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f

FROM base AS downloads-arm64
ADD --checksum=sha256:300a7c03cb3eca8cccef6ae8f8a7b1397973b01ebd4aa92279db852c9718fb55 \
    https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-0.3.286.tgz /dl/claude.tgz
ENV CLAUDE_SHA256=0292fa22ac2fd43e16be9d0e511ddd8347280d6e0ebaca744ef5b27e05d8d0f8

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
