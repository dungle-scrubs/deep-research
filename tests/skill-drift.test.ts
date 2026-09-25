import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cmdHelp } from "../src/commands/help.js";
import { driveConfigTemplate } from "../src/drive-config.js";
import { STEP_ORDER, STEPS } from "../src/steps.js";

// steps.ts is the source of truth (dr help emits from it). Pin the
// in-session checklist in SKILL.md and the routing table in routing.md
// to each step, so text in a different row cannot hide a missing entry.
const skill = fs.readFileSync(
  path.resolve(__dirname, "..", "skills", "deep-research", "SKILL.md"),
  "utf8",
);
const routing = fs.readFileSync(
  path.resolve(__dirname, "..", "skills", "deep-research", "routing.md"),
  "utf8",
);

describe("skill/binary drift", () => {
  it("documents the agent loop and drive for non-agent callers without a second routing table", () => {
    const readme = fs.readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
    for (const document of [readme, skill, cmdHelp(null).human]) {
      expect(document).toContain("agent loop");
      expect(document).toContain("non-agent callers");
      expect(document).toContain("dr drive --help");
    }
    expect(driveConfigTemplate()).toMatchObject({
      policy: { minDistinctCitations: 2 },
      limits: { maxAttemptsPerWorkItem: 3, maxWorkItems: 1000 },
      verdicts: { lanes: 2, claimsPerBatch: 20 },
    });
  });
  it("documents the same scraper install command in help, README, and skill", () => {
    const readme = fs.readFileSync(path.resolve(__dirname, "../README.md"), "utf8");
    for (const document of [readme, skill, STEPS.fetch.summary]) {
      expect(document).toContain("pipx install dungle-scrubs-scraper");
    }
  });
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
      expect(document).toContain("three times");
      expect(document.toLowerCase()).toContain("gaps");
      expect(document).toContain("entailment");
      for (const status of ["unreachable", "robots-blocked", "paywalled", "binary-unreadable"]) {
        expect(document).toContain(`\`${status}\``);
      }
    }
  });

  it("links routing callers and secret-material runs to the routing document", () => {
    expect(skill).toMatch(
      /Routing callers, or any caller handling secret material:.*\[routing\.md\]\(routing\.md\)/,
    );
  });

  for (const step of STEP_ORDER) {
    const meta = STEPS[step];
    if (meta.modelQuery === null) continue; // caller-authored/CLI-only steps have no routing row
    it(`${step}: skill carries the binary's plain line without routing queries`, () => {
      const rows = skill.split("\n").filter((line) => line.startsWith(`| ${step} |`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain(meta.plainLine);
      expect(skill).not.toContain(meta.modelQuery);
    });
    it(`${step}: routing carries the binary's query and plain line`, () => {
      const rows = routing.split("\n").filter((line) => line.startsWith(`| ${step} |`));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain(meta.modelQuery);
      expect(rows[0]).toContain(meta.plainLine);
    });
  }
});
