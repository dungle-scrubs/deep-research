import * as fs from "node:fs";
import * as path from "node:path";
import type { ClaimsFile } from "../claims.js";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { gateReport, generateSources, readClaimsFile, readMatrixFile } from "../report.js";
import { type RunState, readState, writeState } from "../state.js";
import { STEPS } from "../steps.js";
import type { Matrix } from "../verdicts.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Execute the finalize CLI step: run the report structure gate, generate
 *  sources.md from claims.json, and close the run at done. A failed gate
 *  lists violations, names synthesis as the fixing step, exits 2, and
 *  does not advance. */
export function cmdFinalize(runDir: string): HandlerResult {
  let state: RunState;
  try {
    state = readState(runDir);
  } catch (error) {
    return fail(4, runDir, null, [`E401: cannot read run state: ${errorMessage(error)}`]);
  }
  if (state.step !== "finalize") {
    return fail(
      2,
      runDir,
      state.step,
      [`E202: step finalize is not takeable; the takeable step is ${state.step}`],
      `Step finalize is not takeable now. The takeable step is ${state.step}.`,
    );
  }
  let report: string;
  try {
    report = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
  } catch (error) {
    return fail(
      2,
      runDir,
      "finalize",
      [
        `E207: report.md is missing or unreadable: ${errorMessage(error)}; ` +
          `fix at synthesis, then run dr next`,
      ],
      `report.md is missing or unreadable (${errorMessage(error)}). Fix at synthesis, then run dr next.`,
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
      (violation) => `E207: ${violation.message} (fix at ${violation.fixableAt})`,
    );
    return fail(
      2,
      runDir,
      "finalize",
      errors,
      `Final gate failed:\n${violations.map((v) => `- ${v.message} (fix at ${v.fixableAt})`).join("\n")}\nRun does not advance.`,
    );
  }
  try {
    fs.writeFileSync(path.join(runDir, "sources.md"), generateSources(claims), "utf8");
    writeState(runDir, {
      completed: [...state.completed, "finalize"],
      created: state.created,
      step: "done",
      topic: state.topic,
      version: 1,
    });
  } catch (error) {
    return fail(4, runDir, "finalize", [`E401: finalize failed: ${errorMessage(error)}`]);
  }
  const human =
    `Final gate passed. Run done.\n` +
    `Report: ${path.join(runDir, "report.md")}\n` +
    `Sources: ${path.join(runDir, "sources.md")}`;
  return ok(runDir, "done", human, { gate: "passed", sources: "sources.md" });
}

export const finalizeStepMeta = STEPS.finalize;
