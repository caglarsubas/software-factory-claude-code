import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATES_DIR } from "./image.ts";
import { pins, verification } from "./verify-tools.ts";

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
  it("reject downloads with no defined verifier", () => {
    expect(() => verification({ sha256: "0".repeat(64), url: "https://github.com/acme/tool/releases/download/v1.0.0/tool" }, "tool")).toThrow(/no signature/);
    expect(() => verification({ sha256: "0".repeat(64), url: "https://example.com/tool.tar.gz" }, "tool")).toThrow(/not a GitHub release/);
  });
});
