import * as fs from "node:fs";
import { CLAIM_ID_PATTERN, type Claim, type ClaimsFile } from "./claims.js";
import { runLayout } from "./rundir.js";
import { hasUrl } from "./validate.js";
import type { Matrix } from "./verdicts.js";

const REQUIRED_SECTIONS = [
  "Question",
  "Verified findings",
  "Single-source findings",
  "Conflicts",
  "Gaps and uncertainty",
  "Practical implications",
  "Evidence table",
  "Discarded claims",
] as const;

export interface Section {
  readonly heading: string;
  readonly body: string;
}

export function splitSections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current) sections.push({ body: current.body.join("\n"), heading: current.heading });
      current = { body: [], heading: match[1] ?? "" };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push({ body: current.body.join("\n"), heading: current.heading });
  return sections;
}

/** Parse markdown table rows (| a | b | c |) from a section body. */
export function parseTable(body: string): string[][] {
  const rows: string[][] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // separator row
    rows.push(cells);
  }
  return rows;
}

export interface GateViolation {
  readonly message: string;
  readonly fixableAt: string;
}

/** The report structure gate: sections, evidence table, discarded list.
 *  Violations name the step that can fix them (always synthesis). */
export function gateReport(report: string, matrix: Matrix): readonly GateViolation[] {
  const violations: GateViolation[] = [];
  const fixable = "synthesis";
  const sections = splitSections(report);
  const headings = new Set(sections.map((section) => section.heading.toLowerCase()));

  for (const required of REQUIRED_SECTIONS) {
    if (!headings.has(required.toLowerCase())) {
      violations.push({ fixableAt: fixable, message: `missing required section: ## ${required}` });
    }
  }
  if (violations.length > 0) return violations; // no point checking tables without sections

  const evidence = sections.find((section) => section.heading.toLowerCase() === "evidence table");
  const discarded = sections.find(
    (section) => section.heading.toLowerCase() === "discarded claims",
  );
  const evidenceRows = evidence ? parseTable(evidence.body) : [];
  const header = (evidenceRows[0] ?? []).map((cell) => cell.toLowerCase());
  const hasHeader = header[0] === "claim" && header[2] === "status";
  if (!hasHeader) {
    violations.push({
      fixableAt: fixable,
      message: "evidence table needs a header row: | Claim | Citation | Status |",
    });
  }
  const bodyRows = evidenceRows.slice(hasHeader ? 1 : 0);

  const rowForClaim = new Map<string, string[]>();
  for (const row of bodyRows) {
    const id = row[0] ?? "";
    if (CLAIM_ID_PATTERN.test(id)) rowForClaim.set(id, row);
  }
  const discardedText = (discarded?.body ?? "").toLowerCase();

  for (const claim of matrix.claims) {
    const row = rowForClaim.get(claim.id);
    if (["verified", "single-source", "conflict"].includes(claim.status)) {
      if (!row) {
        violations.push({
          fixableAt: fixable,
          message: `claim ${claim.id} (${claim.status}) is used but has no evidence table row`,
        });
        continue;
      }
      const statusCell = (row[2] ?? "").toLowerCase();
      if (statusCell !== claim.status) {
        violations.push({
          fixableAt: fixable,
          message: `claim ${claim.id}: evidence table status "${row[2] ?? ""}" does not match matrix status "${claim.status}"`,
        });
      }
      const citationCell = row[1] ?? "";
      if (!hasUrl(citationCell) && citationCell.length === 0) {
        violations.push({
          fixableAt: fixable,
          message: `claim ${claim.id}: evidence table citation cell is empty`,
        });
      }
    }
    if (row && claim.citations.some((citation) => citation.verdict === "skipped")) {
      const rowText = row.join(" ").toLowerCase();
      if (!rowText.includes("skipped") || !rowText.includes("source-not-checked")) {
        violations.push({
          fixableAt: fixable,
          message: `claim ${claim.id}: skipped citation used without the skipped/source-not-checked caveat`,
        });
      }
    }
    if (claim.status === "unreachable" && row) {
      const rowText = row.join(" ").toLowerCase();
      if (!rowText.includes("source-not-checked")) {
        violations.push({
          fixableAt: fixable,
          message: `claim ${claim.id}: unreachable claim used without the source-not-checked caveat`,
        });
      }
    }
    if (["misrepresented", "not-found"].includes(claim.status)) {
      if (!discardedText.includes(claim.id.toLowerCase())) {
        violations.push({
          fixableAt: fixable,
          message: `claim ${claim.id} (${claim.status}) must be listed under Discarded claims`,
        });
      }
    }
  }
  return violations;
}

/** Briefing coverage check: the template's Coverage block must echo the
 *  matrix counts exactly (one `status: n` line per non-zero status). */
export function checkBriefingCoverage(briefing: string, matrix: Matrix): readonly string[] {
  const problems: string[] = [];
  const sections = splitSections(briefing);
  const coverage = sections.find((section) => section.heading.toLowerCase() === "coverage");
  if (!coverage) {
    return ["briefing: missing the Coverage section required by the template"];
  }
  const claimed = new Map<string, number>();
  for (const line of coverage.body.split(/\r?\n/)) {
    const match = /^([a-z-]+):\s*(\d+)\s*$/.exec(line.trim());
    if (match) {
      const status = match[1] ?? "";
      claimed.set(status, Number(match[2] ?? 0));
    }
  }
  const actual = new Map<string, number>();
  for (const claim of matrix.claims) {
    actual.set(claim.status, (actual.get(claim.status) ?? 0) + 1);
  }
  const keys = new Set([...claimed.keys(), ...actual.keys()]);
  for (const key of keys) {
    const expected = actual.get(key) ?? 0;
    const stated = claimed.get(key) ?? 0;
    if (expected !== stated) {
      problems.push(`briefing: coverage says ${key}: ${stated}, matrix says ${key}: ${expected}`);
    }
  }
  return problems;
}

/** Generate sources.md from claims.json: one section per tier, one line
 *  per distinct document. */
export function generateSources(claims: ClaimsFile): string {
  const byTier = new Map<number, Claim[]>();
  for (const claim of claims) {
    const list = byTier.get(claim.tier) ?? [];
    list.push(claim);
    byTier.set(claim.tier, list);
  }
  const lines: string[] = ["# Sources", ""];
  const tierNames: Record<number, string> = {
    1: "Tier 1 - meta-analysis, systematic review, official statistics",
    2: "Tier 2 - RCT, large study, government report",
    3: "Tier 3 - case study, industry report, news",
  };
  for (const tier of [1, 2, 3]) {
    lines.push(`## ${tierNames[tier] ?? `Tier ${tier}`}`, "");
    const tierClaims = byTier.get(tier) ?? [];
    if (tierClaims.length === 0) {
      lines.push("_(none)_", "");
      continue;
    }
    const seen = new Set<string>();
    for (const claim of tierClaims) {
      for (const citation of claim.citations) {
        if (seen.has(citation.url)) continue;
        seen.add(citation.url);
        lines.push(`- ${citation.title} - ${citation.url}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function readMatrixFile(runDir: string): Matrix {
  return JSON.parse(fs.readFileSync(runLayout(runDir).matrixFile, "utf8")) as Matrix;
}

export function readClaimsFile(runDir: string): ClaimsFile {
  const raw = fs.readFileSync(runLayout(runDir).step("claims.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("claims.json is not an array");
  return parsed as ClaimsFile;
}
