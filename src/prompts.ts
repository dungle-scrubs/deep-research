import * as fs from "node:fs";
import * as path from "node:path";
import { readTemplate } from "./templates.js";

export const TOPIC_SLOT = "{{TOPIC}}";
export const QUESTIONS_SLOT = "{{QUESTIONS}}";

const STEPS_WITH_TOPIC = [
  "brief",
  "extraction",
  "foundation",
  "followup",
  "gaps",
  "verdict",
] as const;
export type TemplateStep = (typeof STEPS_WITH_TOPIC)[number];

export function substituteTopic(template: string, topic: string): string {
  return template.split(TOPIC_SLOT).join(topic);
}

export function substituteQuestions(template: string, questions: readonly string[]): string {
  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return template.split(QUESTIONS_SLOT).join(numbered);
}

/** Render every prose prompt for a new run. Gaps questions are not known
 *  yet at creation time, so the follow-up copy keeps the {{QUESTIONS}}
 *  slot; `dr next` fills it once the gaps step is fulfilled. */
export function renderAllPrompts(topic: string): Record<TemplateStep, string> {
  return {
    brief: substituteTopic(readTemplate("brief"), topic),
    extraction: substituteTopic(readTemplate("extraction"), topic),
    foundation: substituteTopic(readTemplate("foundation"), topic),
    followup: substituteTopic(readTemplate("followup"), topic),
    gaps: substituteTopic(readTemplate("gaps"), topic),
    verdict: substituteTopic(readTemplate("verdict"), topic),
  };
}

/** Fill the run's follow-up prompt copy with the gaps question list. */
export function renderFollowupWithQuestions(
  followupCopy: string,
  topic: string,
  questions: readonly string[],
): string {
  // Topic is already substituted in the stored copy, but substitute again
  // defensively in case a run was created by an older version.
  return substituteQuestions(substituteTopic(followupCopy, topic), questions);
}

export function writePrompts(runDir: string, topic: string): void {
  const rendered = renderAllPrompts(topic);
  const dir = path.join(runDir, "prompts");
  fs.mkdirSync(dir, { recursive: true });
  for (const [step, text] of Object.entries(rendered)) {
    fs.writeFileSync(path.join(dir, `${step}.md`), text, "utf8");
  }
}
