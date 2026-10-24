import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATES_DIR } from "./image.ts";
import { checkNpm, checkPypiRecord, DOCKERFILES, npmSignatureValid, pins, PYPI_PUBLISHERS, PYPI_UNATTESTED, pypiBundle, pypiIdentity, verification, wheelName } from "./verify-tools.ts";

const dockerfile = readFileSync(join(GATES_DIR, "image/Dockerfile"), "utf8");

describe("gate image pins", () => {
  const all = pins(dockerfile);

  it("finds every download in the Dockerfile", () => {
    expect(all.length).toBe(dockerfile.match(/^ADD /gm)?.length);
    expect(all.length).toBeGreaterThanOrEqual(8);
  });
  it("have a signature or provenance check each", () => {
    for (const pin of all) expect(() => verification(pin, "file"), pin.url).not.toThrow();
  });
  it("pin both architectures for each tool", () => {
    // A release download's repository, or a wheel's project; a universal wheel names no architecture.
    const name = (url: string): string => (url.startsWith("https://files.pythonhosted.org/") ? wheelName(url.split("/").at(-1) ?? "").project : url.split("/")[4] ?? "");
    const tools = (arch: RegExp) => all.filter((p) => arch.test(p.url.split("/").at(-1) ?? "")).map((p) => name(p.url)).sort();
    expect(tools(/amd64|x86/)).toEqual(tools(/arm64|aarch64/));
  });
  it("pin base images by digest", () => {
    // Lines that build on an earlier stage name no registry image.
    const stages = [...dockerfile.matchAll(/^FROM \S+ AS (\S+)$/gm)].map((m) => m[1] ?? "");
    const external = (dockerfile.match(/^FROM \S+/gm) ?? []).map((f) => f.slice(5)).filter((ref) => !stages.some((s) => ref === s || ref.startsWith(`${s.replace(/-amd64$/, "")}-$`)));
    expect(external.length).toBe(2);
    for (const ref of external) expect(ref).toMatch(/^[\w.:/-]+@sha256:[0-9a-f]{64}$/);
  });
  it("pin every Debian package by version, and carry git and ps for targets' test suites", () => {
    const installs = [...dockerfile.matchAll(/apt-get install -y --no-install-recommends ([^\\\n]+)/g)].flatMap((m) => (m[1] ?? "").trim().split(/\s+/));
    expect(installs.map((p) => p.split("=")[0]).sort()).toEqual(["git", "procps"]);
    for (const p of installs) expect(p, p).toMatch(/^[a-z0-9.+-]+=\S+$/);
    // The build itself fails if either is missing.
    expect(dockerfile).toMatch(/&& git --version && ps --version/);
  });
  it("reject downloads with no defined verifier", () => {
    expect(() => verification({ sha256: "0".repeat(64), url: "https://github.com/acme/tool/releases/download/v1.0.0/tool" }, "tool")).toThrow(/no signature/);
    expect(() => verification({ sha256: "0".repeat(64), url: "https://example.com/tool.tar.gz" }, "tool")).toThrow(/not a GitHub release/);
  });
});

