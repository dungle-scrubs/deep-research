import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Claim } from "../src/claims.js";
import { type LedgerEntry, writeLedger } from "../src/fetch.js";
import { DocumentSet, deriveMatrix, validateVerdicts } from "../src/verdicts.js";

let runDir: string;

function claim(overrides: Partial<Claim>): Claim {
  return {
    citations: [
      { locator: "p1", title: "A", url: "https://a.example/x" },
      { locator: "p2", title: "B", url: "https://b.example/y" },
    ],
    flags: [],
    id: "c001",
    notes: "",
    statement: "A statement.",
    tier: 2,
    ...overrides,
  };
}

function ledgerEntry(url: string, status: string): LedgerEntry {
  return {
    attempts: 1,
    bytes: 1,
    contentType: "text/html",
    fetchedAt: "2026-01-01T00:00:00Z",
    finalUrl: url,
    hash: "h",
    normalized: url,
    reason: null,
    status: status as LedgerEntry["status"],
    url,
  };
}

function verdict(entries: Record<string, unknown>[]) {
  return entries.map((entry) => ({ note: "", ...entry }));
}

beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-derive-"));
});

afterEach(() => {
  fs.rmSync(runDir, { recursive: true, force: true });
});

describe("status derivation rules", () => {
  it("2+ distinct supported documents -> verified", () => {
    writeLedger(runDir, [
      ledgerEntry("https://a.example/x", "ok"),
      ledgerEntry("https://b.example/y", "ok"),
    ]);
    const matrix = deriveMatrix(
      [claim({})],
      verdict([
        { claimId: "c001", url: "https://a.example/x", verdict: "supported" },
        { claimId: "c001", url: "https://b.example/y", verdict: "supported" },
      ]),
      runDir,
      "2026-01-01T00:00:00Z",
    );
    expect(matrix.claims[0]?.status).toBe("verified");
  });

  it("exactly 1 supported document -> single-source", () => {
    writeLedger(runDir, [
      ledgerEntry("https://a.example/x", "ok"),
      ledgerEntry("https://b.example/y", "ok"),
    ]);
    const matrix = deriveMatrix(
      [claim({})],
      verdict([
        { claimId: "c001", url: "https://a.example/x", verdict: "supported" },
        { claimId: "c001", url: "https://b.example/y", verdict: "partial" },
      ]),
      runDir,
      "2026-01-01T00:00:00Z",
    );
    expect(matrix.claims[0]?.status).toBe("single-source");
    // partial recorded in the matrix even though it counts as no support
    expect(matrix.claims[0]?.citations[1]?.verdict).toBe("partial");
  });

  it("same URL cited twice is one document -> single-source", () => {
    const twice = claim({
      citations: [
        { locator: "p1", title: "A", url: "https://a.example/x" },
        { locator: "p2", title: "A2", url: "https://a.example/x?utm_source=s" },
      ],
    });
    writeLedger(runDir, [ledgerEntry("https://a.example/x", "ok")]);
    const matrix = deriveMatrix(
      [twice],
      verdict([
        { claimId: "c001", url: "https://a.example/x", verdict: "supported" },
        { claimId: "c001", url: "https://a.example/x?utm_source=s", verdict: "supported" },
      ]),
      runDir,
      "2026-01-01T00:00:00Z",
    );
    expect(matrix.claims[0]?.status).toBe("single-source");
  });

  it("sameStudyAs merges two URLs into one document", () => {
    const linked = claim({
      citations: [
        {
          locator: "p1",
          sameStudyAs: "https://b.example/y",
          title: "A",
          url: "https://a.example/x",
        },
        { locator: "p2", title: "B", url: "https://b.example/y" },
      ],
    });
    writeLedger(runDir, [
      ledgerEntry("https://a.example/x", "ok"),
      ledgerEntry("https://b.example/y", "ok"),
    ]);
    const matrix = deriveMatrix(
      [linked],
      verdict([
        { claimId: "c001", url: "https://a.example/x", verdict: "supported" },
        { claimId: "c001", url: "https://b.example/y", verdict: "supported" },
      ]),
      runDir,
      "2026-01-01T00:00:00Z",
    );
    expect(matrix.claims[0]?.status).toBe("single-source");
  });

  it("none supported + contradicts -> misrepresented", () => {
    writeLedger(runDir, [
      ledgerEntry("https://a.example/x", "ok"),
      ledgerEntry("https://b.example/y", "ok"),
    ]);
    const matrix = deriveMatrix(
      [claim({})],
      verdict([{ claimId: "c001", url: "https://a.example/x", verdict: "contradicts" }]),
      runDir,
      "2026-01-01T00:00:00Z",
    );
    expect(matrix.claims[0]?.status).toBe("misrepresented");
  });

  it("none supported + none contradicts -> not-found", () => {
    writeLedger(runDir, [
      ledgerEntry("https://a.example/x", "ok"),
      ledgerEntry("https://b.example/y", "ok"),
    ]);
    const matrix = deriveMatrix(
      [claim({})],
      verdict([{ claimId: "c001", url: "https://a.example/x", verdict: "not-found" }]),
      runDir,
      "2026-01-01T00:00:00Z",
    );
    expect(matrix.claims[0]?.status).toBe("not-found");
  });

  it("conflict entry overrides the derived status", () => {
    writeLedger(runDir, [
      ledgerEntry("https://a.example/x", "ok"),
      ledgerEntry("https://b.example/y", "ok"),
    ]);
    const matrix = deriveMatrix(
      [claim({})],
      verdict([
        { claimId: "c001", url: "https://a.example/x", verdict: "supported" },
        { claimId: "c001", url: "https://b.example/y", verdict: "supported" },
        { claimId: "c001", conflict: true, note: "sources disagree" },
      ]),
      runDir,
      "2026-01-01T00:00:00Z",
    );
    expect(matrix.claims[0]?.status).toBe("conflict");
  });

  it("citations on unreachable documents never count toward support", () => {
    writeLedger(runDir, [
      ledgerEntry("https://a.example/x", "unreachable"),
      ledgerEntry("https://b.example/y", "ok"),
    ]);
    const matrix = deriveMatrix(
      [claim({})],
      verdict([
        { claimId: "c001", url: "https://a.example/x", verdict: "supported" },
        { claimId: "c001", url: "https://b.example/y", verdict: "supported" },
      ]),
      runDir,
      "2026-01-01T00:00:00Z",
    );
    expect(matrix.claims[0]?.status).toBe("single-source");
    expect(matrix.caveats.join(" ")).toContain("source-not-checked");
  });

  it("all citations unreachable -> unreachable status", () => {
    writeLedger(runDir, [ledgerEntry("https://a.example/x", "unreachable")]);
    const matrix = deriveMatrix(
      [claim({ citations: [{ locator: "p1", title: "A", url: "https://a.example/x" }] })],
      [],
      runDir,
      "2026-01-01T00:00:00Z",
    );
    expect(matrix.claims[0]?.status).toBe("unreachable");
  });

  it("coverage counts by tier and status", () => {
    writeLedger(runDir, [
      ledgerEntry("https://a.example/x", "ok"),
      ledgerEntry("https://b.example/y", "ok"),
    ]);
    const matrix = deriveMatrix(
      [claim({ tier: 2 }), claim({ id: "c002", tier: 3 })],
      verdict([{ claimId: "c001", url: "https://a.example/x", verdict: "supported" }]),
      runDir,
      "2026-01-01T00:00:00Z",
    );
    expect(matrix.coverage).toEqual({
      tier2: { "single-source": 1 },
      tier3: { "not-found": 1 },
    });
  });
});

