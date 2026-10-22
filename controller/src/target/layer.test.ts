// The onboarding layer (P2-11): it merges into what a target has, records what it added, and
// offboarding's removeLayer gives back the target's own files byte for byte.
import { describe, expect, it } from "vitest";
import { loadRiskPolicy, withProfile } from "../policy/load.ts";
import { codeownersPattern, INVARIANTS_FILE, LayerError, PLUGIN, removeLayer, renderLayer, SETTINGS_FILE, type LayerInput } from "./layer.ts";

const FOOTPRINT = [".factory/policy.yaml", ".factory/gates.yaml", ".github/workflows/factory-gates.yml", ".github/workflows/policy-check.yml"];
const profile = {
  protected_paths: [{ glob: "src/auth/**", minimum_risk: "R3" as const }],
  restricted: [{ glob: "infra/prod/**" }],
  invariants: [{ id: "INV-1", text: "Totals never go negative.", check: "node --test" }],
  spec_dir: "docs/specs",
  governance: { approvers: ["alice", "@bob"] },
};
const risk = withProfile(loadRiskPolicy(), profile);

/** A target's files as a map, with the layer applied to it or taken out of it. */
function apply(files: Map<string, string>, change: Record<string, string | null>): Map<string, string> {
  const next = new Map(files);
  for (const [path, content] of Object.entries(change)) {
    if (content === null) next.delete(path);
    else next.set(path, content);
  }
  return next;
}

const input = (files: Map<string, string>): LayerInput => ({ repo: "example/t", profile, risk, release: { repo: "example/factory", tag: "v0.22.0" }, footprint: FOOTPRINT, existing: (p) => files.get(p) ?? null });

