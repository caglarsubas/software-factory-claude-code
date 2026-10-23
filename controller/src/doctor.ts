// factoryctl doctor: check the pins, the credential hygiene and the host prerequisites a run
// needs (ROADMAP §3.2, G0-4). Every check reports; any failure makes the command exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_PERMISSIONS, appConfig, appInfo, appTokens, permissionDiff, readAppKey, type AppConfig } from "./github/app.ts";
import { pendingJournals } from "./durable/purge.ts";
import { replicaStatus } from "./durable/replica.ts";
import { planRetention, profilePolicy } from "./durable/retention.ts";
import { describeHalt, readHalt } from "./halt.ts";
import type { Home } from "./home.ts";
import type { Release } from "./release.ts";
import { checkReleaseFiles } from "./release/install.ts";
import { footprintRulesets } from "./governance/footprint.ts";
import { appAccess, installationSettings } from "./target/github.ts";
import { listTargets, profileDigest } from "./target/registry.ts";
import type { Validator } from "./schemas/validate.ts";
import { managedSettingsJson } from "./runner/managed.ts";
import { createValidator } from "./schemas/validate.ts";
import { EventStore } from "./store/events.ts";
import { describeAlarm, telemetryConfig, TelemetryError, type ModelAlarm } from "./telemetry.ts";

const ALARM_DAYS = 30;

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const which = (cmd: string): boolean => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;

