import { describe, expect, it } from "vitest";
import { slugify } from "../src/run.js";
import { extractGapsQuestions, hasUrl, parsesAsMarkdown, validateProse } from "../src/validate.js";

describe("validateProse", () => {
  it("accepts a minimal brief", () => {
    expect(validateProse("brief", "# Brief\n\nSome context.\n")).toEqual([]);
  });

  it("flags empty files", () => {
    expect(validateProse("brief", "   \n")).toHaveLength(1);
  });

  it("requires URLs on foundation and followup", () => {
    expect(validateProse("foundation", "# F\n\nText.\n")[0]).toContain("no URLs");
    expect(validateProse("followup", "# F\n\nText.\n")[0]).toContain("no URLs");
    expect(validateProse("brief", "# B\n\nText.\n")).toEqual([]);
  });

  it("detects URLs in markdown links and bare form", () => {
    expect(hasUrl("[label](https://example.com/x)")).toBe(true);
    expect(hasUrl("see https://example.com for more")).toBe(true);
    expect(hasUrl("no links here")).toBe(false);
  });

  it("parses ordinary markdown", () => {
    expect(parsesAsMarkdown("# Title\n\n- a\n- b\n")).toBe(true);
  });
});

describe("extractGapsQuestions", () => {
  it("reads a single fenced list", () => {
    const text = `# G\n\n\`\`\`json\n["a?", "b?"]\n\`\`\`\n`;
    const { errors, questions } = extractGapsQuestions(text);
    expect(errors).toEqual([]);
    expect(questions).toEqual(["a?", "b?"]);
  });

  it("requires exactly one block", () => {
    expect(extractGapsQuestions("no block").errors).toHaveLength(1);
    const two = '```json\n["a"]\n```\n\n```json\n["b"]\n```\n';
    expect(extractGapsQuestions(two).errors[0]).toContain("exactly one");
  });

  it("rejects non-array JSON", () => {
    const { errors } = extractGapsQuestions("```json\n{}\n```\n");
    expect(errors[0]).toContain("array");
  });

  it("rejects empty and blank questions", () => {
    expect(extractGapsQuestions("```json\n[]\n```\n").errors[0]).toContain("at least one");
    const { errors } = extractGapsQuestions('```json\n["ok?", "  "]\n```\n');
    expect(errors[0]).toContain("question 2");
  });
});

describe("slugify", () => {
  it("lowercases and dashes", () => {
    expect(slugify("Burnout in Early Childhood Educators!")).toBe(
      "burnout-in-early-childhood-educators",
    );
  });

  it("falls back for punctuation-only topics", () => {
    expect(slugify("!!!")).toBe("run");
  });
});
