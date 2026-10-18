// The outbox (ROADMAP P1-02): every side effect outside $FACTORY_HOME (a push, a PR, a comment,
// a check run) is recorded as an intent before it is attempted and as done after, and is found
// before it is made. So a run killed at any instant neither loses an effect nor repeats one:
//
//   - each effect has a key, `task/stage/round/kind[/name]` (D6), and an attempt number per key;
//   - an effect first looks for itself (the branch at the commit, a PR from the branch at the
//     commit, a comment with the key's marker, a check run with the key as external_id, a PR
//     already merged) and acts only when it finds nothing;
//   - at the start of every run, reconcile() looks up each intent left without a done and records
//     what it found, so no intent stays dangling.
//
// Nothing else in the controller may push or write to GitHub (outbox.test.ts enforces it).
import { tmpdir } from "node:os";
import { pushFromMirror, remoteBranchSha, type GitAuth } from "../git/repo.ts";
import type { EventStore, FactoryEvent } from "../store/events.ts";
import type { CheckRunInput, CheckRunRef, GitHub, IssueComment, MergeResult, PullRequest, PullRequestInput } from "./client.ts";

export type EffectKind = "push" | "pull_request" | "comment" | "check_run" | "merge";
/** done: this attempt made it; found: it already existed; absent: a dangling intent's effect never happened; failed: the attempt threw. */
export type EffectOutcome = "done" | "found" | "absent" | "failed";

export interface OutboxDeps {
  store: EventStore;
  taskId: string;
  github: GitHub | null;
  auth: GitAuth | null;
  /** Test-only kill points (`<stage>:<kind>:intent`, `<stage>:<kind>:acted`); a no-op in a real run. */
  probe?: (point: string) => void;
  log: (line: string) => void;
}

interface Where {
  stage: string;
  round: number;
  /** Tells two effects of one kind apart within a step. */
  name?: string;
}

export const effectKey = (taskId: string, w: Where, kind: EffectKind): string => `${taskId}/${w.stage}/${String(w.round)}/${kind}${w.name === undefined ? "" : `/${w.name}`}`;

/** The marker a comment carries, so the outbox can find it again. */
export const commentMarker = (key: string): string => `<!-- software-factory:${key} -->`;

const id = (e: FactoryEvent): string => `${String(e.payload["key"])}#${String(e.payload["attempt"])}`;

/** Intents with no done for the same key and attempt. Intents from before the outbox carry no key and are ignored. */
export function danglingIntents(events: readonly FactoryEvent[]): FactoryEvent[] {
  const done = new Set(events.filter((e) => e.type === "side_effect_done" && typeof e.payload["key"] === "string").map(id));
  return events.filter((e) => e.type === "side_effect_intent" && typeof e.payload["key"] === "string" && !done.has(id(e)));
}

export interface Outbox {
  /** Pushes `commit` to `branch` from the mirror; returns the commit the remote branch now holds. */
  push(w: Where, p: { remote: string; mirror: string; clone: string; branch: string; commit: string }): Promise<string>;
  pullRequest(w: Where, input: PullRequestInput & { commit: string }): Promise<PullRequest>;
  comment(w: Where & { name: string }, p: { repo: string; issue: number; body: string }): Promise<IssueComment>;
  checkRun(w: Where & { name: string }, input: Omit<CheckRunInput, "externalId">): Promise<CheckRunRef>;
  /** Squash-merges the PR at exactly `sha` (P2-05b); a PR already merged is found, not merged again. */
  merge(w: Where, p: { repo: string; number: number; sha: string }): Promise<MergeResult>;
  /** Resolves every dangling intent by looking its effect up; returns what it recorded. */
  reconcile(): Promise<{ key: string; attempt: number; outcome: EffectOutcome }[]>;
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const { store, taskId } = deps;
  const probe = deps.probe ?? (() => undefined);
  const emit = (type: "side_effect_intent" | "side_effect_done", payload: Record<string, unknown>): void => {
    store.append({ task_id: taskId, actor: { kind: "factoryctl", id: "factoryctl" }, type, payload });
  };
  const github = (): GitHub => {
    if (deps.github === null) throw new Error("this effect needs GitHub access (FACTORY_GITHUB_TOKEN)");
    return deps.github;
  };

  // The lookups, from what an intent records: reconcile has nothing else to go on.
  const findPush = (p: { remote: string; branch: string; commit: string }): string | null =>
    remoteBranchSha(tmpdir(), p.remote, p.branch, deps.auth) === p.commit ? p.commit : null;
  const findPull = async (p: { repo: string; head: string; commit: string }): Promise<PullRequest | null> =>
    (await github().pullRequests(p.repo, p.head)).find((pr) => pr.headSha === p.commit) ?? null;
  const findComment = async (key: string, p: { repo: string; issue: number }): Promise<IssueComment | null> =>
    (await github().comments(p.repo, p.issue)).find((c) => c.body.includes(commentMarker(key))) ?? null;
  const findCheck = (key: string, p: { repo: string; sha: string }): Promise<CheckRunRef | null> => github().findCheckRun(p.repo, p.sha, key);
  const findMerge = async (p: { repo: string; number: number }): Promise<MergeResult | null> => {
    const pr = await github().pullRequest(p.repo, p.number);
    return pr.merged ? { merged: true, sha: pr.headSha } : null;
  };

