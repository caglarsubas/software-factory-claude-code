# Gate runner image (ROADMAP P0-06). Base images are pinned by digest and every download by
# SHA-256, which BuildKit checks on ADD. CI verifies each pinned download's signature or
# provenance (verify-tools.ts) before building. The runner tags the image with a hash of its
# build inputs, so any change here or in ../rules produces a new image.
#
# The code graph (P2-13): graphifyy, with only the dependencies the gates' TypeScript and Python
# adapters need (it loads each grammar by name, on demand), as wheels pinned by SHA-256 and
# installed offline. CI verifies each wheel's PyPI provenance against its publisher's release
# workflow; the four tree-sitter wheels publish none, and are pinned by hash alone (STATUS
# deviation, 2026-10-23).
ARG TARGETARCH

FROM node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c AS node

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
ADD --checksum=sha256:d549420b8858885cea8838a727842249218b9c1da24dd517e25c9c7a948310a3 \
    https://files.pythonhosted.org/packages/16/d5/928078d2b28f26829b138b4a6c3980045022fb409f570657a224ae60ef4e/numpy-2.5.4-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl /wheels/numpy-2.5.4-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
ADD --checksum=sha256:08bc63b88048376114d1e66cf8fa6926495d03bb873eb87854fa74cf6848a70b \
    https://files.pythonhosted.org/packages/6d/56/1203b46cedefc3f0c16e10d87123fdd4ec0f2e209f65cd2bf221ec669217/rapidfuzz-3.14.6-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl /wheels/rapidfuzz-3.14.6-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
ADD --checksum=sha256:260586381b23be33b6191a07cea3d44ecbd6c01aa4c6b027a0439145fcbc3358 \
    https://files.pythonhosted.org/packages/48/b6/cf08f4f20f4c9094006ef8828555484e842fc468827ad6e56011ab668dbd/tree_sitter-0.25.2-cp314-cp314-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl /wheels/tree_sitter-0.25.2-cp314-cp314-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl
ADD --checksum=sha256:9dc04ba91fc8583344e57c1f1ed5b2c97ecaaf47480011b92fbeab8dda96db75 \
    https://files.pythonhosted.org/packages/5f/c4/7da74ecdcd8a398f88bd003a87c65403b5fe0e958cdd43fbd5fd4a398fcf/tree_sitter_javascript-0.25.0-cp310-abi3-manylinux1_x86_64.manylinux_2_28_x86_64.manylinux_2_5_x86_64.whl /wheels/tree_sitter_javascript-0.25.0-cp310-abi3-manylinux1_x86_64.manylinux_2_28_x86_64.manylinux_2_5_x86_64.whl
ADD --checksum=sha256:86f118e5eecad616ecdb81d171a36dde9bef5a0b21ed71ea9c3e390813c3baf5 \
    https://files.pythonhosted.org/packages/aa/cb/d9b0b67d037922d60cbe0359e0c86457c2da721bc714381a63e2c8e35eba/tree_sitter_python-0.25.0-cp310-abi3-manylinux1_x86_64.manylinux_2_28_x86_64.manylinux_2_5_x86_64.whl /wheels/tree_sitter_python-0.25.0-cp310-abi3-manylinux1_x86_64.manylinux_2_28_x86_64.manylinux_2_5_x86_64.whl
ADD --checksum=sha256:e96d36b85bcacdeb8ff5c2618d75593ef12ebaf1b4eace3477e2bdb2abb1752c \
    https://files.pythonhosted.org/packages/49/d1/a71c36da6e2b8a4ed5e2970819b86ef13ba77ac40d9e333cb17df6a2c5db/tree_sitter_typescript-0.23.2-cp39-abi3-manylinux_2_5_x86_64.manylinux1_x86_64.manylinux_2_17_x86_64.manylinux2014_x86_64.whl /wheels/tree_sitter_typescript-0.23.2-cp39-abi3-manylinux_2_5_x86_64.manylinux1_x86_64.manylinux_2_17_x86_64.manylinux2014_x86_64.whl

FROM base AS downloads-arm64
ADD --checksum=sha256:372c568695d49e53517075b5f74d1ee9a19053f13661d689c7928ee1fc27d705 \
    https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.9/trufflehog_3.97.9_linux_arm64.tar.gz /dl/trufflehog.tar.gz
ADD --checksum=sha256:2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4 \
    https://github.com/google/osv-scanner/releases/download/v2.6.0/osv-scanner_linux_arm64 /dl/osv-scanner
ADD --checksum=sha256:a730f6fdce1e978ea29e610a2e0503bfe1ec31fce08979a9a84e3699f03e16ee \
    https://github.com/opengrep/opengrep/releases/download/v1.30.1/opengrep_manylinux_aarch64 /dl/opengrep
ADD --checksum=sha256:030b69227b40af8c1981b7301793dc66e71ed3c796ea8688209dd268bd91ec51 \
    https://github.com/astral-sh/uv/releases/download/0.12.21/uv-aarch64-unknown-linux-gnu.tar.gz /dl/uv.tar.gz
ADD --checksum=sha256:4054173604cd8658796053f1f3bc0befb68ec1c0762c57fdad61e199256a8617 \
    https://files.pythonhosted.org/packages/63/d6/34b0a2b0741386a63025a65a2c09caaaaaad6d0ca95b66cd65c30dd7fcb5/numpy-2.5.4-cp314-cp314-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl /wheels/numpy-2.5.4-cp314-cp314-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl
