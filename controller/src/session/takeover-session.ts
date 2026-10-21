// The interactive session `factoryctl takeover` opens (ROADMAP P1-04, §2.6): the operator's own
// Claude Code, in the task's worktree, resuming its build session when there is a live one. It
// runs under the same walls as the build session (the release's plugin and guard, the sandbox,
// the deny rules, an allowlisted env with no credential in it, the task's own config directory),
// in auto mode rather than dontAsk, because a person is at the keyboard. Never bypassPermissions.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDir, type Home } from "../home.ts";
import type { Release } from "../release.ts";
import type { Validator } from "../schemas/validate.ts";
import { sessionEnv } from "./env.ts";
import { foreignMods, sessionSandbox, sessionSettings } from "./options.ts";

export interface TakeoverInputs {
  home: Home;
  taskId: string;
  release: Release;
  validator: Validator;
  keyFile: string;
  worktree: string;
  /** Where the guard lets the session write task files (none) and keep its notes. */
  taskDir: string;
  protectedPaths: string[];
  scope: { include: string[]; exclude: string[] };
  /** The live build session to resume, or null for a new session. */
  sessionId: string | null;
  /** The Claude Code binary (FACTORY_CLAUDE_BIN, default `claude`). */
  bin: string;
  term?: string;
}

export interface TakeoverLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  settingsPath: string;
  guardConfigPath: string;
}

export function takeoverLaunch(i: TakeoverInputs): TakeoverLaunch {
  const { release } = i;
  const dir = sessionDir(i.home, i.taskId);
  for (const d of ["home", "claude", "tmp"]) mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });
  // A takeover resumes the build session, with its id and config directory, where Claude Code
  // would load a mod that session left in dev-mods (options.ts, foreignMods).
  const mods = foreignMods(join(dir, "claude"));
  if (mods.length > 0) throw new Error(`takeover: the session's config directory holds mods the factory did not write; inspect and remove them first: ${mods.join(", ")}`);
  mkdirSync(i.taskDir, { recursive: true, mode: 0o700 });
  const tools = release.tools.agents["builder"];
  if (tools === undefined) throw new Error("policies/tools.yaml has no entry for builder");
  const guard = {
    schema_version: 1,
    task_id: i.taskId,
    stage: "build",
    worktree: i.worktree,
    task_dir: i.taskDir,
    protected_paths: i.protectedPaths,
    scope: i.scope,
    writable_task_files: [],
    secret_paths: [],
    readable_roots: [join(release.pluginDir, "rubrics")],
    allowed_tools: tools.allow,
    post_edit: [],
  };
  const check = i.validator.validate("guard-config.schema.json", guard);
  if (!check.valid) throw new Error(`takeover guard config: ${check.errors.join("; ")}`);
  const guardConfigPath = join(dir, "takeover.guard.json");
  writeFileSync(guardConfigPath, `${JSON.stringify(guard, null, 2)}\n`, { mode: 0o600 });

  const sessionInputs = { home: i.home, taskId: i.taskId, release, validator: i.validator, keyFile: i.keyFile };
  const settings = sessionSettings(sessionInputs, release);
  const flags = { ...settings, permissions: { ...settings.permissions, defaultMode: "auto" }, sandbox: sessionSandbox(sessionInputs) };
  const settingsPath = join(dir, "takeover.settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(flags, null, 2)}\n`, { mode: 0o600 });

  const model = release.config.model_pins[release.config.routing["builder"]?.model ?? ""];
  const env: Record<string, string> = {
    ...sessionEnv({ home: join(dir, "home"), configDir: join(dir, "claude"), tmpDir: join(dir, "tmp"), guardConfig: guardConfigPath, modelPins: release.config.model_pins }),
    // A person is at this terminal.
    TERM: i.term ?? "xterm-256color",
  };
  const args = [
    ...(i.sessionId === null ? [] : ["--resume", i.sessionId]),
    "--permission-mode", "auto",
    "--settings", settingsPath,
    "--setting-sources", "",
    "--strict-mcp-config",
    "--plugin-dir", release.pluginDir,
    ...(model === undefined ? [] : ["--model", model]),
  ];
  return { command: i.bin, args, cwd: i.worktree, env, settingsPath, guardConfigPath };
}

/** The binary's version line must name the pinned Claude Code. */
export const versionMatches = (versionOutput: string, pinned: string): boolean => versionOutput.trim().split(/\s+/)[0] === pinned;