describe("the code graph's wheels (P2-13)", () => {
  const wheels = pins(dockerfile).filter((p) => p.url.startsWith("https://files.pythonhosted.org/"));
  const file = (p: { url: string }): string => p.url.split("/").at(-1) ?? "";
  const provenance = JSON.parse(readFileSync(join(GATES_DIR, "src/testdata/graphifyy-0.9.91.provenance.json"), "utf8")) as Parameters<typeof pypiBundle>[0];
  const graphify = wheels.find((p) => file(p).startsWith("graphifyy-"));

  it("are graphifyy and only what the gates' TypeScript and Python adapters need", () => {
    expect([...new Set(wheels.map((p) => wheelName(file(p)).project))].sort()).toEqual(["graphifyy", "networkx", "numpy", "rapidfuzz", "tree-sitter", "tree-sitter-javascript", "tree-sitter-python", "tree-sitter-typescript"]);
  });

  it("each name a pinned publisher, or are pinned by hash alone by name", () => {
    for (const p of wheels) {
      const { project, version } = wheelName(file(p));
      const plan = verification(p, file(p));
      if (PYPI_PUBLISHERS[project] !== undefined) {
        expect(plan.fetch).toEqual([`https://pypi.org/integrity/${project}/${version}/${file(p)}/provenance`]);
        expect(plan.run[0]).toEqual(expect.arrayContaining(["cosign", "verify-blob-attestation", "--certificate-identity-regexp", pypiIdentity(project, version)]));
      } else {
        expect(PYPI_UNATTESTED[project], project).toBeDefined();
        expect(plan.fetch).toEqual([`https://pypi.org/pypi/${project}/${version}/json`]);
        // The deviation ends when the project starts publishing provenance.
        expect(plan.run[0]?.join(" ")).toMatch(/= 404 \|\| /);
      }
    }
    expect(() => verification({ sha256: "0".repeat(64), url: `https://files.pythonhosted.org/packages/aa/bb/${"c".repeat(60)}/evil-1.0-py3-none-any.whl` }, "evil-1.0-py3-none-any.whl")).toThrow(/no signature or provenance check is defined for PyPI project evil/);
  });

  it("hold each attested wheel to its release workflow's certificate, at its own ref", () => {
    const re = (project: string, version: string) => new RegExp(pypiIdentity(project, version));
    expect(re("graphifyy", "0.9.91").test("https://github.com/Graphify-Labs/graphify/.github/workflows/publish.yml@refs/tags/v0.9.91")).toBe(true);
    expect(re("graphifyy", "0.9.91").test("https://github.com/Graphify-Labs/graphify/.github/workflows/publish.yml@refs/tags/v0.9.92")).toBe(false);
    expect(re("graphifyy", "0.9.91").test("https://github.com/someone/graphify/.github/workflows/publish.yml@refs/tags/v0.9.91")).toBe(false);
    expect(re("numpy", "2.5.4").test("https://github.com/numpy/numpy-release/.github/workflows/wheels.yml@refs/heads/maintenance/2.5.x")).toBe(true);
    expect(re("rapidfuzz", "3.14.6").test("https://github.com/rapidfuzz/RapidFuzz/.github/workflows/releasebuild.yml@refs/tags/v3.14.6-1")).toBe(true);
    expect(re("networkx", "3.7").test("https://github.com/networkx/networkx/.github/workflows/release.yml@refs/tags/networkx-3.7")).toBe(true);
  });

  it("recast PyPI's provenance as a Sigstore bundle only for the pinned publisher, file and digest", () => {
    if (graphify === undefined) throw new Error("graphifyy is not pinned");
    const bundle = pypiBundle(provenance, "graphifyy", file(graphify), graphify.sha256) as { mediaType: string; verificationMaterial: { tlogEntries: unknown[] }; dsseEnvelope: { payloadType: string } };
    expect(bundle.mediaType).toBe("application/vnd.dev.sigstore.bundle.v0.3+json");
    expect(bundle.verificationMaterial.tlogEntries).toHaveLength(1);
    expect(bundle.dsseEnvelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(() => pypiBundle(provenance, "graphifyy", file(graphify), "0".repeat(64))).toThrow(/not this file at the pinned digest/);
    expect(() => pypiBundle(provenance, "graphifyy", "graphifyy-0.9.92-py3-none-any.whl", graphify.sha256)).toThrow(/not this file/);
    const forged = structuredClone(provenance);
    const first = forged.attestation_bundles?.[0];
    if (first?.publisher !== undefined) first.publisher.repository = "someone/graphify";
    expect(() => pypiBundle(forged, "graphifyy", file(graphify), graphify.sha256)).toThrow(/no attestation by Graphify-Labs\/graphify/);
  });

  it("accept an unattested wheel only as PyPI lists it, at the pinned digest", () => {
    const pin = wheels.find((p) => file(p).startsWith("tree_sitter-"));
    if (pin === undefined) throw new Error("tree-sitter is not pinned");
    const f = file(pin);
    checkPypiRecord(pin, f, { urls: [{ filename: f, url: pin.url, digests: { sha256: pin.sha256 } }] });
    expect(() => {
      checkPypiRecord(pin, f, { urls: [{ filename: f, url: pin.url, digests: { sha256: "0".repeat(64) } }] });
    }).toThrow(/not the pin/);
    expect(() => {
      checkPypiRecord(pin, f, { urls: [] });
    }).toThrow(/does not list/);
  });
});

describe("runner image pins (P2-01)", () => {
  const runner = readFileSync(join(GATES_DIR, "../runner/Dockerfile"), "utf8");
  const all = pins(runner);
  const x64 = {
    name: "@anthropic-ai/claude-agent-sdk-linux-x64",
    version: "0.3.286",
    dist: {
      tarball: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64/-/claude-agent-sdk-linux-x64-0.3.286.tgz",
      integrity: "sha512-kNczbWhWJ1G8sPRZd4Nsx/Ozr/kx16lT2NGp/EEmTV4Hn732xfLkUOlg+tFcS78i6lOPBknjDB/cz/J5Ha4wDQ==",
      signatures: [{ keyid: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U", sig: "MEUCIFb58X9+mOEriXHKFErWAI8g8aHXYs0P8PvCc7cQbkLfAiEA3E/xAMdiUbyuVotLXcztmyeQViGS0hfl9AuFuI4XhHw=" }],
    },
  };

  it("are read with the gate image's, one CLI binary per architecture, each with a registry check", () => {
    expect(DOCKERFILES).toContain("../runner/Dockerfile");
    expect(all.map((p) => p.url.split("/")[4])).toEqual(["claude-agent-sdk-linux-x64", "claude-agent-sdk-linux-arm64"]);
    for (const pin of all) expect(verification(pin, "claude.tgz").check, pin.url).toBeTypeOf("function");
  });
  it("pin base images by digest and Debian packages by version", () => {
    const stages = [...runner.matchAll(/^FROM \S+ AS (\S+)$/gm)].map((m) => m[1] ?? "");
    const external = (runner.match(/^FROM \S+/gm) ?? []).map((f) => f.slice(5)).filter((ref) => !stages.some((s) => ref === s || ref.startsWith(`${s.replace(/-amd64$/, "")}-$`)));
    expect(external.length).toBe(2);
    for (const ref of external) expect(ref).toMatch(/^[\w.:/-]+@sha256:[0-9a-f]{64}$/);
    const installs = [...runner.matchAll(/^\s+([a-z0-9.+-]+=\S+) \\$/gm)].map((m) => m[1] ?? "");
    expect(installs.map((p) => p.split("=")[0]).sort()).toEqual(["bubblewrap", "ca-certificates", "git", "procps", "socat"]);
  });
  it("accept only npm's pinned registry key, over the exact name, version and integrity", () => {
    expect(npmSignatureValid(x64.name, x64.version, x64.dist)).toBe(true);
    expect(npmSignatureValid(x64.name, "0.3.287", x64.dist)).toBe(false);
    expect(npmSignatureValid(x64.name, x64.version, { ...x64.dist, integrity: x64.dist.integrity.replace("k", "K") })).toBe(false);
    expect(npmSignatureValid(x64.name, x64.version, { ...x64.dist, signatures: [{ keyid: "SHA256:other", sig: x64.dist.signatures[0]?.sig ?? "" }] })).toBe(false);
  });
  it("reject a tarball whose bytes or registry record do not match its pin", () => {
    const pin = { sha256: "0".repeat(64), url: x64.dist.tarball };
    expect(() => {
      checkNpm(pin, Buffer.from("not the tarball"), x64);
    }).toThrow(/integrity/);
    expect(() => {
      checkNpm(pin, Buffer.from("x"), { ...x64, name: "@anthropic-ai/other" });
    }).toThrow(/does not name/);
  });
});
