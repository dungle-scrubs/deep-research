import * as fs from "node:fs";
import { runLayout } from "./rundir.js";
import { STEP_ORDER, STEPS, type StepName } from "./steps.js";
import { readTemplates } from "./templates.js";

export const TOPIC_SLOT = "{{TOPIC}}";
export const QUESTIONS_SLOT = "{{QUESTIONS}}";

/** Steps that ship a prompt template (STEPS[name].template != null). */
export type TemplateStep = Exclude<StepName, "fetch" | "finalize">;
const TEMPLATE_STEPS: readonly TemplateStep[] = STEP_ORDER.filter(
  (step): step is TemplateStep => step !== "fetch" && step !== "finalize",
);

function templateName(step: TemplateStep): string {
  return STEPS[step].template?.replace(/\.md$/, "") ?? step;
}

export function substituteTopic(template: string, topic: string): string {
  return template.replaceAll(TOPIC_SLOT, topic);
}

export function substituteQuestions(template: string, questions: readonly string[]): string {
  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return template.replaceAll(QUESTIONS_SLOT, numbered);
}

/** Render every prose prompt for a new run. Gaps questions are not known
 *  yet at creation time, so the follow-up copy keeps the {{QUESTIONS}}
 *  slot; `dr next` fills it once the gaps step is fulfilled. */
export function renderAllPrompts(topic: string): Record<TemplateStep, string> {
  const files = readTemplates(TEMPLATE_STEPS.map(templateName));
  const rendered = {} as Record<TemplateStep, string>;
  for (const step of TEMPLATE_STEPS) {
    const template = files.get(templateName(step));
    if (template === undefined) throw new Error(`missing template for ${step}`);
    rendered[step] = substituteTopic(template, topic);
  }
  return rendered;
}

/** Fill the run's follow-up prompt copy with the gaps question list. */
export function renderFollowupWithQuestions(
  followupCopy: string,
  topic: string,
  questions: readonly string[],
): string {
  return substituteQuestions(substituteTopic(followupCopy, topic), questions);
}

export function writePrompts(runDir: string, topic: string): void {
  const rendered = renderAllPrompts(topic);
  const layout = runLayout(runDir);
  fs.mkdirSync(layout.promptsDir, { recursive: true });
  for (const step of TEMPLATE_STEPS) {
    fs.writeFileSync(layout.prompt(templateName(step)), rendered[step], "utf8");
  }
}
