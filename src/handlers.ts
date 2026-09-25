import * as fs from "node:fs";
import { parseClaims } from "./claims.js";
import { documentsFor } from "./documents.js";
import { renderFollowupWithQuestions } from "./prompts.js";
import { checkBriefingCoverage, readMatrixFile } from "./report.js";
import { runLayout } from "./rundir.js";
import type { RunState } from "./state.js";
import type { StepName } from "./steps.js";
import { errorMessage } from "./util.js";
import { extractGapsQuestions, validateProse } from "./validate.js";

/** Per-step fulfillment handlers. Each caller step owns its validation and
 *  its post-write effects here; cmdFulfill is lookup, write, advance.
 *
 *  Verdict batches have a dedicated fulfillment command because they can
 *  keep the step open. Fetch and finalize execute through dr next. */

export interface StepContext {
  readonly runDir: string;
  readonly state: RunState;
  readonly text: string;
}

export interface StepOutcome {
  /** Extra line for the human message (e.g. the derivation summary). */
  readonly summary: string | null;
}

export interface StepHandler {
  /** E401 wording when this handler's post-write effects fail. */
  readonly failureWord?: string;
  /** Validate the fulfill text; one E205 violation string per problem. */
  validate(context: StepContext): readonly string[];
  /** Runs after the step output is written. */
  onComplete?(context: StepContext): StepOutcome;
}

function proseValidator(step: string): (context: StepContext) => readonly string[] {
  return (context) =>
    validateProse("brief", context.text).map((v) => `E205: ${step}: ${v.replace(/^brief: /, "")}`);
}

const briefHandler: StepHandler = { validate: proseValidator("brief") };

const foundationHandler: StepHandler = {
  validate(context) {
    const violations = validateProse("foundation", context.text).map((v) => `E205: ${v}`);
    return violations;
  },
};

const gapsHandler: StepHandler = {
  failureWord: "gaps output saved but follow-up prompt update failed",
  validate(context) {
    return validateProse("gaps", context.text).map((v) => `E205: ${v}`);
  },
  onComplete(context) {
    const layout = runLayout(context.runDir);
    const { questions } = extractGapsQuestions(context.text);
    const copy = fs.readFileSync(layout.prompt("followup"), "utf8");
    fs.writeFileSync(
      layout.prompt("followup"),
      renderFollowupWithQuestions(copy, context.state.topic, questions),
      "utf8",
    );
    return { summary: null };
  },
};

const followupHandler: StepHandler = {
  validate(context) {
    return validateProse("followup", context.text).map((v) => `E205: ${v}`);
  },
};

const claimsHandler: StepHandler = {
  validate(context) {
    const { claims, issues } = parseClaims(context.text);
    const violations = issues.map((issue) => `E205: claims: ${issue.path}: ${issue.message}`);
    if (!claims) return violations;
    const documents = documentsFor(claims);
    const minimum = context.state.policy?.minDistinctCitations ?? 1;
    const seen = new Set<string>();
    for (const claim of claims) {
      if (seen.has(claim.id)) violations.push(`E205: claims: ${claim.id}: duplicate claim id`);
      seen.add(claim.id);
      const count = new Set(claim.citations.map((citation) => documents.documentOf(citation.url)))
        .size;
      if (count < minimum)
        violations.push(
          `E205: claims: ${claim.id}.citations: distinct-citation-count ${count} < required ${minimum}; fix at claims: supply another distinct document or remove/narrow the unsupported claim; then dr fulfill claims <corrected-file> --root ${context.runDir}`,
        );
    }
    return violations;
  },
};

const briefingHandler: StepHandler = {
  validate(context) {
    const violations = proseValidator("briefing")(context);
    const problems = checkBriefingCoverage(context.text, readMatrixFile(context.runDir)).map(
      (problem) => `E205: ${problem}`,
    );
    return [...violations, ...problems];
  },
};

const synthesisHandler: StepHandler = { validate: proseValidator("synthesis") };

export const STEP_HANDLERS: Readonly<Partial<Record<StepName, StepHandler>>> = {
  briefing: briefingHandler,
  brief: briefHandler,
  claims: claimsHandler,
  foundation: foundationHandler,
  followup: followupHandler,
  gaps: gapsHandler,
  synthesis: synthesisHandler,
};

/** Wrap handler onComplete failures with the handler's E401 wording. */
export function runOnComplete(
  handler: StepHandler,
  context: StepContext,
): { outcome: StepOutcome } | { error: string } {
  if (!handler.onComplete) return { outcome: { summary: null } };
  try {
    return { outcome: handler.onComplete(context) };
  } catch (error) {
    const word = handler.failureWord ?? `${context.state.step} post-write effects failed`;
    return { error: `E401: ${word}: ${errorMessage(error)}` };
  }
}
