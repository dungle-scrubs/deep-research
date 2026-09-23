import { type HandlerResult, ok } from "../envelope.js";
import { readMatrixFile } from "../report.js";
import { STEP_ORDER, STEPS, type StepName } from "../steps.js";
import type { Matrix } from "../verdicts.js";
import { loadStateOrFail } from "./shared.js";

function readMatrix(runDir: string): Matrix | null {
  try {
    return readMatrixFile(runDir);
  } catch {
    return null;
  }
}

export function cmdStatus(runDir: string): HandlerResult {
  const loaded = loadStateOrFail(runDir, null);
  if ("result" in loaded) return loaded.result;
  const state = loaded.state;
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
