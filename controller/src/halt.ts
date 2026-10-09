// The kill switch, v0 (ROADMAP P0-09; the full runbook is P2-07). `factoryctl halt` writes
// $FACTORY_HOME/HALT and signals the running task. While the file exists, no run starts, the
// pipeline stops at its next boundary without failing the task, and the in-process guard denies
// every tool call, so a session that outlives the signal can no longer act. Only the operator
// lifts it (`factoryctl unhalt`); a halted task resumes from its last finished stage.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Home } from "./home.ts";

export interface Halt {
  by: string;
  reason: string;
  at: string;
}

/** The halt in force, if any. A file that cannot be read still halts: the switch fails closed. */
export function readHalt(home: Home): Halt | null {
  if (!existsSync(home.halt)) return null;
  try {
    const h = JSON.parse(readFileSync(home.halt, "utf8")) as Record<string, unknown>;
    const field = (key: string, fallback: string): string => (typeof h[key] === "string" ? h[key] : fallback);
    return { by: field("by", "unknown"), reason: field("reason", "no reason given"), at: field("at", "") };
  } catch {
    return { by: "unknown", reason: "the HALT file is unreadable", at: "" };
  }
}

export function setHalt(home: Home, by: string, reason: string, now: Date = new Date()): Halt {
  const halt = { by, reason, at: now.toISOString() };
  writeFileSync(home.halt, `${JSON.stringify(halt)}\n`, { mode: 0o600 });
  return halt;
}

/** Lifts the halt; false when none was in force. */
export function clearHalt(home: Home): boolean {
  if (!existsSync(home.halt)) return false;
  rmSync(home.halt, { force: true });
  return true;
}

export const describeHalt = (h: Halt): string => `halted${h.at === "" ? "" : ` since ${h.at}`} by ${h.by}: ${h.reason}`;
