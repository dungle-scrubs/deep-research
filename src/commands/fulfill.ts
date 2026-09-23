import * as fs from "node:fs";
import * as path from "node:path";
import { type ClaimsFile, parseClaims } from "../claims.js";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { renderFollowupWithQuestions } from "../prompts.js";
import { checkBriefingCoverage, readMatrixFile } from "../report.js";
import { type RunState, readState, writeState } from "../state.js";
import { nextStep, STEPS, type StepName } from "../steps.js";
import { extractGapsQuestions, type ProseStep, readTextFile, validateProse } from "../validate.js";
import { deriveMatrix, validateVerdicts } from "../verdicts.js";

const PROSE_STEPS: ReadonlySet<string> = new Set(["brief", "foundation", "gaps", "followup"]);

export function isProseStep(step: StepName): step is ProseStep {
  return PROSE_STEPS.has(step);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  let state: RunState;
  try {
    state = readState(runDir);
  } catch (error) {
    return fail(4, runDir, step, [`E401: cannot read run state: ${errorMessage(error)}`]);
  }
  if (state.step === "done") {
    return fail(
      2,
      runDir,
      "done",
      [`E201: run is done; a closed run can be read but not advanced`],
      "Run is done. A closed run can be read (status, help) but not advanced.",
    );
  }
  if (step !== state.step) {
    return fail(
      2,
      runDir,
      state.step,
      [`E202: step ${step} is not takeable; the takeable step is ${state.step}`],
      `Step ${step} is not takeable now. The takeable step is ${state.step}.`,
    );
  }
  if (
    step !== "claims" &&
    step !== "verdicts" &&
    step !== "briefing" &&
    step !== "synthesis" &&
    !isProseStep(step)
  ) {
    const scopeMeta = STEPS[step];
    return fail(
      2,
      runDir,
      step,
      [
        `E203: step ${step} is not fulfillable in this slice (owned by ticket #${scopeMeta.ticket}); ` +
          `the takeable step is ${state.step}`,
      ],
      `Step ${step} is not part of this ticket's scope (ticket #${scopeMeta.ticket}).`,
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
    const claimsRaw = fs.readFileSync(path.join(runDir, "steps", "claims.json"), "utf8");
    const { claims, issues } = parseClaims(claimsRaw);
    if (!claims) {
      violations = [
        `E205: verdicts: steps/claims.json no longer validates: ${issues
          .map((issue) => issue.message)
          .join("; ")}`,
      ];
    } else {
      parsedClaims = claims;
      const { issues: verdictIssues } = validateVerdicts(text, claims);
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
  const dest = path.join(runDir, meta.output);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, "utf8");
  } catch (error) {
    return fail(4, runDir, step, [`E401: cannot write step output: ${errorMessage(error)}`]);
  }

  // Gaps fulfill feeds the follow-up template deterministically.
  if (step === "gaps") {
    const { questions } = extractGapsQuestions(text);
    try {
      const copyPath = path.join(runDir, "prompts", "followup.md");
      const copy = fs.readFileSync(copyPath, "utf8");
      const rendered = renderFollowupWithQuestions(copy, state.topic, questions);
      fs.writeFileSync(copyPath, rendered, "utf8");
    } catch (error) {
      return fail(4, runDir, step, [
        `E401: gaps output saved but follow-up prompt update failed: ${errorMessage(error)}`,
      ]);
    }
  }

  // Verdicts fulfill runs the deterministic derivation into state/matrix.json.
  let matrixSummary: string | null = null;
  if (step === "verdicts" && parsedClaims) {
    try {
      const before = fs.readFileSync(path.join(runDir, "steps", "claims.json"), "utf8");
      const { entries } = validateVerdicts(text, parsedClaims);
      const matrix = deriveMatrix(parsedClaims, entries, runDir, new Date().toISOString());
      const matrixPath = path.join(runDir, "state", "matrix.json");
      fs.mkdirSync(path.dirname(matrixPath), { recursive: true });
      fs.writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
      const after = fs.readFileSync(path.join(runDir, "steps", "claims.json"), "utf8");
      if (after !== before) {
        return fail(4, runDir, step, [
          "E401: derivation would rewrite steps/claims.json; matrix discarded",
        ]);
      }
      const counts = new Map<string, number>();
      for (const claim of matrix.claims)
        counts.set(claim.status, (counts.get(claim.status) ?? 0) + 1);
      matrixSummary = [...counts.entries()].map(([s, n]) => `${s}: ${n}`).join(", ");
    } catch (error) {
      return fail(4, runDir, step, [
        `E401: verdicts saved but derivation failed: ${errorMessage(error)}`,
      ]);
    }
  }

  const advanced = nextStep(step);
  try {
    writeState(runDir, {
      completed: [...state.completed, step],
      created: state.created,
      step: advanced,
      topic: state.topic,
      version: 1,
    });
  } catch (error) {
    return fail(4, runDir, step, [
      `E402: output saved to ${meta.output} but state advance failed: ${errorMessage(error)}; ` +
        `state file: ${path.join(runDir, "state", "state.json")}`,
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
