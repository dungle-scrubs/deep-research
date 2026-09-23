import * as fs from "node:fs";
import * as path from "node:path";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { runLayout } from "../rundir.js";
import { STEPS } from "../steps.js";
import { errorMessage } from "../util.js";
import { loadStateOrFail } from "./shared.js";

export function promptForStep(runDir: string, step: keyof typeof STEPS): string {
  const meta = STEPS[step];
  if (!meta.template) return "";
  return fs.readFileSync(path.join(runLayout(runDir).promptsDir, meta.template), "utf8");
}

export function cmdNext(runDir: string): HandlerResult {
  const loaded = loadStateOrFail(runDir, null);
  if ("result" in loaded) return loaded.result;
  const state = loaded.state;
  if (state.step === "done") {
    return fail(
      3,
      runDir,
      "done",
      ["E301: nothing takeable; run is done"],
      "Nothing takeable: run is done.",
    );
  }
  // CLI steps never reach this function: dr next executes them directly.
  const meta = STEPS[state.step];
  let prompt = "";
  try {
    prompt = promptForStep(runDir, state.step);
  } catch (error) {
    return fail(4, runDir, state.step, [`E401: cannot read prompt copy: ${errorMessage(error)}`]);
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
