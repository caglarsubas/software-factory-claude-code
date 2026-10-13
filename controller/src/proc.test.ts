// Process identity, the session spawner's registry and reaping (P1-02).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { factoryHome } from "./home.ts";
import { children, isLive, reap, self, sessionSpawner, startTime } from "./proc.ts";

const scratch = mkdtempSync(join(tmpdir(), "proc-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const SLEEP = ["--eval", "setInterval(() => undefined, 1 << 30)"];
/** A process that has exited: its pid, and the start time it had. */
function deadProcess(): { pid: number; start_time: string } {
  const r = spawnSync(process.execPath, ["--eval", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return { pid: Number(r.stdout), start_time: "gone" };
}
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
};

describe("process identity", () => {
  it("names a process by its pid and start time, so a reused pid is not mistaken for it", () => {
    const me = self();
    expect(me.start_time).not.toBeNull();
    expect(isLive(me)).toBe(true);
    expect(isLive({ pid: process.pid, start_time: "not when it started" })).toBe(false);
    expect(isLive({ pid: process.pid, start_time: null })).toBe(true);
    expect(isLive(deadProcess())).toBe(false);
    expect(startTime(-1)).toBeNull();
  });
});

describe("the session spawner and reaping", () => {
  it("runs a session in its own process group, registered until it exits", async () => {
    const home = factoryHome({ FACTORY_HOME: join(scratch, "spawner") });
    const abort = new AbortController();
    const child = sessionSpawner(home, "T-0001", "build")({ command: process.execPath, args: SLEEP, env: { PATH: process.env["PATH"] ?? "" }, signal: abort.signal });
    const entries = children(home);
    expect(entries).toEqual([expect.objectContaining({ task_id: "T-0001", label: "build", owner: self() })]);
    const pid = entries[0]?.pid ?? 0;
    // Its own group: the leader's pgid is its pid.
    expect(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()).toBe(String(pid));
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    abort.abort();
    await exited;
    expect(children(home)).toEqual([]);
  });

  it("reaps the groups of a run that died, and leaves a live run's alone", async () => {
    const home = factoryHome({ FACTORY_HOME: join(scratch, "reap") });
    mkdirSync(join(home.root, "procs"), { recursive: true });
    const orphan = spawn(process.execPath, SLEEP, { detached: true, stdio: "ignore" });
    const kept = spawn(process.execPath, SLEEP, { detached: true, stdio: "ignore" });
    const ref = (pid: number | undefined) => ({ pid: pid ?? 0, start_time: startTime(pid ?? 0) });
    await until(() => startTime(orphan.pid ?? 0) !== null && startTime(kept.pid ?? 0) !== null);
    writeFileSync(join(home.root, "procs", `${String(orphan.pid)}.json`), JSON.stringify({ ...ref(orphan.pid), task_id: "T-0001", label: "review-code", owner: deadProcess() }));
    writeFileSync(join(home.root, "procs", `${String(kept.pid)}.json`), JSON.stringify({ ...ref(kept.pid), task_id: "T-0002", label: "build", owner: self() }));
    // An entry whose process already ended is just removed.
    writeFileSync(join(home.root, "procs", "4194302.json"), JSON.stringify({ pid: 4194302, start_time: "1", task_id: "T-0003", label: "spec", owner: deadProcess() }));
    try {
      expect(reap(home).map((c) => c.label)).toEqual(["review-code"]);
      await until(() => startTime(orphan.pid ?? 0) === null);
      expect(startTime(orphan.pid ?? 0)).toBeNull();
      expect(startTime(kept.pid ?? 0)).not.toBeNull();
      expect(children(home).map((c) => c.label)).toEqual(["build"]);
    } finally {
      orphan.kill("SIGKILL");
      kept.kill("SIGKILL");
    }
  });
});
