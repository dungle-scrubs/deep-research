import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_ORDER, STEPS } from "../src/steps.js";

// The skill file and the binary share the per-step intelligence table.
// steps.ts is the source of truth (dr help emits from it); this test
// fails when the skill copy drifts.
const skill = fs.readFileSync(
  path.resolve(__dirname, "..", "skills", "deep-research", "SKILL.md"),
  "utf8",
);

describe("skill/binary drift", () => {
  it("keeps the quote contract in the verdict prompt and skill", () => {
    const prompt = fs.readFileSync(
      path.resolve(__dirname, "..", "templates", "verdict.md"),
      "utf8",
    );
    for (const document of [prompt, skill]) {
      expect(document).toContain("`quote`");
      expect(document).toContain("at least 16");
      expect(document).toContain("contiguous substring");
      expect(document).toContain("tokens");
      expect(document).toContain("order");
      expect(document.toLowerCase()).toContain("gaps");
      expect(document).toContain("entailment");
      for (const status of ["unreachable", "robots-blocked", "paywalled", "binary-unreadable"]) {
        expect(document).toContain(`\`${status}\``);
      }
    }
  });

  for (const step of STEP_ORDER) {
    const meta = STEPS[step];
    if (meta.modelQuery === null) continue; // not in the skill's table by design
    it(`${step}: skill carries the binary's query and plain line`, () => {
      expect(skill).toContain(meta.modelQuery);
      expect(skill).toContain(meta.plainLine.split("\n")[0] ?? meta.plainLine);
    });
  }
});