ADD --checksum=sha256:760ee152af5e8b4d241a469f933ba2d7215248618ae19770fec7d80d9e149db6 \
    https://files.pythonhosted.org/packages/4b/ae/8e0f714c55180667d66346e46a3d680dd9809bcee1c5f03557a58b4f2ef6/rapidfuzz-3.14.6-cp314-cp314-manylinux_2_26_aarch64.manylinux_2_28_aarch64.whl /wheels/rapidfuzz-3.14.6-cp314-cp314-manylinux_2_26_aarch64.manylinux_2_28_aarch64.whl
ADD --checksum=sha256:eac4e8e4c7060c75f395feec46421eb61212cb73998dbe004b7384724f3682ab \
    https://files.pythonhosted.org/packages/b6/19/1e968aa0b1b567988ed522f836498a6a9529a74aab15f09dd9ac1e41f505/tree_sitter-0.25.2-cp314-cp314-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl /wheels/tree_sitter-0.25.2-cp314-cp314-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl
ADD --checksum=sha256:199d09985190852e0912da2b8d26c932159be314bc04952cf917ed0e4c633e6b \
    https://files.pythonhosted.org/packages/96/c8/97da3af4796495e46421e9344738addb3602fa6426ea695be3fcbadbee37/tree_sitter_javascript-0.25.0-cp310-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl /wheels/tree_sitter_javascript-0.25.0-cp310-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl
ADD --checksum=sha256:be71650ca2b93b6e9649e5d65c6811aad87a7614c8c1003246b303f6b150f61b \
    https://files.pythonhosted.org/packages/40/bd/bf4787f57e6b2860f3f1c8c62f045b39fb32d6bac4b53d7a9e66de968440/tree_sitter_python-0.25.0-cp310-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl /wheels/tree_sitter_python-0.25.0-cp310-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl
ADD --checksum=sha256:4b1eed5b0b3a8134e86126b00b743d667ec27c63fc9de1b7bb23168803879e31 \
    https://files.pythonhosted.org/packages/96/2d/975c2dad292aa9994f982eb0b69cc6fda0223e4b6c4ea714550477d8ec3a/tree_sitter_typescript-0.23.2-cp39-abi3-manylinux_2_17_aarch64.manylinux2014_aarch64.whl /wheels/tree_sitter_typescript-0.23.2-cp39-abi3-manylinux_2_17_aarch64.manylinux2014_aarch64.whl

FROM base AS wheels-any
ADD --checksum=sha256:47a7ce09d912e741812523d2230c6e860a768e7fb92d7a9fad0718a3a2484118 \
    https://files.pythonhosted.org/packages/62/94/7d77cb00fff7b2ff20168752bb46d0e38a2828ded06a4e9c11582d1e8c97/graphifyy-0.9.91-py3-none-any.whl /wheels/graphifyy-0.9.91-py3-none-any.whl
ADD --checksum=sha256:e3fd2c13a7814cee3746340d8d7f8598a67f16a58bf47fb7f8793fab6efca1b0 \
    https://files.pythonhosted.org/packages/7e/cd/fe58041e9011f307c490e3e17dd48cc516448f7c698a3f2d9d9d65d7e6a8/networkx-3.7-py3-none-any.whl /wheels/networkx-3.7-py3-none-any.whl

FROM downloads-${TARGETARCH} AS tools
RUN mkdir /out \
 && tar -xzf /dl/trufflehog.tar.gz -C /out trufflehog \
 && tar -xzf /dl/uv.tar.gz -C /out --strip-components=1 --wildcards '*/uv' '*/uvx' \
 && install -m 0755 /dl/osv-scanner /out/osv-scanner \
 && install -m 0755 /dl/opengrep /out/opengrep

# Its own venv, installed from the pinned wheels alone; the build fails unless it finds a
# cross-file import in a tiny TypeScript tree and a tiny Python tree.
FROM downloads-${TARGETARCH} AS graphify
COPY --from=wheels-any /wheels/ /wheels/
RUN python -m venv /opt/graphify \
 && /opt/graphify/bin/python -m pip install --no-deps --no-index --no-cache-dir --disable-pip-version-check /wheels/*.whl \
 && mkdir -p /tmp/smoke/ts /tmp/smoke/py \
 && printf 'export const b = 1;\n' > /tmp/smoke/ts/b.ts \
 && printf 'import { b } from "./b.ts";\nexport const a = b;\n' > /tmp/smoke/ts/a.ts \
 && printf 'B = 1\n' > /tmp/smoke/py/b.py \
 && printf 'from b import B\nA = B\n' > /tmp/smoke/py/a.py \
 && for t in ts py; do \
      GRAPHIFY_OUT=/tmp/smoke/out-$t /opt/graphify/bin/graphify update /tmp/smoke/$t --no-cluster > /dev/null \
      && /opt/graphify/bin/python -c "import json, sys; g = json.load(open('/tmp/smoke/out-$t/graph.json')); f = {n['id']: n.get('source_file') for n in g['nodes']}; sys.exit(0 if any(f.get(l['source']) and f.get(l['target']) and f.get(l['source']) != f.get(l['target']) for l in g['links']) else 1)" \
      || exit 1; \
    done \
 && rm -rf /tmp/smoke

FROM base
# git and ps: a target's own tests often build repositories or inspect processes (this factory's do).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git=1:2.47.3-0+deb13u1 procps=2:4.0.4-9 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=tools /out/ /usr/local/bin/
COPY --from=graphify /opt/graphify /opt/graphify
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable pnpm \
 && ln -s /opt/graphify/bin/graphify /usr/local/bin/graphify \
 && groupadd --gid 10001 gates \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin gates \
 && mkdir -p /data/candidate /data/base /cache /osv \
 && chown -R 10001:10001 /data /cache /osv \
 && node --version && uv --version && trufflehog --version && osv-scanner --version && opengrep --version && graphify --version \
 && git --version && ps --version
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
