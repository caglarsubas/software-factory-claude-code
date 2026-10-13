// The nightly smoke run's preconditions (P1-05): it needs its own key variable and a positive cap.
// The live run itself is the nightly job; the end-to-end path it drives is factoryctl.int.test.ts.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../controller/src/policy/load.ts";

const smoke = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [join(REPO_ROOT, "scripts/nightly-smoke.ts"), ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", ...env } });

describe("nightly-smoke", () => {
  it("refuses to start without SMOKE_ANTHROPIC_KEY, even when ANTHROPIC_API_KEY is set", () => {
    const r = smoke([], { ANTHROPIC_API_KEY: "not-this-one" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("SMOKE_ANTHROPIC_KEY is not set");
  });

  it("refuses a cap that is not a positive number", () => {
    expect(smoke(["--cap-usd", "0"], { SMOKE_ANTHROPIC_KEY: "k" }).stderr).toContain("--cap-usd must be a positive number");
  });
});
