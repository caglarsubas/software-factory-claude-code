// What each judgment stage returns. The model-facing schema is the artifact schema minus the
// fields factoryctl owns (IDs, commits, tier), with shared definitions inlined, because
// structured output takes one self-contained schema. factoryctl adds its fields back and
// validates the artifact against the full schema before writing it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR } from "../schemas/validate.ts";

type Json = Record<string, unknown>;

const load = (file: string): Json => JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as Json;

function inline(node: unknown, defs: Json): unknown {
  if (Array.isArray(node)) return node.map((n) => inline(n, defs));
  if (typeof node !== "object" || node === null) return node;
  const obj = node as Json;
  const ref = obj["$ref"];
  if (typeof ref === "string") {
    const target = ref.startsWith("defs.schema.json#/$defs/") ? defs[ref.slice("defs.schema.json#/$defs/".length)] : ref.endsWith(".schema.json") ? strip(load(ref)) : undefined;
    if (target === undefined) throw new Error(`cannot inline ${ref}`);
    return inline(target, defs);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, inline(v, defs)]));
}

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description"]);

function strip(schema: Json): Json {
  return Object.fromEntries(Object.entries(schema).filter(([k]) => !ANNOTATIONS.has(k)));
}

/** The artifact schema without `omit`, plus `extra` properties (all required), inlined. */
export function modelSchema(artifact: string, omit: readonly string[], extra: Record<string, Json> = {}): Json {
  const defs = (load("defs.schema.json")["$defs"] ?? {}) as Json;
  const schema = strip(load(artifact));
  const properties = Object.fromEntries(Object.entries(schema["properties"] as Json).filter(([k]) => !omit.includes(k)));
  const required = (schema["required"] as string[]).filter((k) => !omit.includes(k));
  return inline({ ...schema, properties: { ...properties, ...extra }, required: [...required, ...Object.keys(extra)] }, defs) as Json;
}

export const OUTPUTS = {
  triage: () => modelSchema("triage.schema.json", ["schema_version", "task_id"]),
  spec: () => modelSchema("spec.schema.json", ["schema_version", "id"], { markdown: { type: "string", minLength: 1, description: "The spec as readable Markdown for humans (spec.md)." } }),
  review: () => modelSchema("review.schema.json", ["schema_version", "task_id", "reviewer", "model", "candidate_commit"]),
  verdict: () => modelSchema("verdict.schema.json", ["schema_version", "task_id", "candidate_commit", "tier"]),
  summary: () => modelSchema("summary.schema.json", ["schema_version", "task_id"]),
} as const;
