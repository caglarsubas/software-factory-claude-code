// manifest.json (ROADMAP §2.5): content digests of every bundle file, the commits judged, the
// factory, policy, CLI and SDK versions, and the resolved model IDs and cost of each stage,
// taken from the event store rather than from anything an agent wrote.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { RiskPolicy } from "../policy/engine.ts";
import type { Release } from "../release.ts";
import type { Validator } from "../schemas/validate.ts";
import type { EventStore } from "../store/events.ts";

/** Not content of the bundle: the manifest itself, derived copies and raw transcripts (kept under their own retention). */
const EXCLUDED = new Set(["manifest.json", "bundle", "transcripts"]);

const digest = (data: Buffer | string): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

function files(root: string, dir: string = root): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const full = join(dir, name);
    if (dir === root && EXCLUDED.has(name)) return [];
    return statSync(full).isDirectory() ? files(root, full) : [relative(root, full)];
  });
}

export interface ManifestInputs {
  dir: string;
  taskId: string;
  store: EventStore;
  validator: Validator;
  release: Release;
  risk: RiskPolicy;
  now?: Date;
}

export function writeManifest(i: ManifestInputs): Record<string, unknown> {
  const build = JSON.parse(readFileSync(join(i.dir, "build.json"), "utf8")) as { base_commit: string; candidate_commit: string };
  const models: { stage: string; alias: string; model_id: string }[] = [];
  const costs = new Map<string, { usd: number; input_tokens: number; output_tokens: number }>();
  for (const e of i.store.events(i.taskId)) {
    if (e.type !== "stage_completed" || typeof e.payload["cost_usd"] !== "number") continue;
    const stage = String(e.payload["stage"]);
    const alias = String(e.payload["alias"]);
    for (const id of (e.payload["models"] as string[] | undefined) ?? []) {
      if (!models.some((m) => m.stage === stage && m.model_id === id)) models.push({ stage, alias, model_id: id });
    }
    const c = costs.get(stage) ?? { usd: 0, input_tokens: 0, output_tokens: 0 };
    c.usd += e.payload["cost_usd"];
    c.input_tokens += Number(e.payload["input_tokens"] ?? 0);
    c.output_tokens += Number(e.payload["output_tokens"] ?? 0);
    costs.set(stage, c);
  }
  const manifest = {
    schema_version: 1,
    task_id: i.taskId,
    created_at: (i.now ?? new Date()).toISOString(),
    reviewed_base_commit: build.base_commit,
    candidate_commit: build.candidate_commit,
    artifacts: files(i.dir).map((path) => ({ path, digest: digest(readFileSync(join(i.dir, path))) })),
    versions: {
      factory: `v${i.release.version}`,
      plugin: i.release.version,
      policy: digest(JSON.stringify(i.risk)),
      claude_code: i.release.config.claude_code.version,
      agent_sdk: i.release.config.claude_code.agent_sdk,
    },
    models,
    costs: [...costs].map(([stage, c]) => ({ stage, usd: Math.round(c.usd * 1e6) / 1e6, input_tokens: c.input_tokens, output_tokens: c.output_tokens })),
  };
  const check = i.validator.validate("manifest.schema.json", manifest);
  if (!check.valid) throw new Error(`manifest.json: ${check.errors.join("; ")}`);
  writeFileSync(join(i.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}