  async function effect<T>(
    w: Where,
    kind: EffectKind,
    target: Record<string, unknown>,
    find: (key: string) => Promise<T | null>,
    act: (key: string) => Promise<T>,
    result: (t: T) => Record<string, unknown>,
  ): Promise<T> {
    const key = effectKey(taskId, w, kind);
    const attempt = store.events(taskId).filter((e) => e.type === "side_effect_intent" && e.payload["key"] === key).length + 1;
    const point = `${w.stage}:${kind}${w.name === undefined ? "" : `/${w.name}`}`;
    emit("side_effect_intent", { key, kind, attempt, ...target });
    probe(`${point}:intent`);
    let found: T | null;
    let value: T;
    try {
      found = await find(key);
      value = found ?? (await act(key));
    } catch (e) {
      emit("side_effect_done", { key, kind, attempt, outcome: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
      throw e;
    }
    probe(`${point}:acted`);
    emit("side_effect_done", { key, kind, attempt, outcome: found === null ? "done" : "found", ...result(value) });
    return value;
  }

  return {
    push(w, p) {
      const target = { remote: p.remote, branch: p.branch, commit: p.commit };
      return effect(w, "push", target, () => Promise.resolve(findPush(target)), () => Promise.resolve(pushFromMirror(p.mirror, p.clone, p.branch, p.remote, deps.auth)), (sha) => ({ commit: sha }));
    },
    pullRequest(w, input) {
      const { commit, ...pr } = input;
      return effect(w, "pull_request", { repo: pr.repo, head: pr.head, base: pr.base, commit }, () => findPull({ repo: pr.repo, head: pr.head, commit }), () => github().createPullRequest(pr), (r) => ({ number: r.number, url: r.url }));
    },
    comment(w, p) {
      return effect(w, "comment", { repo: p.repo, issue: p.issue }, (key) => findComment(key, p), (key) => github().createComment(p.repo, p.issue, `${p.body.trimEnd()}\n\n${commentMarker(key)}`), (c) => ({ id: c.id, url: c.url }));
    },
    checkRun(w, input) {
      return effect(w, "check_run", { repo: input.repo, sha: input.headSha, name: input.name }, (key) => findCheck(key, { repo: input.repo, sha: input.headSha }), (key) => github().createCheckRun({ ...input, externalId: key }), (r) => ({ id: r.id, url: r.url }));
    },
    merge(w, p) {
      return effect(w, "merge", { repo: p.repo, number: p.number, sha: p.sha }, () => findMerge(p), () => github().mergePullRequest(p.repo, p.number, p.sha), (r) => ({ merged: r.merged, merge_commit: r.sha }));
    },
    async reconcile() {
      const recorded: { key: string; attempt: number; outcome: EffectOutcome }[] = [];
      for (const intent of danglingIntents(store.events(taskId))) {
        const p = intent.payload;
        const key = String(p["key"]);
        const attempt = Number(p["attempt"]);
        const kind = p["kind"] as EffectKind;
        try {
          let found: Record<string, unknown> | null;
          if (kind === "push") {
            const sha = findPush({ remote: String(p["remote"]), branch: String(p["branch"]), commit: String(p["commit"]) });
            found = sha === null ? null : { commit: sha };
          } else if (kind === "pull_request") {
            const pr = await findPull({ repo: String(p["repo"]), head: String(p["head"]), commit: String(p["commit"]) });
            found = pr === null ? null : { number: pr.number, url: pr.url };
          } else if (kind === "comment") {
            const c = await findComment(key, { repo: String(p["repo"]), issue: Number(p["issue"]) });
            found = c === null ? null : { id: c.id, url: c.url };
          } else if (kind === "merge") {
            const m = await findMerge({ repo: String(p["repo"]), number: Number(p["number"]) });
            found = m === null ? null : { merged: true };
          } else {
            const r = await findCheck(key, { repo: String(p["repo"]), sha: String(p["sha"]) });
            found = r === null ? null : { id: r.id, url: r.url };
          }
          const outcome: EffectOutcome = found === null ? "absent" : "found";
          emit("side_effect_done", { key, kind, attempt, outcome, reconciled: true, ...(found ?? {}) });
          recorded.push({ key, attempt, outcome });
        } catch (e) {
          // Left dangling: the step that owns it looks again before it acts, and the next run reconciles again.
          deps.log(`${taskId}: could not reconcile ${key} (attempt ${String(attempt)}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return recorded;
    },
  };
}
