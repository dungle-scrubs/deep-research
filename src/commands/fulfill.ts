import * as fs from "node:fs";
import * as path from "node:path";
import { type ClaimsFile, parseClaims } from "../claims.js";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { renderFollowupWithQuestions } from "../prompts.js";
import { checkBriefingCoverage, readMatrixFile } from "../report.js";
import { runLayout } from "../rundir.js";
import { nextStep, STEPS, type StepName } from "../steps.js";
import { countBy, errorMessage } from "../util.js";
import { extractGapsQuestions, type ProseStep, readTextFile, validateProse } from "../validate.js";
import { deriveMatrix, type VerdictEntry, validateVerdicts } from "../verdicts.js";
import { advanceState, loadStateOrFail, notTakeable } from "./shared.js";

const PROSE_STEPS: ReadonlySet<string> = new Set(["brief", "foundation", "gaps", "followup"]);

export function isProseStep(step: StepName): step is ProseStep {
  return PROSE_STEPS.has(step);
}

export interface FulfillOptions {
  readonly runDir: string;
  readonly step: StepName;
  readonly file: string;
}

/** Validate the file and, on success, copy it into steps/ and advance the
 *  state pointer. Never half-advances: validation runs before any write,
 *  and state is written after the output file lands. */
export function cmdFulfill(options: FulfillOptions): HandlerResult {
  const { runDir, step } = options;
  const loaded = loadStateOrFail(runDir, step);
  if ("result" in loaded) return loaded.result;
  const state = loaded.state;
  if (state.step === "done") {
    return fail(
      2,
      runDir,
      "done",
      [`E201: run is done; a closed run can be read but not advanced`],
      "Run is done. A closed run can be read (status, help) but not advanced.",
    );
  }
  if (step !== state.step) return notTakeable(runDir, step, state.step);
  if (
    step !== "claims" &&
    step !== "verdicts" &&
    step !== "briefing" &&
    step !== "synthesis" &&
    !isProseStep(step)
  ) {
    return fail(
      2,
      runDir,
      step,
      [`E203: step ${step} is a CLI step executed by dr next; it is not fulfilled with a file`],
      `Step ${step} runs on dr next, not dr fulfill.`,
    );
  }

  let text: string;
  try {
    text = readTextFile(options.file);
  } catch (error) {
    return fail(2, runDir, step, [`E204: cannot read fulfill file: ${errorMessage(error)}`]);
  }

  let violations: readonly string[];
  let parsedClaims: ClaimsFile | null = null;
  let verdictEntries: readonly VerdictEntry[] | null = null;
  let claimsJsonRaw: string | null = null;
  if (step === "claims") {
    const { claims, issues } = parseClaims(text);
    parsedClaims = claims;
    violations = issues.map((issue) => `E205: claims: ${issue.path}: ${issue.message}`);
    if (claims) {
      const seen = new Set<string>();
      for (const claim of claims) {
        if (seen.has(claim.id))
          violations = [...violations, `E205: claims: ${claim.id}: duplicate claim id`];
        seen.add(claim.id);
      }
    }
  } else if (step === "verdicts") {
    claimsJsonRaw = fs.readFileSync(runLayout(runDir).step("claims.json"), "utf8");
    const { claims, issues } = parseClaims(claimsJsonRaw);
    if (!claims) {
      violations = [
        `E205: verdicts: steps/claims.json no longer validates: ${issues
          .map((issue) => issue.message)
          .join("; ")}`,
      ];
    } else {
      parsedClaims = claims;
      const { entries, issues: verdictIssues } = validateVerdicts(text, claims);
      verdictEntries = entries;
      violations = verdictIssues.map((issue) => `E205: verdicts: ${issue.path}: ${issue.message}`);
    }
  } else if (step === "briefing") {
    violations = validateProse("brief", text).map(
      (v) => `E205: briefing: ${v.replace(/^brief: /, "")}`,
    );
    try {
      const matrix = readMatrixFile(runDir);
      violations = [...violations, ...checkBriefingCoverage(text, matrix).map((v) => `E205: ${v}`)];
    } catch (error) {
      return fail(4, runDir, step, [
        `E401: cannot read state/matrix.json for the coverage check: ${errorMessage(error)}`,
      ]);
    }
  } else if (step === "synthesis") {
    violations = validateProse("brief", text).map(
      (v) => `E205: synthesis: ${v.replace(/^brief: /, "")}`,
    );
  } else {
    violations = validateProse(step, text).map((v) => `E205: ${v}`);
  }
  if (violations.length > 0) {
    return fail(
      2,
      runDir,
      step,
      violations,
      `Validation failed for ${step}:\n${violations.map((v) => `- ${v}`).join("\n")}\nRun does not advance.`,
    );
  }

  const meta = STEPS[step];
  const dest = path.join(runLayout(runDir).runDir, meta.output);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, "utf8");
  } catch (error) {
    return fail(4, runDir, step, [`E401: cannot write step output: ${errorMessage(error)}`]);
  }

  if (step === "gaps") {
    const { questions } = extractGapsQuestions(text);
    try {
      const copyPath = runLayout(runDir).prompt("followup");
      const copy = fs.readFileSync(copyPath, "utf8");
      const rendered = renderFollowupWithQuestions(copy, state.topic, questions);
      fs.writeFileSync(copyPath, rendered, "utf8");
    } catch (error) {
      return fail(4, runDir, step, [
        `E401: gaps output saved but follow-up prompt update failed: ${errorMessage(error)}`,
      ]);
    }
  }

  // The before/after byte check guards the RFC rule that derivation never
  // rewrites steps/claims.json.
  let matrixSummary: string | null = null;
  if (step === "verdicts" && parsedClaims && verdictEntries && claimsJsonRaw !== null) {
    try {
      const matrix = deriveMatrix(parsedClaims, verdictEntries, runDir, new Date().toISOString());
      const layout = runLayout(runDir);
      fs.mkdirSync(layout.stateDir, { recursive: true });
      fs.writeFileSync(layout.matrixFile, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
      const after = fs.readFileSync(layout.step("claims.json"), "utf8");
      if (after !== claimsJsonRaw) {
        return fail(4, runDir, step, [
          "E401: derivation would rewrite steps/claims.json; matrix discarded",
        ]);
      }
      matrixSummary = [...countBy(matrix.claims, (claim) => claim.status)]
        .map(([status, n]) => `${status}: ${n}`)
        .join(", ");
    } catch (error) {
      return fail(4, runDir, step, [
        `E401: verdicts saved but derivation failed: ${errorMessage(error)}`,
      ]);
    }
  }

  const advanced = nextStep(step);
  try {
    advanceState(runDir, state, step);
  } catch (error) {
    return fail(4, runDir, step, [
      `E402: output saved to ${meta.output} but state advance failed: ${errorMessage(error)}; ` +
        `state file: ${runLayout(runDir).stateFile}`,
    ]);
  }

  const human =
    advanced === "done"
      ? `Fulfilled ${step} -> run done.`
      : matrixSummary !== null
        ? `Fulfilled ${step} -> derivation: ${matrixSummary}\nNext takeable step: ${advanced} (output: ${STEPS[advanced as StepName]?.output ?? "done"})`
        : `Fulfilled ${step} -> next takeable step: ${advanced} (output: ${STEPS[advanced as StepName]?.output ?? "done"})`;
  return ok(runDir, advanced === "done" ? "done" : advanced, human, {
    derivation: matrixSummary ?? undefined,
    fulfilled: step,
    output: meta.output,
  });
}
