import { describe, expect, it } from "vitest";
import {
  type GateViolation,
  gateReport,
  generateSources,
  parseTable,
  splitSections,
} from "../src/report.js";
import type { Matrix, MatrixClaim } from "../src/verdicts.js";

function matrixClaim(overrides: Partial<MatrixClaim>): MatrixClaim {
  return {
    citations: [],
    id: "c001",
    statement: "A statement.",
    status: "verified",
    tier: 2,
    ...overrides,
  };
}

function matrix(claims: readonly MatrixClaim[]): Matrix {
  return { caveats: [], claims, coverage: {}, derivedAt: "2026-01-01T00:00:00Z", version: 1 };
}

function report(rows: readonly string[], discarded = "None."): string {
  return [
    "# Report",
    "",
    "## Question",
    "What?",
    "",
    "## Verified findings",
    "Text.",
    "",
    "## Single-source findings",
    "None.",
    "",
    "## Conflicts",
    "None.",
    "",
    "## Gaps and uncertainty",
    "Some.",
    "",
    "## Practical implications",
    "Some.",
    "",
    "## Evidence table",
    "",
    "| Claim | Citation | Status |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "## Discarded claims",
    "",
    discarded,
  ].join("\n");
}

function messages(violations: readonly GateViolation[]): string[] {
  return violations.map((violation) => violation.message);
}

describe("gateReport", () => {
  it("passes a status-mirrored report", () => {
    const m = matrix([matrixClaim({})]);
    expect(gateReport(report(["| c001 | https://a.example/x | verified |"]), m)).toEqual([]);
  });

  it("fails on a missing section", () => {
    const missing = report(["| c001 | https://a.example/x | verified |"]).replace(
      "## Conflicts\nNone.\n\n",
      "",
    );
    const violations = gateReport(missing, matrix([matrixClaim({})]));
    expect(messages(violations)).toEqual(["missing required section: ## Conflicts"]);
  });

  it("fails when a used claim has no evidence row", () => {
    const violations = gateReport(report([]), matrix([matrixClaim({})]));
    expect(messages(violations)[0]).toContain("c001");
    expect(messages(violations)[0]).toContain("no evidence table row");
  });

  it("fails on a status mismatch with the matrix", () => {
    const violations = gateReport(
      report(["| c001 | https://a.example/x | single-source |"]),
      matrix([matrixClaim({})]),
    );
    expect(messages(violations)[0]).toContain('does not match matrix status "verified"');
  });

  it("fails when an unreachable claim lacks the caveat", () => {
    const violations = gateReport(
      report(["| c001 | https://a.example/x | unreachable |"]),
      matrix([matrixClaim({ status: "unreachable" })]),
    );
    expect(messages(violations)[0]).toContain("source-not-checked");
  });

  it("fails when a discarded claim is missing from the appendix", () => {
    const violations = gateReport(report([]), matrix([matrixClaim({ status: "misrepresented" })]));
    expect(messages(violations)[0]).toContain("Discarded claims");
  });

  it("passes when discarded claims are listed by id", () => {
    const violations = gateReport(
      report([], "- c002 misrepresented: sources state the opposite"),
      matrix([matrixClaim({ id: "c002", status: "misrepresented" })]),
    );
    expect(violations).toEqual([]);
  });
});

describe("generateSources", () => {
  it("renders one section per tier with distinct documents", () => {
    const text = generateSources([
      {
        citations: [
          { locator: "p1", title: "Wang 2020", url: "https://a.example/x" },
          { locator: "p2", title: "Wang 2020 mirror", url: "https://a.example/x" },
        ],
        flags: [],
        id: "c001",
        notes: "",
        statement: "s",
        tier: 1,
      },
      {
        citations: [{ locator: "p1", title: "News piece", url: "https://b.example/n" }],
        flags: [],
        id: "c002",
        notes: "",
        statement: "s",
        tier: 3,
      },
    ]);
    expect(text).toContain("## Tier 1 - meta-analysis, systematic review, official statistics");
    expect(text).toContain("## Tier 2 - RCT, large study, government report");
    expect(text).toContain("_(none)_");
    expect(text.match(/https:\/\/a\.example\/x/g)).toHaveLength(1);
    expect(text).toContain("News piece - https://b.example/n");
  });
});

describe("markdown helpers", () => {
  it("splits h2 sections", () => {
    const sections = splitSections("# T\n\n## A\none\n\n## B\ntwo");
    expect(sections.map((section) => section.heading)).toEqual(["A", "B"]);
    expect(sections[0]?.body).toContain("one");
  });

  it("parses table rows and skips separators", () => {
    const rows = parseTable(
      "| Claim | Citation | Status |\n| --- | --- | --- |\n| c001 | u | ok |",
    );
    expect(rows).toEqual([
      ["Claim", "Citation", "Status"],
      ["c001", "u", "ok"],
    ]);
  });
});
