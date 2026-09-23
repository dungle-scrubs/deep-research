import * as fs from "node:fs";
import * as path from "node:path";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { type RunState, readState } from "../state.js";
import { STEP_ORDER, STEPS, type StepName } from "../steps.js";
import type { Matrix } from "../verdicts.js";

function readMatrix(runDir: string): Matrix | null {
  try {
    const raw = fs.readFileSync(path.join(runDir, "state", "matrix.json"), "utf8");
    return JSON.parse(raw) as Matrix;
  } catch {
    return null;
  }
}

export function cmdStatus(runDir: string): HandlerResult {
  let state: RunState;
  try {
    state = readState(runDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(4, runDir, null, [`E401: cannot read run state: ${message}`]);
  }
  const steps = STEP_ORDER.map((name: StepName) => ({
    completed: state.completed.includes(name),
    kind: STEPS[name].kind,
    name,
    takeable: state.step === name,
  }));
  const matrix = readMatrix(runDir);
  const unreachable = matrix
    ? matrix.claims.filter((claim) => claim.status === "unreachable").length
    : 0;
  const human =
    `Run: ${runDir}\n` +
    `Topic: ${state.topic}\n` +
    `Current step: ${state.step}\n` +
    `Completed: ${state.completed.length > 0 ? state.completed.join(" -> ") : "(none)"}\n` +
    (matrix
      ? `Coverage: ${JSON.stringify(matrix.coverage)}\nCaveats: ${matrix.caveats.length}\nUnreachable claims: ${unreachable}`
      : "Coverage: no matrix yet (derives at verdicts fulfill).");
  return ok(runDir, state.step, human, {
    caveats: matrix?.caveats ?? [],
    completed: [...state.completed],
    coverage: matrix?.coverage ?? { note: "derives at verdicts fulfill" },
    created: state.created,
    current: state.step,
    steps,
    topic: state.topic,
    unreachable,
  });
}
