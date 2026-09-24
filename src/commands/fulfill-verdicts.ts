import * as fs from "node:fs";
import { parseClaims } from "../claims.js";
import { fail, type HandlerResult, ok } from "../envelope.js";
import type { StepContext } from "../handlers.js";
import { runLayout } from "../rundir.js";
import { writeState } from "../state.js";
import { countBy, errorMessage } from "../util.js";
import { deriveMatrix, unresolvedPairs, validateVerdicts } from "../verdicts.js";

/** Persist a validated batch and advance only after every pair is resolved.
 *  Run state is the commit record. Projections are rebuilt before committing,
 *  so retrying a failed write never duplicates an unaccepted batch. */
export function fulfillVerdicts(context: StepContext): HandlerResult {
  const { runDir, state, text } = context;
  const layout = runLayout(runDir);
  try {
    const claimsRaw = fs.readFileSync(layout.step("claims.json"), "utf8");
    const { claims, issues } = parseClaims(claimsRaw);
    if (!claims) {
      return fail(2, runDir, "verdicts", [
        `E205: verdicts: steps/claims.json no longer validates: ${issues.map((issue) => issue.message).join("; ")}`,
      ]);
    }
    const batches = state.verdictBatches ?? [];
    const batch = batches.length + 1;
    const validated = validateVerdicts(text, claims, runDir, batches);
    if (validated.issues.length > 0) {
      return fail(
        2,
        runDir,
        "verdicts",
        validated.issues.map((issue) => `E205: verdicts: ${issue.path}: ${issue.message}`),
      );
    }
    const verdictBatches = [...batches, validated.entries];
    const entries = verdictBatches.flat();
    const remaining = unresolvedPairs(claims, entries);
    const matrix = deriveMatrix(claims, entries, runDir, new Date().toISOString());
    const summary = [...countBy(matrix.claims, (claim) => claim.status)]
      .map(([status, n]) => `${status}: ${n}`)
      .join(", ");
    const step = remaining === 0 ? "briefing" : "verdicts";

    fs.writeFileSync(layout.step("verdicts.json"), `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    fs.writeFileSync(layout.matrixFile, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
    // claims.json is an input only. Never derive by rewriting it.
    writeState(runDir, {
      ...state,
      completed: remaining === 0 ? [...state.completed, "verdicts"] : state.completed,
      step,
      verdictBatches,
    });
    return ok(
      runDir,
      step,
      `Accepted verdict batch ${batch} -> derivation: ${summary}\n` +
        `Unresolved pairs: ${remaining}\nNext takeable step: ${step}`,
      {
        batch,
        derivation: summary,
        fulfilled: "verdicts",
        output: "steps/verdicts.json",
        remaining,
      },
    );
  } catch (error) {
    return fail(4, runDir, "verdicts", [
      `E401: verdict batch not committed: ${errorMessage(error)}; retry the batch to rebuild outputs from state/state.json`,
    ]);
  }
}
