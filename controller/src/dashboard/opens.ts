// The drawer-open log (ROADMAP P2-10, §6 approval fatigue): each time the operator opens a task's
// evidence drawer, one line in $FACTORY_HOME/dashboard/drawer-opens.ndjson. It is the dashboard's
// own file, never factory.db, and holds task IDs, states and times only.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Home } from "../home.ts";
import type { State } from "../store/events.ts";

export interface DrawerOpen {
  at: string;
  task: string;
  state: State;
  /** The gate the task waited at, when it waited at one. */
  gate: string | null;
}

export const opensPath = (home: Home): string => join(home.root, "dashboard", "drawer-opens.ndjson");

export function logDrawerOpen(home: Home, o: DrawerOpen): void {
  const path = opensPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(o)}\n`, { mode: 0o600 });
}

/** Every logged open; a line that does not parse (a write cut short) is skipped. */
export function readDrawerOpens(home: Home): DrawerOpen[] {
  const path = opensPath(home);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      const o = JSON.parse(line) as Partial<DrawerOpen>;
      return typeof o.at === "string" && typeof o.task === "string" && typeof o.state === "string" ? [{ at: o.at, task: o.task, state: o.state, gate: o.gate ?? null }] : [];
    } catch {
      return [];
    }
  });
}

/** Opens in [start, end): all of them, those at a human gate, and how many tasks they covered. */
export function drawerOpenCounts(opens: readonly DrawerOpen[], start: Date, end: Date): { opens: number; atGate: number; tasks: number } {
  const inWeek = opens.filter((o) => {
    const t = Date.parse(o.at);
    return t >= start.getTime() && t < end.getTime();
  });
  return { opens: inWeek.length, atGate: inWeek.filter((o) => o.state === "NEEDS_HUMAN").length, tasks: new Set(inWeek.map((o) => o.task)).size };
}
