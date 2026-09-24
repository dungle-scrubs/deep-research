import { appendFileSync } from "node:fs";
import { runLayout } from "./rundir.js";

/** Durable per-run event stream. Every dr command appends a start line
 *  before work and an end line after; an entry with no exit is the trace
 *  of an invocation that hung or was killed. */
export interface RunEvent {
  readonly ts: string;
  readonly event: "start" | "end" | "crash";
  readonly cmd: string;
  readonly pid: number;
  readonly exitCode?: number;
  readonly ok?: boolean;
  readonly errors?: readonly string[];
}

export function appendRunEvent(runDir: string, event: RunEvent): void {
  const line = `${JSON.stringify(event)}\n`;
  try {
    appendFileSync(runLayout(runDir).eventsFile, line, "utf8");
  } catch {
    // The event stream is diagnostics; a failed append must not turn a
    // working command into a failed one. Absence shows in the scan.
  }
}

export function startEvent(cmd: string): RunEvent {
  return { cmd, event: "start", pid: process.pid, ts: new Date().toISOString() };
}

export function endEvent(
  cmd: string,
  exitCode: number,
  ok: boolean,
  errors: readonly string[],
): RunEvent {
  return {
    cmd,
    errors,
    event: "end",
    exitCode,
    ok,
    pid: process.pid,
    ts: new Date().toISOString(),
  };
}
