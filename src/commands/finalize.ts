import * as fs from "node:fs";
import { renderCitations } from "../citations.js";
import type { ClaimsFile } from "../claims.js";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { gateReport, generateSources, readClaimsFile, readMatrixFile } from "../report.js";
import { runLayout } from "../rundir.js";
import { errorMessage } from "../util.js";
import type { Matrix } from "../verdicts.js";
import { advanceState, loadStateOrFail, notTakeable } from "./shared.js";

/** Execute the finalize CLI step: run the report structure gate, generate
 *  sources.md from claims.json, and close the run at done. A failed gate
 *  lists violations, names report.md as the in-place repair surface, exits 2,
 *  and does not advance. */
export function cmdFinalize(runDir: string): HandlerResult {
  const loaded = loadStateOrFail(runDir, null);
  if ("result" in loaded) return loaded.result;
  const state = loaded.state;
  if (state.step !== "finalize") return notTakeable(runDir, "finalize", state.step);
  let report: string;
  try {
    report = fs.readFileSync(runLayout(runDir).reportFile, "utf8");
  } catch (error) {
    return fail(
      2,
      runDir,
      "finalize",
      [
        `E207: report.md is missing or unreadable: ${errorMessage(error)}; ` +
          `edit report.md in place, then run dr next`,
      ],
      `report.md is missing or unreadable (${errorMessage(error)}). Edit report.md in place, then run dr next.`,
      finalizeRecovery(runDir),
    );
  }
  let matrix: Matrix;
  let claims: ClaimsFile;
  try {
    matrix = readMatrixFile(runDir);
    claims = readClaimsFile(runDir);
  } catch (error) {
    return fail(4, runDir, "finalize", [
      `E401: cannot read matrix or claims: ${errorMessage(error)}`,
    ]);
  }
  const violations = gateReport(report, matrix);
  if (violations.length > 0) {
    const errors = violations.map(
      (violation) => `E207: ${violation.message} (edit report.md in place; then dr next)`,
    );
    return fail(
      2,
      runDir,
      "finalize",
      errors,
      `Final gate failed:\n${violations.map((v) => `- ${v.message}`).join("\n")}\nEdit report.md in place, then run dr next. Run does not advance.`,
      finalizeRecovery(runDir),
    );
  }
  const layout = runLayout(runDir);
  try {
    fs.writeFileSync(layout.sourcesFile, generateSources(claims), "utf8");
    fs.writeFileSync(
      layout.citationsFile,
      `${JSON.stringify(renderCitations(runDir, new Date().toISOString()), null, 2)}\n`,
      "utf8",
    );
    advanceState(runDir, state, "finalize");
  } catch (error) {
    return fail(4, runDir, "finalize", [`E401: finalize failed: ${errorMessage(error)}`]);
  }
  const human =
    `Final gate passed. Run done.\n` +
    `Report: ${layout.reportFile}\n` +
    `Sources: ${layout.sourcesFile}`;
  return doneResult(runDir, human);
}

/** Shared terminal result, including idempotent drive resume at done. */
export function doneResult(runDir: string, human = "Run done."): HandlerResult {
  const layout = runLayout(runDir);
  return ok(runDir, "done", human, {
    gate: "passed",
    report: layout.reportFile,
    coverage: readMatrixFile(runDir).coverage,
    citations: layout.citationsFile,
    sources: "sources.md",
  });
}

function finalizeRecovery(runDir: string): Record<string, unknown> {
  return {
    artifact: runLayout(runDir).reportFile,
    state: runLayout(runDir).stateFile,
    repair: `dr next --root ${JSON.stringify(runDir)} --json`,
  };
}