export function doctor(home: Home, release: Release, keyFile: string, env: NodeJS.ProcessEnv = process.env): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, severity: "warn" | "fail" = "fail"): void => {
    checks.push({ name, status: ok ? "ok" : severity, detail });
  };

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major === 24, `Node ${process.versions.node} (the factory pins Node 24 LTS)`);

  const pins = release.config.claude_code;
  try {
    // The package exports no ./package.json; it sits next to the entry point.
    const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version: string; claudeCodeVersion?: string };
    add("agent sdk pin", pkg.version === pins.agent_sdk, `installed ${pkg.version}, pinned ${pins.agent_sdk}`);
    add("claude code pin", pkg.claudeCodeVersion === pins.version, `the SDK runs Claude Code ${pkg.claudeCodeVersion ?? "?"}, pinned ${pins.version}`);
  } catch {
    add("agent sdk pin", false, "@anthropic-ai/claude-agent-sdk is not installed");
  }

  add("ANTHROPIC_API_KEY unset", env["ANTHROPIC_API_KEY"] === undefined, "sessions authenticate through apiKeyHelper; a key in the environment overrides it");
  for (const v of ["SSH_AUTH_SOCK", "GIT_ASKPASS"]) add(`${v} unset`, env[v] === undefined, "never passed to sessions, but better unset where factoryctl runs", "warn");
  const keyOk = existsSync(keyFile) && (statSync(keyFile).mode & 0o077) === 0;
  add("api key file", keyOk, existsSync(keyFile) ? `${keyFile} must be readable by you only (chmod 600)` : `create ${keyFile} (chmod 600) holding the Console key`);
  add("factory home", existsSync(home.root) && (statSync(home.root).mode & 0o077) === 0, `${home.root} must exist and be private (chmod 700)`);
  let appSet = false;
  try {
    appSet = appConfig(home, env) !== null;
  } catch {
    // appCheck reports it.
  }
  add("github token", appSet || env["FACTORY_GITHUB_TOKEN"] !== undefined, appSet ? "the factory App pushes, opens PRs and posts verdicts; FACTORY_GITHUB_TOKEN is not needed for runs" : "FACTORY_GITHUB_TOKEN pushes branches and opens PRs; without it a run stops after pushing nothing", "warn");

  add("git", which("git"), "git is required");
  const docker = spawnSync(process.env["FACTORY_CONTAINER_ENGINE"] ?? "docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  add("container engine", docker.status === 0, docker.status === 0 ? `server ${docker.stdout.trim()}` : "Docker or Podman must be running for the gates");
  if (process.platform === "linux") {
    add("sandbox (bubblewrap, socat)", which("bwrap") && which("socat"), "Claude Code's Bash sandbox on Linux needs bwrap and socat; sessions require it (failIfUnavailable)");
  } else if (process.platform === "darwin") {
    add("sandbox (seatbelt)", which("sandbox-exec"), "Claude Code's Bash sandbox on macOS uses sandbox-exec");
  } else {
    add("platform", false, `${process.platform} is unsupported: native Windows runs unsandboxed`);
  }
  add("release", existsSync(release.pluginDir) && existsSync(release.gatesCli), `plugin ${release.version} at ${release.root}`);
  if (release.info === null) {
    add("installed release", false, "running from a development checkout: install a release (factoryctl release install vX.Y.Z) and run $FACTORY_HOME/bin/factoryctl", "warn");
  } else {
    const v = checkReleaseFiles(release.root, release.info);
    add("installed release", v.ok, `${release.info.tag} (${release.info.sha.slice(0, 12)}): ${v.detail}`);
  }
  const halt = readHalt(home);
  // Durability (P2-07): a replica, ideally on another volume, and caught up.
  try {
    const r = replicaStatus(home);
    if (r === null) add("replica", false, "none set: factoryctl replica init DIR, on another volume (G2-6 drills restore from it)", "warn");
    else add("replica", !r.sameVolume && r.lag_events === 0, `${r.config.path}${r.sameVolume ? ", on the same volume as the home" : ""}; ${String(r.lag_events)} event(s) behind${r.state === null ? ", never synced" : `, synced ${r.state.synced_at}`}`, "warn");
  } catch (e) {
    add("replica", false, `unreadable: ${e instanceof Error ? e.message : String(e)}`, "warn");
  }
  add("kill switch", halt === null, halt === null ? "not engaged" : `${describeHalt(halt)}; lift with factoryctl unhalt --reason "…"`, "warn");
  try {
    const t = telemetryConfig(env);
    const own = env["FACTORY_OTEL"] === "off" ? "off (FACTORY_OTEL=off): G2-5's audit and the SLO panels lose the sessions' telemetry" : `each live run's own collector, into ${join(home.root, "otel")}`;
    add("telemetry", env["FACTORY_OTEL"] !== "off" || t !== null, t === null ? own : `OTLP ${t.protocol} to ${t.endpoint}`, "warn");
  } catch (e) {
    add("telemetry", false, e instanceof TelemetryError ? e.message : String(e));
  }
  if (existsSync(home.db)) {
    // The alias alarm (P1-06): a model ID that drifted from its pin shows here until it is a month old.
    const since = new Date(Date.now() - ALARM_DAYS * 86_400_000).toISOString();
    const store = EventStore.open(home.db);
    const alarms = store.allEvents().filter((e) => e.type === "alarm" && e.ts >= since);
    // Retention (ADR 0003): what `factoryctl prune` would expire now, and what stays because it has not finished.
    const plan = planRetention({ store, config: release.config.retention_days, policyFor: profilePolicy(home, store, createValidator()), now: new Date() });
    store.close();
    const past = plan.expire.length + plan.unfinished.length;
    add("retention", past === 0, past === 0 ? "nothing past retention" : `${String(plan.expire.length)} finished task(s) past retention: factoryctl prune${plan.unfinished.length === 0 ? "" : `; ${String(plan.unfinished.length)} unfinished, past it: cancel or resume them`}`, "warn");
    const latest = alarms.reduce<(typeof alarms)[number] | undefined>((a, e) => (a === undefined || e.ts > a.ts ? e : a), undefined);
    add("model alarms", latest === undefined, latest === undefined ? `no alias alarm in ${String(ALARM_DAYS)} days` : `${String(alarms.length)} alias alarm(s) in ${String(ALARM_DAYS)} days; latest ${latest.task_id} ${String(latest.payload["label"])}: ${describeAlarm(latest.payload as unknown as ModelAlarm)}`, "warn");
  }
  const purges = pendingJournals(home);
  add("purges", purges.length === 0, purges.length === 0 ? "no purge left unfinished" : `${String(purges.length)} purge(s) stopped part-way (${purges.map((j) => j.id).join(", ")}): factoryctl prune finishes them`, "warn");
  // Managed settings (P2-08): the runner's file must be what this release's policies generate, so the image enforces this release.
  try {
    const shipped = readFileSync(join(release.root, "runner/managed-settings.json"), "utf8");
    add("managed settings", shipped === managedSettingsJson(release), shipped === managedSettingsJson(release) ? "runner/managed-settings.json matches the release's policies and config" : "runner/managed-settings.json differs from what this release's policies generate: regenerate it (pnpm exec node controller/src/runner/generate.ts) and cut a release");
  } catch {
    add("managed settings", false, "runner/managed-settings.json is missing from the release");
  }
  return checks;
}