describe("verdict file validation", () => {
  const claims = [claim({})];

  it("rejects unknown claim ids and foreign urls", () => {
    const { issues } = validateVerdicts(
      JSON.stringify([
        { claimId: "c999", url: "https://a.example/x", verdict: "supported" },
        { claimId: "c001", url: "https://other.example/z", verdict: "supported" },
      ]),
      claims,
    );
    expect(issues.map((i) => i.message)).toEqual([
      "unknown claimId c999",
      "https://other.example/z is not a citation of c001",
    ]);
  });

  it("rejects duplicate verdicts for the same pair", () => {
    const { issues } = validateVerdicts(
      JSON.stringify([
        { claimId: "c001", url: "https://a.example/x", verdict: "supported" },
        { claimId: "c001", url: "https://a.example/x", verdict: "partial" },
      ]),
      claims,
    );
    expect(issues[0]?.message).toContain("duplicate verdict");
  });

  it("rejects duplicate conflict entries", () => {
    const { issues } = validateVerdicts(
      JSON.stringify([
        { claimId: "c001", conflict: true },
        { claimId: "c001", conflict: true },
      ]),
      claims,
    );
    expect(issues[0]?.message).toContain("duplicate conflict");
  });

  it("accepts a well-formed file", () => {
    const { issues } = validateVerdicts(
      JSON.stringify([{ claimId: "c001", url: "https://a.example/x", verdict: "supported" }]),
      claims,
    );
    expect(issues).toEqual([]);
  });
});

describe("DocumentSet", () => {
  it("unions transitively and names a deterministic canonical", () => {
    const docs = new DocumentSet();
    docs.add("https://c.example/1", "https://b.example/2");
    docs.add("https://b.example/2", null);
    docs.add("https://b.example/2", "https://a.example/3");
    expect(docs.documentOf("https://c.example/1")).toBe("https://a.example/3");
    expect(docs.documentOf("https://b.example/2")).toBe("https://a.example/3");
  });
});
