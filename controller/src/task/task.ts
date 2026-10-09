// Task creation (factoryctl task create): the text is snapshotted at admission, digested, and
// trust-labelled; the event store records the creation.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { githubRemote } from "../git/repo.ts";
import { runDir, type Home } from "../home.ts";
import { loadYaml } from "../policy/load.ts";
import type { Validator } from "../schemas/validate.ts";
import type { EventStore } from "../store/events.ts";

export interface Profile {
  target: { repo: string; default_branch: string; visibility: string };
  commands: { setup?: string; build?: string; typecheck?: string; lint?: string; test: string };
  gates: { adapters: string[]; sast_rules?: string[] };
  protected_paths: { glob: string; minimum_risk: string; note?: string }[];
  restricted: { glob: string; note?: string }[];
  invariants?: { id: string; text: string; check?: string }[];
  spec_dir: string;
}

export interface Task {
  schema_version: 1;
  id: string;
  created_at: string;
  target: { repo: string; profile: string; base_branch?: string };
  source: { kind: "github_issue" | "manual" | "relay"; ref?: string; admitted_by: string; snapshot_digest?: string };
  text_trust: "untrusted" | "operator";
  title: string;
  priority: "low" | "normal" | "high";
  proposed_tier?: string;
}

export interface CreateTaskInput {
  profilePath: string;
  title: string;
  body: string;
  trust: "untrusted" | "operator";
  admittedBy: string;
  priority?: Task["priority"];
  /** Remote to mirror; defaults to the profile's GitHub repository. */
  remote?: string;
  baseBranch?: string;
  now?: Date;
}

export const sha256 = (data: string | Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

export function loadProfile(path: string, validator: Validator): Profile {
  return loadYaml(path, "profile.schema.json", validator) as Profile;
}

export function createTask(home: Home, store: EventStore, validator: Validator, input: CreateTaskInput): Task {
  const profilePath = resolve(input.profilePath);
  const profile = loadProfile(profilePath, validator);
  const id = store.nextTaskId();
  const dir = runDir(home, id);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = `${input.body.trimEnd()}\n`;
  writeFileSync(join(dir, "task.md"), body, { mode: 0o600 });
  const task: Task = {
    schema_version: 1,
    id,
    created_at: (input.now ?? new Date()).toISOString(),
    target: { repo: profile.target.repo, profile: profilePath, base_branch: input.baseBranch ?? profile.target.default_branch },
    source: { kind: "manual", admitted_by: input.admittedBy, snapshot_digest: sha256(body) },
    text_trust: input.trust,
    title: input.title,
    priority: input.priority ?? "normal",
  };
  const check = validator.validate("task.schema.json", task);
  if (!check.valid) throw new Error(`task.json: ${check.errors.join("; ")}`);
  writeFileSync(join(dir, "task.json"), `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
  store.append({ task_id: id, actor: { kind: "operator", id: input.admittedBy }, type: "task_created", payload: { remote: input.remote ?? githubRemote(profile.target.repo) } });
  return task;
}

export function readTask(home: Home, id: string): Task {
  return JSON.parse(readFileSync(join(runDir(home, id), "task.json"), "utf8")) as Task;
}
