import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATES_DIR } from "./image.ts";
import { checkNpm, DOCKERFILES, npmSignatureValid, pins, verification } from "./verify-tools.ts";

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
    const tools = (arch: RegExp) => all.filter((p) => arch.test(p.url)).map((p) => p.url.split("/")[4]).sort();
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
