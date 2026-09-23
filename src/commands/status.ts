import { fail, type HandlerResult, ok } from "../envelope.js";
import { type RunState, readState } from "../state.js";
import { STEP_ORDER, STEPS, type StepName } from "../steps.js";

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
  const human =
    `Run: ${runDir}\n` +
    `Topic: ${state.topic}\n` +
    `Current step: ${state.step}\n` +
    `Completed: ${state.completed.length > 0 ? state.completed.join(" -> ") : "(none)"}\n` +
    `Coverage: ticket #11 tracks prose steps only; claim/matrix counts arrive in ticket #13.\n` +
    `Unreachable: not tracked yet (fetch step arrives in ticket #12).`;
  return ok(runDir, state.step, human, {
    completed: [...state.completed],
    coverage: { note: "claim/matrix counts arrive in ticket #13" },
    created: state.created,
    current: state.step,
    steps,
    topic: state.topic,
    unreachable: 0,
  });
}
