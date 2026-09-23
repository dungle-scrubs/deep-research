import * as fs from "node:fs";
import * as path from "node:path";
import { marked } from "marked";
import { z } from "zod";

export interface ProseCheck {
  readonly name: string;
  readonly error: string;
}

const URL_PATTERN = /https?:\/\/[^\s)>\]]+/;

export function hasUrl(text: string): boolean {
  return URL_PATTERN.test(text);
}

export function parsesAsMarkdown(text: string): boolean {
  try {
    const tokens = marked.lexer(text);
    // Empty token stream means the parser found no structure at all.
    return tokens.length > 0;
  } catch {
    return false;
  }
}

export interface GapsQuestionList {
  readonly questions: readonly string[];
  readonly errors: readonly string[];
}

const FENCED_JSON_PATTERN = /```json\s*\n([\s\S]*?)\n```/;

/** Extract the gaps question list: exactly one fenced json block that
 *  parses to an array of non-empty strings. */
export function extractGapsQuestions(text: string): GapsQuestionList {
  const matches = [...text.matchAll(new RegExp(FENCED_JSON_PATTERN.source, "g"))];
  if (matches.length === 0) {
    return {
      errors: ["no fenced ```json block found; add one containing the follow-up question list"],
      questions: [],
    };
  }
  if (matches.length > 1) {
    return {
      errors: [
        `found ${matches.length} fenced \`\`\`json blocks; keep exactly one with the question list`,
      ],
      questions: [],
    };
  }
  const block = matches[0]?.[1] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { errors: [`question list is not valid JSON: ${message}`], questions: [] };
  }
  // Zod is the validation library: the question list parses here, and the
  // claims/verdict schemas in tickets #12-#13 build on the same library.
  const listSchema = z.array(z.string().trim().min(1)).min(1);
  const result = listSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const index = typeof issue.path[0] === "number" ? issue.path[0] + 1 : null;
      if (index !== null) return `question ${index} must be a non-empty string`;
      if (issue.code === "too_small") {
        return "question list must contain at least one question";
      }
      return `question list ${issue.message.toLowerCase()}`;
    });
    return { errors: problems, questions: [] };
  }
  return { errors: [], questions: result.data };
}

export type ProseStep = "brief" | "foundation" | "gaps" | "followup";

const REQUIRES_URLS: Record<ProseStep, boolean> = {
  brief: false,
  followup: true,
  foundation: true,
  gaps: false,
};

/** Structural validation for prose steps. Returns one error per failed
 *  check; an empty array means the file is acceptable. */
export function validateProse(step: ProseStep, text: string): readonly string[] {
  const errors: string[] = [];
  if (text.trim().length === 0) {
    errors.push(`${step}: file is empty; write the step output before fulfilling`);
    return errors;
  }
  if (!parsesAsMarkdown(text)) {
    errors.push(`${step}: file does not parse as markdown`);
  }
  if (REQUIRES_URLS[step] && !hasUrl(text)) {
    errors.push(`${step}: no URLs found; every factual claim needs its source URL`);
  }
  if (step === "gaps") {
    const { errors: questionErrors } = extractGapsQuestions(text);
    for (const problem of questionErrors) errors.push(`gaps: ${problem}`);
  }
  return errors;
}

export function readTextFile(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}
