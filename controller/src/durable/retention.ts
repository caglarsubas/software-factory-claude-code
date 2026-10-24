// Retention per profile (ROADMAP P2-11, ADR 0003). A finished task keeps its evidence for the
// shorter of its profile's and the config's `retention_days`, counted from its last activity:
//
// - transcripts: its run's transcripts and its session directory go;
// - bundles: its whole run directory but task.json goes, with its worktree, session directory
//   and eval captures. Its events stay, so its history, metrics, calibration and `status` stay;
// - otel: its exported telemetry goes.
//
// An expiry is recorded first, as an operator's `evidence_expired` command, and then applied:
// the objects only expired scopes name go, by the store's own record, from the home and from the
// replica, and a restore leaves the expired files out. Every recorded expiry is applied again on
// each prune, so one a crash cut short completes. A task that has not finished is never pruned:
// it can still resume. `factoryctl prune` runs this, by hand, while the factory is idle.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runDir, sessionDir, worktreeDir, type Home } from "../home.ts";
import { filterOtel, otelDir } from "../otel/collector.ts";
import { makeWritable } from "../release/install.ts";
import { EventStore, type FactoryEvent } from "../store/events.ts";
import type { Validator } from "../schemas/validate.ts";
import { currentState, isTerminal } from "../task/lifecycle.ts";
import { loadProfile, taskRecord } from "../task/task.ts";
import { deleteObject } from "./objects.ts";
import { EVIDENCE_EXPIRED, expiredObjects, expiredScopes, type ExpiryScope } from "./refs.ts";
import { ReplicaError, readReplicaConfig, syncReplica } from "./replica.ts";

export interface Retention {
  bundles: number;
  transcripts: number;
  otel: number;
}

/** The shorter of the two for each kind: a profile may shorten retention, never lengthen it. */
export function effectiveRetention(profile: Retention | null, config: Retention): Retention {
  if (profile === null) return config;
  return { bundles: Math.min(profile.bundles, config.bundles), transcripts: Math.min(profile.transcripts, config.transcripts), otel: Math.min(profile.otel, config.otel) };
}

export interface Expiry {
  task_id: string;
  scope: ExpiryScope;
  /** Days since the task's last activity, and the retention it passed. */
  age_days: number;
  days: number;
}

export interface RetentionPlan {
  expire: Expiry[];
  /** Tasks whose telemetry is past retention. */
  otel: string[];
  /** Tasks past their bundles' retention that have not finished: listed, never pruned. */
  unfinished: { task_id: string; age_days: number }[];
  /** Tasks whose profile could not be read: the config's retention applies. */
  fallback: string[];
}

const DAY = 86_400_000;

/** Each task's retention from its profile, read once per profile; null when the profile cannot be read. */
export function profilePolicy(home: Home, store: EventStore, validator: Validator): (taskId: string) => Retention | null {
  const byPath = new Map<string, Retention | null>();
  return (id) => {
    const path = taskRecord(home, store, id)?.target.profile;
    if (path === undefined) return null;
    if (!byPath.has(path)) {
      try {
        byPath.set(path, loadProfile(path, validator).retention_days);
      } catch {
        byPath.set(path, null);
      }
    }
    return byPath.get(path) ?? null;
  };
}

const isExpiry = (e: FactoryEvent): boolean => e.type === "command" && e.payload["command"] === EVIDENCE_EXPIRED;

/** A task's last activity: its newest event other than retention's own records. */
const lastActive = (events: readonly FactoryEvent[]): number => events.filter((e) => !isExpiry(e)).reduce((m, e) => Math.max(m, Date.parse(e.ts)), 0);