interface Ruleset {
  name: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  bypass_actors?: { actor_id?: number | null; actor_type?: string }[];
  rules?: { type: string; parameters?: Record<string, unknown> }[];
}

/** What differs between the ruleset a repository should have and the one GitHub enforces; empty when none. */
export function rulesetDiff(expected: Ruleset, actual: Ruleset): string[] {
  const diffs: string[] = [];
  for (const k of ["target", "enforcement"] as const) if (expected[k] !== actual[k]) diffs.push(`${k} is ${String(actual[k])}, expected ${String(expected[k])}`);
  const refs = (r: Ruleset): string => JSON.stringify({ include: [...(r.conditions?.ref_name?.include ?? [])].sort(), exclude: [...(r.conditions?.ref_name?.exclude ?? [])].sort() });
  if (refs(expected) !== refs(actual)) diffs.push(`branches ${refs(actual)}, expected ${refs(expected)}`);
  const bypass = (r: Ruleset): string => JSON.stringify((r.bypass_actors ?? []).map((b) => `${b.actor_type ?? "?"}:${String(b.actor_id ?? "")}`).sort());
  if (bypass(expected) !== bypass(actual)) diffs.push(`bypass actors ${bypass(actual)}, expected ${bypass(expected)}`);
  const actualRules = new Map((actual.rules ?? []).map((r) => [r.type, r.parameters ?? {}]));
  for (const rule of expected.rules ?? []) {
    const got = actualRules.get(rule.type);
    if (got === undefined) {
      diffs.push(`rule ${rule.type} is missing`);
      continue;
    }
    for (const [k, v] of Object.entries(rule.parameters ?? {})) {
      // GitHub leaves a boolean parameter out when it is false, its default.
      if (v === false && got[k] === undefined) continue;
      if (JSON.stringify(got[k]) !== JSON.stringify(v)) diffs.push(`${rule.type}.${k} is ${JSON.stringify(got[k])}, expected ${JSON.stringify(v)}`);
    }
    actualRules.delete(rule.type);
  }
  for (const extra of actualRules.keys()) diffs.push(`rule ${extra} is not in the expected ruleset`);
  return diffs;
}

/**
 * The repository ruleset check (P2-08): this repository's default-branch ruleset on GitHub
 * against `.github/rulesets/main.json` in the release. Needs a token that may read rulesets; the
 * target repositories' rulesets and the App's permissions join it with P2-05's governance wiring.
 */
