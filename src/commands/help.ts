import * as fs from "node:fs";
import * as path from "node:path";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { STEP_ORDER, STEPS, type StepName } from "../steps.js";

function pipelineOverview(): string {
  const lines = STEP_ORDER.map((name: StepName, index) => {
    const meta = STEPS[name];
    return `${index + 1}. ${name} (${meta.kind}, ticket #${meta.ticket}): ${meta.summary}`;
  });
  return (
    "dr - deterministic deep-research pipeline. The caller supplies intelligence; " +
    "the CLI holds state, validates, and gates.\n\n" +
    "Pipeline (linear, exactly one takeable step at a time):\n" +
    `${lines.join("\n")}\n\n` +
    "Commands: dr new <topic> [--root <dir>] | dr next | dr fulfill <step> <file> | " +
    "dr status | dr help [<step>]\n" +
    "Every command accepts --json (envelope {ok, run, step, errors[]}). " +
    "Exit codes: 0 ok, 1 usage, 2 gate/validation, 3 nothing takeable, 4 internal."
  );
}

function stepHelp(runDir: string | null, step: StepName): HandlerResult {
  const meta = STEPS[step];
  let promptNote = `Template ships in ticket #${meta.ticket}.`;
  if (meta.template && runDir) {
    try {
      const prompt = fs.readFileSync(path.join(runDir, "prompts", meta.template), "utf8");
      promptNote = `Prompt (run copy prompts/${meta.template}):\n${prompt}`;
    } catch {
      promptNote = `Prompt: run has no copy yet (prompts/${meta.template} missing).`;
    }
  } else if (meta.template) {
    promptNote = `Prompt template: templates/${meta.template} (copied to prompts/ at dr new).`;
  }
  const human =
    `Step: ${step} (${meta.kind}; output ${meta.output}; ticket #${meta.ticket})\n` +
    `Purpose: ${meta.summary}\n` +
    `Good output: ${meta.goodOutput}\n` +
    `Recommended intelligence: ${meta.modelQuery ?? "none - CLI or caller-authored step"}${meta.modelQuery ? `\nPlain language: ${meta.plainLine}` : `\nNote: ${meta.plainLine}`}\n` +
    `${promptNote}`;
  return ok(runDir, step, human, {
    goodOutput: meta.goodOutput,
    kind: meta.kind,
    modelQuery: meta.modelQuery,
    output: meta.output,
    plainLine: meta.plainLine,
    summary: meta.summary,
    template: meta.template,
    ticket: meta.ticket,
  });
}

export function cmdHelp(runDir: string | null, rawStep?: string): HandlerResult {
  if (!rawStep) {
    return ok(runDir, null, pipelineOverview(), {
      steps: STEP_ORDER.map((name: StepName) => ({
        kind: STEPS[name].kind,
        name,
        output: STEPS[name].output,
        summary: STEPS[name].summary,
        ticket: STEPS[name].ticket,
      })),
    });
  }
  const trimmed = rawStep.trim();
  const found = STEP_ORDER.find((name) => name === trimmed);
  if (!found) {
    return fail(
      1,
      runDir,
      null,
      [`E103: unknown step ${trimmed}; usage: dr help [<step>]`],
      `Unknown step: ${trimmed}.\nSteps: ${STEP_ORDER.join(", ")}.`,
    );
  }
  return stepHelp(runDir, found);
}
