import * as fs from "node:fs";
import * as path from "node:path";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { runOnComplete, STEP_HANDLERS } from "../handlers.js";
import { runLayout } from "../rundir.js";
import { nextStep, STEPS, type StepName } from "../steps.js";
import { readTextFile } from "../validate.js";
import { fulfillVerdicts } from "./fulfill-verdicts.js";
import { advanceState, loadStateOrFail, notTakeable } from "./shared.js";

export interface FulfillOptions {
  readonly runDir: string;
  readonly step: StepName;
  readonly file: string;
}

/** Validate the fulfill file, copy it into steps/, run the step's
 *  post-write effects, and advance state. Never half-advances:
 *  validation runs before any write, and state advances last. */
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

  const handler = STEP_HANDLERS[step];
  if (!handler && step !== "verdicts") {
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
    const message = error instanceof Error ? error.message : String(error);
    return fail(2, runDir, step, [`E204: cannot read fulfill file: ${message}`]);
  }

  const context = { runDir, state, text };
  // Verdict batches own their writes and conditional transition. All other
  // missing handlers were rejected above as CLI-only steps.
  if (!handler) return fulfillVerdicts(context);
  const violations = handler.validate(context);
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
  const layout = runLayout(runDir);
  const dest = path.join(layout.runDir, meta.output);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(4, runDir, step, [`E401: cannot write step output: ${message}`]);
  }

  const completed = runOnComplete(handler, context);
  if ("error" in completed) {
    return fail(4, runDir, step, [completed.error]);
  }

  const advanced = nextStep(step);
  try {
    advanceState(runDir, state, step);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(4, runDir, step, [
      `E402: output saved to ${meta.output} but state advance failed: ${message}; ` +
        `state file: ${runLayout(runDir).stateFile}`,
    ]);
  }

  const human =
    advanced === "done"
      ? `Fulfilled ${step} -> run done.`
      : completed.outcome.summary !== null
        ? `Fulfilled ${step} -> derivation: ${completed.outcome.summary}\nNext takeable step: ${advanced} (output: ${STEPS[advanced as StepName]?.output ?? "done"})`
        : `Fulfilled ${step} -> next takeable step: ${advanced} (output: ${STEPS[advanced as StepName]?.output ?? "done"})`;
  return ok(runDir, advanced === "done" ? "done" : advanced, human, {
    derivation: completed.outcome.summary ?? undefined,
    fulfilled: step,
    output: meta.output,
  });
}