export async function rulesetCheck(o: { repo: string; expected: Ruleset; token: string; api: string; fetchFn?: typeof fetch; hint?: string }): Promise<Check> {
  const call = async (path: string): Promise<{ status: number; body: unknown }> => {
    const r = await (o.fetchFn ?? fetch)(`${o.api}${path}`, { headers: { authorization: `Bearer ${o.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, redirect: "error" });
    return { status: r.status, body: r.ok ? ((await r.json())) : null };
  };
  const name = `ruleset ${o.repo}${o.expected.name === "main" ? "" : ` ${o.expected.name}`}`;
  try {
    const list = await call(`/repos/${o.repo}/rulesets`);
    if (list.status === 403 || list.status === 404) return { name, status: "warn", detail: `the token cannot read ${o.repo}'s rulesets (it needs Administration: read)` };
    if (list.status !== 200) return { name, status: "warn", detail: `GitHub answered ${String(list.status)}` };
    const found = (list.body as { id: number; name: string }[]).find((r) => r.name === o.expected.name);
    if (found === undefined) return { name, status: "fail", detail: `no ruleset named ${o.expected.name}: ${o.hint ?? "import .github/rulesets/main.json"}` };
    const full = await call(`/repos/${o.repo}/rulesets/${String(found.id)}`);
    if (full.status !== 200) return { name, status: "warn", detail: `GitHub answered ${String(full.status)} for ruleset ${String(found.id)}` };
    const diffs = rulesetDiff(o.expected, full.body as Ruleset);
    return diffs.length === 0 ? { name, status: "ok", detail: `${o.expected.name} matches ${o.hint === undefined ? ".github/rulesets/main.json" : "the release's footprint"}` } : { name, status: "fail", detail: diffs.join("; ") };
  } catch (e) {
    return { name, status: "warn", detail: `could not reach GitHub: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Each onboarded target (P2-11): where its onboarding stands, its profile against the one the
 * operator confirmed, and once it is active, its footprint rulesets and the App's access to it.
 * `factoryctl onboard OWNER/NAME` takes a target further, or repairs what drifted.
 */
export async function targetChecks(o: { home: Home; validator: Validator; token: string | null; api: string; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch }): Promise<Check[]> {
  let targets;
  try {
    targets = listTargets(o.home, o.validator);
  } catch (e) {
    return [{ name: "targets", status: "fail", detail: e instanceof Error ? e.message : String(e) }];
  }
  let app: AppConfig | null = null;
  try {
    app = appConfig(o.home, o.env ?? process.env);
  } catch {
    // appCheck reports it.
  }
  const checks: Check[] = [];
  for (const t of targets) {
    const name = `target ${t.repo}`;
    const again = `factoryctl onboard ${t.repo}`;
    if (t.state === "offboarding") {
      checks.push({ name, status: "warn", detail: `offboarding${t.offboard?.pr === undefined ? "" : ` (${t.offboard.pr.url})`}: factoryctl offboard ${t.repo} takes it further` });
      continue;
    }
    if (t.state !== "active") {
      checks.push({ name, status: "warn", detail: `${t.state}${t.pr === undefined ? "" : ` (${t.pr.url})`}: ${again} takes it further` });
      continue;
    }
    let digest: string;
    try {
      digest = profileDigest(o.home, t.repo);
    } catch (e) {
      checks.push({ name, status: "fail", detail: `its profile is unreadable: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const drift = t.confirmed?.profile_digest !== digest;
    checks.push({ name, status: drift ? "warn" : "ok", detail: drift ? `its profile changed since it was confirmed, so task create and intake refuse it: ${again} --update proposes the change` : `active on ${t.confirmed?.release.tag ?? "?"} since ${t.active?.at ?? "?"}` });
    const fetchFn = o.fetchFn === undefined ? {} : { fetchFn: o.fetchFn };
    if (o.token !== null) for (const r of footprintRulesets()) checks.push(await rulesetCheck({ repo: t.repo, expected: r, token: o.token, api: o.api, hint: again, ...fetchFn }));
    if (app !== null) {
      try {
        const access = await appAccess({ app, api: o.api, repo: t.repo, ...fetchFn });
        checks.push({ name: `${name} app`, status: access.installed ? "ok" : "fail", detail: access.installed ? access.detail : `${access.detail}: add it at ${installationSettings(app)}, then ${again}` });
      } catch (e) {
        checks.push({ name: `${name} app`, status: "warn", detail: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return checks;
}

/**
 * The factory App (P2-05): its IDs and key, the App GitHub knows by that key, its permissions
 * against exactly what it needs (more is as wrong as less), and an installation token minted.
 */
export async function appCheck(o: { home: Home; env?: NodeJS.ProcessEnv; api: string; fetchFn?: typeof fetch }): Promise<Check[]> {
  const name = "github app";
  let app: AppConfig | null;
  try {
    app = appConfig(o.home, o.env ?? process.env);
  } catch (e) {
    return [{ name, status: "fail", detail: e instanceof Error ? e.message : String(e) }];
  }
  if (app === null) return [{ name, status: "warn", detail: "not set: factoryctl app init --app-id N --installation-id N (verdicts and R0–R1 merges need it)" }];
  try {
    readAppKey(app.keyFile);
  } catch (e) {
    return [{ name, status: "fail", detail: e instanceof Error ? e.message : String(e) }];
  }
  const ctx = { app, api: o.api, ...(o.fetchFn === undefined ? {} : { fetchFn: o.fetchFn }) };
  try {
    const info = await appInfo(ctx);
    const checks: Check[] = [];
    checks.push(info.id === app.appId ? { name, status: "ok", detail: `${info.slug} (app ${String(info.id)}), key ${app.keyFile}` } : { name, status: "fail", detail: `the key belongs to app ${String(info.id)}, not ${String(app.appId)}` });
    const diffs = permissionDiff(info.permissions);
    checks.push({ name: "github app permissions", status: diffs.length === 0 ? "ok" : "fail", detail: diffs.length === 0 ? Object.entries(APP_PERMISSIONS).map(([k, v]) => `${k}: ${v}`).join(", ") : diffs.join("; ") });
    await appTokens(ctx).refresh();
    checks.push({ name: "github app installation", status: "ok", detail: `installation ${String(app.installationId)}: a token was minted` });
    return checks;
  } catch (e) {
    return [{ name, status: "fail", detail: `GitHub refused the App: ${e instanceof Error ? e.message : String(e)}` }];
  }
}
