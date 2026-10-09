// format-typecheck (PostToolUse after edits): runs the profile's format and typecheck commands
// (`post_edit` in the guard config) without a shell, and reports failures back to Claude
// (exit 2 shows stderr).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inside, realResolve } from "./lib/paths.ts";
import { block, CONFIG_ENV, loadConfig, readInput } from "./lib/io.ts";

interface PostEditCommand {
  argv: string[];
  append_path: boolean;
  timeout_ms: number;
}

const input = readInput();
const config = loadConfig();
if (config === null) process.exit(0);

const raw = JSON.parse(readFileSync(process.env[CONFIG_ENV] ?? "", "utf8")) as { post_edit?: PostEditCommand[] };
const commands = raw.post_edit ?? [];
const toolInput = input["tool_input"] as Record<string, unknown> | undefined;
const target = toolInput?.["file_path"] ?? toolInput?.["notebook_path"];
const cwd = typeof input["cwd"] === "string" ? input["cwd"] : config.worktree;
const rel = typeof target === "string" ? inside(config.worktree, realResolve(cwd, target)) : null;
if (rel === null || commands.length === 0) process.exit(0);

const failures: string[] = [];
for (const c of commands) {
  const [program, ...args] = c.argv;
  if (program === undefined) continue;
  const result = spawnSync(program, c.append_path ? [...args, rel] : args, {
    cwd: config.worktree,
    encoding: "utf8",
    timeout: c.timeout_ms,
    shell: false,
  });
  if (result.status !== 0) failures.push(`${c.argv.join(" ")} failed:\n${(result.stdout + result.stderr).slice(-2000)}`);
}
if (failures.length > 0) block(failures.join("\n\n"));
process.exit(0);
