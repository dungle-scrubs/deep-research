import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseClaims } from "../claims.js";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { fetchAll, type LedgerEntry, readLedger } from "../fetch.js";
import { type RunState, readState, writeState } from "../state.js";
import { nextStep, STEPS } from "../steps.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function citedUrls(runDir: string): string[] {
  const raw = readFileSync(path.join(runDir, "steps", "claims.json"), "utf8");
  const { claims, issues } = parseClaims(raw);
  if (!claims) {
    throw new Error(`claims.json no longer validates: ${issues.map((i) => i.message).join("; ")}`);
  }
  return claims.flatMap((claim) => claim.citations.map((citation) => citation.url));
}

function summarize(entries: readonly LedgerEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => `${status}: ${n}`).join(", ");
}

/** Execute the fetch step (CLI step): fetch every cited URL once, record
 *  the ledger, advance to verdicts. Unreachable is an outcome, never a run
 *  failure. */
export async function cmdFetch(runDir: string): Promise<HandlerResult> {
  let state: RunState;
  try {
    state = readState(runDir);
  } catch (error) {
    return fail(4, runDir, null, [`E401: cannot read run state: ${errorMessage(error)}`]);
  }
  if (state.step !== "fetch") {
    return fail(
      2,
      runDir,
      state.step,
      [`E202: step fetch is not takeable; the takeable step is ${state.step}`],
      `Step fetch is not takeable now. The takeable step is ${state.step}.`,
    );
  }
  let urls: string[];
  try {
    urls = citedUrls(runDir);
  } catch (error) {
    return fail(4, runDir, "fetch", [`E401: ${errorMessage(error)}`]);
  }
  let entries: readonly LedgerEntry[];
  try {
    entries = await fetchAll({ runDir, urls });
  } catch (error) {
    return fail(4, runDir, "fetch", [`E401: fetch failed: ${errorMessage(error)}`]);
  }
  try {
    writeState(runDir, {
      completed: [...state.completed, "fetch"],
      created: state.created,
      step: nextStep("fetch"),
      topic: state.topic,
      version: 1,
    });
  } catch (error) {
    return fail(4, runDir, "fetch", [
      `E402: fetch recorded but state advance failed: ${errorMessage(error)}`,
    ]);
  }
  const meta = STEPS.verdicts;
  const human =
    `Fetch complete: ${summarize(entries)}\n` +
    `Ledger: ${path.join(runDir, "state", "fetch-ledger.json")}\n` +
    `Next: verdicts (output: ${meta.output}; then dr fulfill verdicts <file>)`;
  return ok(runDir, "verdicts", human, {
    counts: summarize(entries),
    entries,
    next: "verdicts",
  });
}

/** dr retry-fetch: re-attempt unreachable URLs idempotently; keep ok pages. */
export async function cmdRetryFetch(runDir: string): Promise<HandlerResult> {
  let state: RunState;
  try {
    state = readState(runDir);
  } catch (error) {
    return fail(4, runDir, null, [`E401: cannot read run state: ${errorMessage(error)}`]);
  }
  if (state.step === "done") {
    return fail(
      2,
      runDir,
      "done",
      ["E201: run is done; a closed run can be read but not advanced"],
      "Run is done. A closed run can be read but not advanced.",
    );
  }
  if (!state.completed.includes("fetch")) {
    return fail(
      2,
      runDir,
      state.step,
      ["E202: fetch has not run yet; nothing to retry"],
      "Fetch has not run yet; nothing to retry.",
    );
  }
  let urls: string[];
  try {
    urls = citedUrls(runDir);
  } catch (error) {
    return fail(4, runDir, state.step, [`E401: ${errorMessage(error)}`]);
  }
  let entries: readonly LedgerEntry[];
  try {
    entries = await fetchAll({ retryOnly: true, runDir, urls });
  } catch (error) {
    return fail(4, runDir, state.step, [`E401: retry-fetch failed: ${errorMessage(error)}`]);
  }
  const before = readLedger(runDir);
  const human = `Retry-fetch complete: ${summarize(entries)}\nLedger: ${path.join(runDir, "state", "fetch-ledger.json")}`;
  return ok(runDir, state.step, human, {
    counts: summarize(entries),
    entries: entries.filter(
      (entry) => before.find((prior) => prior.normalized === entry.normalized) === undefined,
    ),
  });
}
