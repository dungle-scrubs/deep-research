import { readFileSync } from "node:fs";
import { parseClaims } from "../claims.js";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { fetchAll, type LedgerEntry, readLedger } from "../fetch.js";
import { runLayout } from "../rundir.js";
import { STEPS } from "../steps.js";
import { countBy, errorMessage } from "../util.js";
import { advanceState, loadStateOrFail, notTakeable } from "./shared.js";

function citedUrls(runDir: string): string[] {
  const raw = readFileSync(runLayout(runDir).step("claims.json"), "utf8");
  const { claims, issues } = parseClaims(raw);
  if (!claims) {
    throw new Error(`claims.json no longer validates: ${issues.map((i) => i.message).join("; ")}`);
  }
  return claims.flatMap((claim) => claim.citations.map((citation) => citation.url));
}

function summarize(entries: readonly LedgerEntry[]): string {
  return [...countBy(entries, (entry) => entry.status)]
    .map(([status, n]) => `${status}: ${n}`)
    .join(", ");
}

/** Execute the fetch step (CLI step): fetch every cited URL once, record
 *  the ledger, advance to verdicts. Unreachable is an outcome, never a run
 *  failure. */
export async function cmdFetch(runDir: string): Promise<HandlerResult> {
  const loaded = loadStateOrFail(runDir, null);
  if ("result" in loaded) return loaded.result;
  const state = loaded.state;
  if (state.step !== "fetch") return notTakeable(runDir, "fetch", state.step);
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
    advanceState(runDir, state, "fetch");
  } catch (error) {
    return fail(4, runDir, "fetch", [
      `E402: fetch recorded but state advance failed: ${errorMessage(error)}`,
    ]);
  }
  const meta = STEPS.verdicts;
  const counts = summarize(entries);
  const human =
    `Fetch complete: ${counts}\n` +
    `Ledger: ${runLayout(runDir).ledgerFile}\n` +
    `Next: verdicts (output: ${meta.output}; then dr fulfill verdicts <file>)`;
  return ok(runDir, "verdicts", human, {
    counts,
    entries,
    next: "verdicts",
  });
}

/** dr retry-fetch: re-attempt unreachable URLs idempotently; keep ok pages. */
export async function cmdRetryFetch(runDir: string): Promise<HandlerResult> {
  const loaded = loadStateOrFail(runDir, null);
  if ("result" in loaded) return loaded.result;
  const state = loaded.state;
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
  const priorNormalized = new Set(readLedger(runDir).map((entry) => entry.normalized));
  let entries: readonly LedgerEntry[];
  try {
    entries = await fetchAll({ retryOnly: true, runDir, urls });
  } catch (error) {
    return fail(4, runDir, state.step, [`E401: retry-fetch failed: ${errorMessage(error)}`]);
  }
  const counts = summarize(entries);
  const human = `Retry-fetch complete: ${counts}\nLedger: ${runLayout(runDir).ledgerFile}`;
  return ok(runDir, state.step, human, {
    counts,
    entries: entries.filter((entry) => !priorNormalized.has(entry.normalized)),
  });
}
