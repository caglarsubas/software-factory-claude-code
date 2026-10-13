// The artifact commit protocol (P1-02): a crash at any instant leaves a step committed or not.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sha256, writeAtomic } from "../fsutil.ts";
import { acquireRunLock, factoryHome, LockError, readLock } from "../home.ts";
import { EventStore } from "../store/events.ts";
import { commitArtifacts, freshness, inputDigest, inputsOf, latestCommit, recover, specDigest } from "./commit.ts";

const scratch = mkdtempSync(join(tmpdir(), "commit-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let n = 0;
function world(): { dir: string; store: EventStore } {
  const root = join(scratch, `w${String(++n)}`);
  const dir = join(root, "run");
  mkdirSync(dir, { recursive: true });
  const store = EventStore.open(join(root, "factory.db"));
  store.append({ task_id: "T-0001", actor: { kind: "operator", id: "op" }, type: "task_created", payload: {} });
  writeFileSync(join(dir, "task.md"), "Do the thing.\n");
  return { dir, store };
}

const step = { taskId: "T-0001", stage: "triage", label: "triage", round: 1 };

describe("writeAtomic", () => {
  it("replaces a file whole and leaves no temporary file", () => {
    const { dir } = world();
    writeAtomic(join(dir, "a.json"), "one\n");
    writeAtomic(join(dir, "a.json"), "two\n");
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe("two\n");
    expect(readdirSync(dir).sort()).toEqual(["a.json", "task.md"]);
  });
});

describe("commitArtifacts and freshness", () => {
  it("commits staged files with their digests and the step's input digests, then moves them into place", () => {
    const { dir, store } = world();
    const inputs = inputsOf(dir, ["task.md"]);
    expect(freshness(dir, store.events("T-0001"), "triage", inputs)).toBe("never");
    const c = commitArtifacts(store, dir, step, inputs, [{ path: "triage.json", content: '{"kind":"docs"}\n' }]);
    expect(c).toMatchObject({ label: "triage", round: 1, attempt: 1, input_digest: inputDigest(inputs), inputs: { "task.md": sha256("Do the thing.\n") } });
    expect(c.artifacts).toEqual([{ path: "triage.json", digest: sha256('{"kind":"docs"}\n') }]);
    expect(readdirSync(dir).sort()).toEqual(["task.md", "triage.json"]);
    expect(freshness(dir, store.events("T-0001"), "triage", inputs)).toBe("done");
    // The event validates against event.schema.json: the store refuses anything else.
    expect(store.events("T-0001").at(-1)?.type).toBe("artifact_committed");
  });

  it("is stale when an input changed or a committed file changed or vanished, and counts attempts", () => {
    const { dir, store } = world();
    commitArtifacts(store, dir, step, inputsOf(dir, ["task.md"]), [{ path: "triage.json", content: "a\n" }]);
    writeFileSync(join(dir, "task.md"), "Do another thing.\n");
    expect(freshness(dir, store.events("T-0001"), "triage", inputsOf(dir, ["task.md"]))).toBe("inputs_changed");
    const c = commitArtifacts(store, dir, step, inputsOf(dir, ["task.md"]), [{ path: "triage.json", content: "b\n" }]);
    expect(c.attempt).toBe(2);
    expect(latestCommit(store.events("T-0001"), "triage")?.artifacts[0]?.digest).toBe(sha256("b\n"));
    writeFileSync(join(dir, "triage.json"), "tampered\n");
    expect(freshness(dir, store.events("T-0001"), "triage", inputsOf(dir, ["task.md"]))).toBe("artifact_changed");
    rmSync(join(dir, "triage.json"));
    expect(freshness(dir, store.events("T-0001"), "triage", inputsOf(dir, ["task.md"]))).toBe("artifact_changed");
    // A missing input never matches a commit made from a present one.
    expect(inputsOf(dir, ["nope.json"])).toEqual({ "nope.json": "missing" });
  });
});

describe("recover", () => {
  it("rolls a committed .pending forward: the crash came after the commit point", () => {
    const { dir, store } = world();
    // What a crash between the event and the rename leaves: the commit, and the file still staged.
    commitArtifacts(store, dir, step, inputsOf(dir, ["task.md"]), [{ path: "triage.json", content: "a\n" }]);
    writeFileSync(join(dir, "triage.json.pending"), "b\n");
    rmSync(join(dir, "triage.json"));
    store.append({ task_id: "T-0001", actor: { kind: "factoryctl", id: "factoryctl" }, type: "artifact_committed", payload: { stage: "triage", label: "triage", round: 1, attempt: 2, input_digest: inputDigest(inputsOf(dir, ["task.md"])), inputs: inputsOf(dir, ["task.md"]), artifacts: [{ path: "triage.json", digest: sha256("b\n") }] } });
    expect(recover(dir, store.events("T-0001"))).toEqual({ rolledForward: ["triage.json"], removed: [] });
    expect(readFileSync(join(dir, "triage.json"), "utf8")).toBe("b\n");
    expect(freshness(dir, store.events("T-0001"), "triage", inputsOf(dir, ["task.md"]))).toBe("done");
  });

  it("removes a .pending no commit lists, and the leftovers of an interrupted atomic write: the crash came before the commit point", () => {
    const { dir, store } = world();
    commitArtifacts(store, dir, step, inputsOf(dir, ["task.md"]), [{ path: "triage.json", content: "a\n" }]);
    writeFileSync(join(dir, "triage.json.pending"), "never committed\n");
    writeFileSync(join(dir, "spec.yaml.pending"), "never committed\n");
    mkdirSync(join(dir, "rounds/2"), { recursive: true });
    writeFileSync(join(dir, "rounds/2/gates.json.pending"), "never committed\n");
    writeFileSync(join(dir, "spec.md.tmp-4242"), "half");
    const r = recover(dir, store.events("T-0001"));
    expect(r.rolledForward).toEqual([]);
    expect(r.removed.sort()).toEqual(["rounds/2/gates.json.pending", "spec.md.tmp-4242", "spec.yaml.pending", "triage.json.pending"]);
    expect(readFileSync(join(dir, "triage.json"), "utf8")).toBe("a\n");
    expect(existsSync(join(dir, "spec.yaml"))).toBe(false);
  });
});

describe("specDigest", () => {
  it("binds both spec files", () => {
    const { dir } = world();
    writeFileSync(join(dir, "spec.yaml"), "id: T-0001\n");
    writeFileSync(join(dir, "spec.md"), "# Spec\n");
    const before = specDigest(dir);
    writeFileSync(join(dir, "spec.md"), "# Spec, changed\n");
    expect(specDigest(dir)).not.toBe(before);
  });
});

describe("the run lock", () => {
  it("appears whole, admits one runner, and replaces a dead holder's lock", () => {
    const home = factoryHome({ FACTORY_HOME: join(scratch, `home-${String(++n)}`) });
    mkdirSync(home.root, { recursive: true });
    const release = acquireRunLock(home, "T-0001");
    expect(readLock(home)).toEqual({ pid: process.pid, task_id: "T-0001" });
    expect(() => acquireRunLock(home, "T-0002")).toThrow(LockError);
    expect(readdirSync(home.root)).toEqual(["run.lock"]);
    release();
    // A lock whose process is gone is stale.
    writeFileSync(home.lock, JSON.stringify({ pid: 2 ** 22 + 1, task_id: "T-0009" }));
    const again = acquireRunLock(home, "T-0003");
    expect(readLock(home)?.task_id).toBe("T-0003");
    again();
    expect(existsSync(home.lock)).toBe(false);
  });
});
