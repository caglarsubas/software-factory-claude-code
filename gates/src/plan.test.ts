import { describe, expect, it } from "vitest";
import { isLockfile, phaseEnv, planGates, type GateProfile } from "./plan.ts";

const profile = (over: Partial<GateProfile> = {}): GateProfile => ({
  commands: { setup: "pnpm install --frozen-lockfile", typecheck: "pnpm exec tsc --noEmit", lint: "pnpm lint", test: "pnpm test" },
  gates: { adapters: ["typescript"] },
  invariants: [{ id: "INV-1", text: "contract", check: "pnpm test contract" }, { id: "INV-2", text: "no check" }],
  ...over,
});

describe("planGates", () => {
  it("orders command gates build, typecheck, lint, test, then checked invariants", () => {
    const plan = planGates(profile({ commands: { test: "t", lint: "l", build: "b", typecheck: "c" } }));
    expect(plan.commands.map((c) => c.name)).toEqual(["build", "typecheck", "lint", "test", "invariant-inv-1"]);
    expect(plan.setup).toBeNull();
  });
  it("always runs both rule packs, whatever the profile lists", () => {
    expect(planGates(profile({ gates: { adapters: ["python"], sast_rules: [] } })).rulePacks).toEqual(["default", "sink_added"]);
  });
  it("rejects unknown adapters, unknown rule packs and an empty adapter list", () => {
    expect(() => planGates(profile({ gates: { adapters: ["cobol"] } }))).toThrow(/adapter/);
    expect(() => planGates(profile({ gates: { adapters: ["typescript"], sast_rules: ["registry-p-all"] } }))).toThrow(/rule pack/);
    expect(() => planGates(profile({ gates: { adapters: ["toString"] } }))).toThrow(/adapter/);
    expect(() => planGates(profile({ gates: { adapters: [] } }))).toThrow(/no gate adapter/);
  });
  it("rejects an invariant id that cannot form a gate name", () => {
    expect(() => planGates(profile({ invariants: [{ id: "INV 1!", text: "x", check: "y" }] }))).toThrow(/gate name/);
  });
});

describe("adapters", () => {
  const both = planGates(profile({ gates: { adapters: ["typescript", "python", "typescript"] } }));
  it("deduplicate and merge their environments", () => {
    expect(both.adapters).toEqual(["typescript", "python"]);
    expect(phaseEnv(both, "setupEnv")).toMatchObject({ pnpm_config_ignore_scripts: "true", UV_NO_BUILD: "1" });
    expect(phaseEnv(both, "offlineEnv")).toMatchObject({ COREPACK_ENABLE_NETWORK: "0", UV_OFFLINE: "1" });
  });
  it("recognise their lockfiles at any depth", () => {
    expect(isLockfile(both, "pnpm-lock.yaml")).toBe(true);
    expect(isLockfile(both, "services/api/uv.lock")).toBe(true);
    expect(isLockfile(both, "requirements-dev.txt")).toBe(true);
    expect(isLockfile(both, "src/pnpm-lock.yaml.bak")).toBe(false);
    expect(isLockfile(planGates(profile()), "uv.lock")).toBe(false);
  });
});
