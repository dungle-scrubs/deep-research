import * as fs from "node:fs";
import * as path from "node:path";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { type RunState, readState } from "../state.js";
import { STEPS } from "../steps.js";

export function promptForStep(runDir: string, step: keyof typeof STEPS): string {
  const meta = STEPS[step];
  if (!meta.template) return "";
  return fs.readFileSync(path.join(runDir, "prompts", meta.template), "utf8");
}

export function cmdNext(runDir: string): HandlerResult {
  let state: RunState;
  try {
    state = readState(runDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(4, runDir, null, [`E401: cannot read run state: ${message}`]);
  }
  if (state.step === "done") {
    return fail(
      3,
      runDir,
      "done",
      ["E301: nothing takeable; run is done"],
      "Nothing takeable: run is done.",
    );
  }
  const meta = STEPS[state.step];
  // Ticket #11 owns the four prose steps. Every later step - caller or CLI -
  // is named here with its owning ticket instead of executing.
  if (meta.ticket !== 11) {
    return fail(
      2,
      runDir,
      state.step,
      [
        `E206: step ${state.step} is owned by ticket #${meta.ticket}; ` +
          `it is not executable in ticket #11 yet`,
      ],
      `Step ${state.step} is owned by ticket #${meta.ticket}; not executable yet.`,
    );
  }
  let prompt = "";
  try {
    prompt = promptForStep(runDir, state.step);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(4, runDir, state.step, [`E401: cannot read prompt copy: ${message}`]);
  }
  const human =
    `Takeable step: ${state.step}\n` +
    `Summary: ${meta.summary}\n` +
    `Write output to: ${meta.output} (then: dr fulfill ${state.step} <file>)\n` +
    `Help: dr help ${state.step}\n` +
    `--- prompt (prompts/${meta.template}) ---\n${prompt}`;
  return ok(runDir, state.step, human, {
    kind: meta.kind,
    output: meta.output,
    prompt,
    summary: meta.summary,
  });
}
