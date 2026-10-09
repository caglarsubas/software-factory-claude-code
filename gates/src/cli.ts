// gates run: run every gate for a worktree's HEAD and write gates.json.
// gates image: build the gate image if it is missing and print its tag.
//
//   node gates/src/cli.ts run --worktree DIR --base REV --task T-0042 --profile profile.yaml [--out FILE]
//   node gates/src/cli.ts image
//
// Exit 0 when every gate passed, 1 when one did not, 2 when the run itself could not happen.
// FACTORY_GATES_FETCH_NETWORK and FACTORY_GATES_CA_FILE set the network and CA bundle that
// setup and the vulnerability-database refresh use (defaults: "bridge", none).
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { ensureImage } from "./image.ts";
import type { GateProfile } from "./plan.ts";
import { cacheVolumeFor, runGates } from "./run.ts";

const USAGE = [
  "usage: node gates/src/cli.ts run --worktree DIR --base REV --task T-NNNN --profile FILE [--out FILE] [--image TAG] [--cache-volume NAME] [--osv-volume NAME]",
  "       node gates/src/cli.ts image",
].join("\n");

function fail(message: string): never {
  process.stderr.write(`gates: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      worktree: { type: "string" },
      base: { type: "string" },
      task: { type: "string" },
      profile: { type: "string" },
      out: { type: "string" },
      image: { type: "string" },
      "cache-volume": { type: "string" },
      "osv-volume": { type: "string" },
    },
  });
  if (positionals[0] === "image" && positionals.length === 1) {
    process.stdout.write(`${ensureImage()}\n`);
    return;
  }
  if (positionals[0] !== "run" || positionals.length !== 1) fail(USAGE);
  const { worktree, base, task, profile: profilePath } = values;
  if (worktree === undefined || base === undefined || task === undefined || profilePath === undefined) fail(USAGE);
  if (!/^T-[0-9]{4,}$/.test(task)) fail(`task id ${task} does not match T-NNNN`);

  const profile = parse(readFileSync(profilePath, "utf8")) as GateProfile & { target?: { repo?: string } };
  if (typeof profile.commands.test !== "string" || !Array.isArray(profile.gates.adapters)) fail(`${profilePath} is not a target profile`);

  const result = await runGates({
    worktree,
    base,
    taskId: task,
    profile,
    image: values.image ?? ensureImage(),
    cacheVolume: values["cache-volume"] ?? cacheVolumeFor(profile.target?.repo ?? "unknown"),
    osvVolume: values["osv-volume"] ?? "sf-gates-osv",
    fetchNetwork: process.env["FACTORY_GATES_FETCH_NETWORK"] ?? "bridge",
    ...(process.env["FACTORY_GATES_CA_FILE"] === undefined ? {} : { caFile: process.env["FACTORY_GATES_CA_FILE"] }),
    log: (line) => process.stderr.write(`gates: ${line}\n`),
  });

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out === undefined) process.stdout.write(json);
  else writeFileSync(values.out, json);
  for (const g of result.gates) process.stderr.write(`gates: ${g.status.padEnd(7)} ${g.name}: ${g.summary.split("\n")[0] ?? ""}\n`);
  process.exit(result.passed ? 0 : 1);
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e));
});
