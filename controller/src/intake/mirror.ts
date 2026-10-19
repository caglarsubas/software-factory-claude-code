// The status mirror (ROADMAP P2-04): a task intake admitted keeps one comment on its issue,
// which says where the task is. The comment is made and edited only through the outbox, and
// carries IDs, states and links only: never the issue's text or anything an agent wrote.
import { sha256 } from "../fsutil.ts";
import { commentMarker, effectKey, type Outbox } from "../github/outbox.ts";
import type { EventStore, FactoryEvent } from "../store/events.ts";
import { currentState, currentStatePayload } from "../task/lifecycle.ts";
import type { IssueSource } from "../task/task.ts";

/** The issue a task was admitted from, or null for a task created by hand. */
export function issueOf(events: readonly FactoryEvent[]): IssueSource | null {
  const issue = events.find((e) => e.type === "task_created")?.payload["issue"];
  return typeof issue === "object" && issue !== null ? (issue as IssueSource) : null;
}

/** The status comment's text, from the task's events. */
export function statusBody(taskId: string, events: readonly FactoryEvent[]): string {
  const state = currentState(events);
  const gate = currentStatePayload(events)["gate"];
  const pr = events.filter((e) => e.type === "state_changed" && typeof e.payload["pr_url"] === "string").at(-1)?.payload["pr_url"];
  return [
    `**Software factory**: task ${taskId}`,
    "",
    `State: \`${state}\`${typeof gate === "string" ? ` (gate: ${gate})` : ""}`,
    ...(typeof pr === "string" ? [`Pull request: ${pr}`] : []),
    "",
    "The factory works from this issue as it was when it was labelled. A maintainer labels it again to admit an edit.",
  ].join("\n");
}

const WHERE = { stage: "intake", round: 1, name: "status" } as const;

/**
 * Brings the issue's status comment up to date: makes it the first time, edits it when the
 * status changed since, and does nothing otherwise. A task not admitted from an issue has none.
 */
export async function mirrorIssue(o: { store: EventStore; taskId: string; outbox: Outbox }): Promise<void> {
  const events = o.store.events(o.taskId);
  const issue = issueOf(events);
  if (issue === null) return;
  // The comment as GitHub holds it: the outbox adds its marker when it makes it, and an edit keeps it.
  const text = statusBody(o.taskId, events).trimEnd();
  const body = `${text}\n\n${commentMarker(effectKey(o.taskId, WHERE, "comment"))}`;
  const digest = sha256(body);
  const mirrored = events.filter((e) => e.type === "command" && e.payload["command"] === "issue_status");
  const last = mirrored.at(-1);
  if (last?.payload["digest"] === digest) return;
  const comment = last === undefined
    ? await o.outbox.comment(WHERE, { repo: issue.repo, issue: issue.number, body: text })
    : await o.outbox.editComment({ stage: "mirror", round: mirrored.length, name: "status" }, { repo: issue.repo, id: Number(last.payload["comment_id"]), body });
  o.store.append({ task_id: o.taskId, actor: { kind: "factoryctl", id: "factoryctl" }, type: "command", payload: { command: "issue_status", comment_id: comment.id, digest, state: currentState(events) } });
}
