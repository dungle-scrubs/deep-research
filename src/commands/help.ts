import { fail, type HandlerResult, ok } from "../envelope.js";
import { isStepName, STEP_ORDER, STEPS, type StepName } from "../steps.js";
import { promptForStep } from "./next.js";

function pipelineOverview(): string {
  const lines = STEP_ORDER.map((name: StepName, index) => {
    const meta = STEPS[name];
    return `${index + 1}. ${name} (${meta.kind}): ${meta.summary}`;
  });
  return (
    "dr - deterministic deep-research pipeline. The caller supplies intelligence; " +
    "the CLI holds state, validates, and gates.\n\n" +
    "Pipeline (linear, exactly one takeable step at a time):\n" +
    `${lines.join("\n")}\n\n` +
    "Commands: dr new <topic> [--root <dir>] | dr next | dr fulfill <step> <file> | " +
    "dr citations [--format json] | dr retry-fetch | dr status | dr help [<step>]\n" +
    "Every command accepts --json (envelope {ok, run, step, errors[]}). " +
    "Exit codes: 0 ok, 1 usage, 2 gate/validation, 3 nothing takeable, 4 internal."
  );
}

function stepHelp(runDir: string | null, step: StepName): HandlerResult {
  const meta = STEPS[step];
  let promptNote = "No prompt template for this step.";
  if (meta.template && runDir) {
    try {
      promptNote = `Prompt (run copy prompts/${meta.template}):\n${promptForStep(runDir, step)}`;
    } catch {
      promptNote = `Prompt: run has no copy yet (prompts/${meta.template} missing).`;
    }
  } else if (meta.template) {
    promptNote = `Prompt template: templates/${meta.template} (copied to prompts/ at dr new).`;
  }
  const human =
    `Step: ${step} (${meta.kind}; output ${meta.output})\n` +
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
      })),
    });
  }
  const trimmed = rawStep.trim();
  const found: StepName | null = isStepName(trimmed) ? trimmed : null;
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