export function planRetention(o: { store: EventStore; config: Retention; policyFor: (taskId: string) => Retention | null; now: Date }): RetentionPlan {
  const plan: RetentionPlan = { expire: [], otel: [], unfinished: [], fallback: [] };
  for (const id of o.store.taskIds()) {
    const events = o.store.events(id);
    const policy = o.policyFor(id);
    if (policy === null) plan.fallback.push(id);
    const r = effectiveRetention(policy, o.config);
    const age = Math.floor((o.now.getTime() - lastActive(events)) / DAY);
    if (!isTerminal(currentState(events))) {
      if (age >= r.bundles) plan.unfinished.push({ task_id: id, age_days: age });
      continue;
    }
    const scopes = expiredScopes(events);
    if (age >= r.bundles && !scopes.has("bundle")) plan.expire.push({ task_id: id, scope: "bundle", age_days: age, days: r.bundles });
    else if (age >= r.transcripts && scopes.size === 0) plan.expire.push({ task_id: id, scope: "transcripts", age_days: age, days: r.transcripts });
    if (age >= r.otel) plan.otel.push(id);
  }
  return plan;
}

/** What an expired task's scopes take from the home: paths, never its task.json. */
function expiredPaths(home: Home, id: string, scopes: ReadonlySet<ExpiryScope>): string[] {
  const run = runDir(home, id);
  const captured = join(home.root, "evals", "captured");
  if (scopes.has("bundle")) {
    return [
      ...(existsSync(run) ? readdirSync(run).filter((f) => f !== "task.json").map((f) => join(run, f)) : []),
      worktreeDir(home, id),
      sessionDir(home, id),
      ...(existsSync(captured) ? readdirSync(captured).filter((c) => c.startsWith(`${id}-`)).map((c) => join(captured, c)) : []),
    ];
  }
  return scopes.has("transcripts") ? [join(run, "transcripts"), sessionDir(home, id)] : [];
}

/**
 * Applies every expiry a store records: deletes the objects only expired scopes name, and with a
 * home, the paths they cover. Safe to run any number of times.
 */
export function applyExpiries(store: EventStore, objects: string, home?: Home): { objects: number; paths: number } {
  const ids = store.taskIds();
  const byTask = ids.map((id) => store.events(id));
  let deleted = 0;
  for (const d of expiredObjects(byTask, objects)) if (deleteObject(objects, d)) deleted++;
  let paths = 0;
  if (home !== undefined) {
    ids.forEach((id, i) => {
      for (const p of expiredPaths(home, id, expiredScopes(byTask[i] ?? []))) {
        if (!existsSync(p)) continue;
        makeWritable(p);
        rmSync(p, { recursive: true, force: true });
        paths++;
      }
    });
  }
  return { objects: deleted, paths };
}

export interface PruneResult {
  expired: Expiry[];
  objects: number;
  paths: number;
  otel: number;
  /** Objects the replica deleted, or null without a replica. */
  replica: number | null;
}

/** Records the plan's expiries, then applies every recorded expiry in the home and the replica. */
export function prune(o: { home: Home; store: EventStore; plan: RetentionPlan; by: string }): PruneResult {
  const config = readReplicaConfig(o.home);
  // Nothing is recorded while the replica cannot follow: its volume may only be unmounted.
  if (config !== null && !existsSync(config.path)) throw new ReplicaError(`the replica directory ${config.path} is missing; is its volume mounted?`);
  for (const x of o.plan.expire) {
    o.store.append({ task_id: x.task_id, actor: { kind: "operator", id: o.by }, type: "command", payload: { command: EVIDENCE_EXPIRED, scope: x.scope, age_days: x.age_days, days: x.days } });
  }
  const home = applyExpiries(o.store, o.home.objects, o.home);
  const gone = new Set(o.plan.otel);
  const otel = filterOtel(otelDir(o.home.root), (t) => gone.has(t)).removed;
  let replica: number | null = null;
  if (config !== null) {
    syncReplica(o.home);
    const r = EventStore.open(join(config.path, "factory.db"));
    try {
      replica = applyExpiries(r, join(config.path, "objects")).objects;
    } finally {
      r.close();
    }
  }
  return { expired: o.plan.expire, objects: home.objects, paths: home.paths, otel, replica };
}
