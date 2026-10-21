import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureHome, factoryHome, sessionDir } from "../home.ts";
import { loadRelease } from "../release.ts";
import { createValidator } from "../schemas/validate.ts";
import { foreignMods, prepareSession, sessionSandbox, type StageSpec } from "./options.ts";

const root = mkdtempSync(join(tmpdir(), "session-options-"));
const home = factoryHome({ FACTORY_HOME: join(root, "home") });
ensureHome(home);
const validator = createValidator();
const release = loadRelease(validator);
const inputs = { home, taskId: "T-0001", release, validator, keyFile: join(root, "no-key") };
const spec: StageSpec = {
  stage: "build", agent: "builder", label: "build", cwd: join(root, "wt"),
  prompt: "Build it.",
  extraDirs: [],
  guard: { worktree: join(root, "wt"), task_dir: join(root, "task"), protected_paths: [], scope: null, writable_task_files: [], secret_paths: [], readable_roots: [] },
  budgetUsd: 1,
};

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("where Claude Code loads plugins and mods from (Claude Code 2.1.286 and later)", () => {
  it("keeps a session's sandboxed commands from writing there", () => {
    const dir = sessionDir(home, "T-0001");
    expect(sessionSandbox(inputs).filesystem?.denyWrite).toEqual([".claude/**", join(dir, "claude"), join(dir, "home", ".claude"), release.pluginDir]);
  });

  it("refuses to start a session whose config directory holds a mod the factory did not write", () => {
    expect(prepareSession(inputs, spec).env.CLAUDE_CONFIG_DIR).toBe(join(sessionDir(home, "T-0001"), "claude"));
    const configDir = join(sessionDir(home, "T-0001"), "claude");
    expect(foreignMods(configDir)).toEqual([]);
    const mod = join(configDir, "dev-mods", "5f0c2a8e-7d4b-4c1a-9e3f-0a1b2c3d4e5f", "m", "hooks");
    mkdirSync(mod, { recursive: true });
    writeFileSync(join(mod, "register.js"), "export function register() {}\n");
    expect(foreignMods(configDir)).toContain(join(mod, "register.js"));
    expect(() => prepareSession(inputs, spec)).toThrow(/build: the session's config directory holds mods the factory did not write/);
  });
});