describe("the onboarding layer", () => {
  const original = new Map([
    ["CLAUDE.md", "# Project\n\nUse tabs.\n"],
    [SETTINGS_FILE, `${JSON.stringify({ permissions: { deny: ["Read(./.env)"] }, enabledPlugins: { "other@team": true } }, null, 2)}\n`],
    ["src/app.ts", "export {};\n"],
  ]);

  it("merges into the target's files and records exactly what it added", () => {
    const { files, record } = renderLayer(input(original));
    expect(Object.keys(files).sort()).toEqual([".claude/rules/factory-invariants.md", SETTINGS_FILE, ".github/CODEOWNERS", "CLAUDE.md"].sort());
    expect(files["CLAUDE.md"]?.startsWith("# Project\n\nUse tabs.\n\n<!-- BEGIN software-factory -->\n## The software factory\n")).toBe(true);
    expect(files["CLAUDE.md"]).toContain("`src/auth/**`");
    expect(files["CLAUDE.md"]).toContain("`infra/prod/**`");
    const owners = files[".github/CODEOWNERS"] ?? "";
    expect(owners).toContain("/src/auth/** @alice @bob\n");
    expect(owners).toContain("/infra/prod/** @alice @bob\n");
    expect(owners).toContain("**/CODEOWNERS @alice @bob\n");
    expect(owners).toContain("/.github/workflows/policy-check.yml @alice @bob\n");
    expect(files[INVARIANTS_FILE]).toContain("- **INV-1:** Totals never go negative. Checked by `node --test`.");
    const settings = JSON.parse(files[SETTINGS_FILE] ?? "{}") as Record<string, Record<string, unknown>>;
    expect(settings["extraKnownMarketplaces"]).toEqual({ "software-factory": { source: { source: "github", repo: "example/factory", ref: "v0.22.0" } } });
    expect(settings["enabledPlugins"]).toEqual({ "other@team": true, [PLUGIN]: true });
    expect(settings["permissions"]).toEqual({ deny: ["Read(./.env)"] });
    expect(record).toEqual({ created: [".github/CODEOWNERS", INVARIANTS_FILE], blocks: [".github/CODEOWNERS", "CLAUDE.md"], settings: ["extraKnownMarketplaces.software-factory", `enabledPlugins.${PLUGIN}`] });
  });

  it("comes out without a trace: every file of the target's back byte for byte", () => {
    const { files, record } = renderLayer(input(original));
    const onboarded = apply(original, files);
    const back = apply(onboarded, removeLayer(record, (p) => onboarded.get(p) ?? null));
    expect([...back.entries()].sort()).toEqual([...original.entries()].sort());
  });

  it("keeps what people add around its blocks, and goes from a file it created only when nothing else is left", () => {
    const empty = new Map<string, string>();
    const { files, record } = renderLayer(input(empty));
    expect(record.created).toEqual([".github/CODEOWNERS", "CLAUDE.md", INVARIANTS_FILE, SETTINGS_FILE]);
    const onboarded = apply(empty, files);
    expect([...apply(onboarded, removeLayer(record, (p) => onboarded.get(p) ?? null)).keys()]).toEqual([]);
    const edited = new Map(onboarded);
    edited.set("CLAUDE.md", `${onboarded.get("CLAUDE.md") ?? ""}\n## Ours\n\nAdded later.\n`);
    const back = apply(edited, removeLayer(record, (p) => edited.get(p) ?? null));
    expect(back.get("CLAUDE.md")).toBe("\n## Ours\n\nAdded later.\n");
  });

  it("renders again in place, without a second block, and leaves an entry the target had", () => {
    const first = renderLayer(input(original));
    const onboarded = apply(original, first.files);
    const again = renderLayer(input(onboarded));
    expect(again.files).toEqual(first.files);
    expect(again.record.settings).toEqual([]);
    const withOwn = new Map(original);
    withOwn.set(SETTINGS_FILE, `${JSON.stringify({ enabledPlugins: { [PLUGIN]: false } }, null, 2)}\n`);
    const kept = renderLayer(input(withOwn));
    expect((JSON.parse(kept.files[SETTINGS_FILE] ?? "{}") as { enabledPlugins: Record<string, boolean> }).enabledPlugins[PLUGIN]).toBe(false);
    expect(kept.record.settings).toEqual(["extraKnownMarketplaces.software-factory"]);
  });

  it("moves its own entries to a new release on an update, and still leaves the target's", () => {
    const first = renderLayer(input(original));
    const onboarded = apply(original, first.files);
    const update = (owned?: readonly string[]): Record<string, Record<string, unknown>> => JSON.parse(renderLayer({ ...input(onboarded), release: { repo: "example/factory", tag: "v0.23.0" }, ...(owned === undefined ? {} : { owned }) }).files[SETTINGS_FILE] ?? "{}") as Record<string, Record<string, unknown>>;
    expect(update(first.record.settings)["extraKnownMarketplaces"]).toEqual({ "software-factory": { source: { source: "github", repo: "example/factory", ref: "v0.23.0" } } });
    expect(update()["extraKnownMarketplaces"]).toEqual({ "software-factory": { source: { source: "github", repo: "example/factory", ref: "v0.22.0" } } });
    expect(update(first.record.settings)["enabledPlugins"]).toEqual({ "other@team": true, [PLUGIN]: true });
    expect(renderLayer({ ...input(onboarded), owned: first.record.settings }).record.settings).toEqual(first.record.settings);
  });

  it("refuses a file it would have to guess about", () => {
    const tampered = new Map([["CLAUDE.md", "<!-- BEGIN software-factory -->\nmine\n"]]);
    expect(() => renderLayer(input(tampered))).toThrow(LayerError);
    expect(() => renderLayer(input(new Map([[INVARIANTS_FILE, "# Our rules\n"]])))).toThrow(/is not the factory's/);
    expect(() => renderLayer(input(new Map([[SETTINGS_FILE, "{ not json"]])))).toThrow(/not valid JSON/);
    expect(() => renderLayer({ ...input(original), profile: { ...profile, governance: { approvers: [] } } })).toThrow(/names no governance.approvers/);
  });

  it("writes profile globs as CODEOWNERS patterns", () => {
    expect(codeownersPattern("src/auth/**")).toEqual(["/src/auth/**"]);
    expect(codeownersPattern("**/migrations/**")).toEqual(["**/migrations/**"]);
    expect(codeownersPattern("{api,web}/secrets/**")).toEqual(["/api/secrets/**", "/web/secrets/**"]);
  });
});
