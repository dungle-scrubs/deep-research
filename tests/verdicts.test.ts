import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Claim } from "../src/claims.js";
import type { FetchStatus, LedgerEntry } from "../src/fetch.js";
import { extractText, writeLedger } from "../src/fetch.js";
import { runLayout } from "../src/rundir.js";
import { urlHash } from "../src/url.js";
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

function ledgerEntry(url: string, status: FetchStatus): LedgerEntry {
  return {
    attempts: 1,
    bytes: 1,
    contentType: "text/html",
    fetchedAt: "2026-01-01T00:00:00Z",
    finalUrl: url,
    hash: urlHash(url),
    normalized: url,
    reason: null,
    status,
    tier: "plain",
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

  it("derives the same matrix regardless of batch order, including skipped pairs", () => {
    const claims = [claim({}), claim({ id: "c002", tier: 3 })];
    const entries = [
      { claimId: "c001", note: "", url: "https://a.example/x", verdict: "supported" },
      { claimId: "c001", note: "", url: "https://b.example/y", verdict: "skipped" },
      { claimId: "c002", note: "", url: "https://a.example/x", verdict: "skipped" },
      { claimId: "c002", note: "", url: "https://b.example/y", verdict: "not-found" },
    ] as const;
    const first = deriveMatrix(claims, entries, runDir, "2026-01-01T00:00:00Z");
    const reversed = deriveMatrix(claims, [...entries].reverse(), runDir, first.derivedAt);
    expect(first).toEqual(reversed);
    expect(first.coverage).toEqual({ tier2: { "single-source": 1 }, tier3: { skipped: 1 } });
    expect(first.claims[0]?.citations.map((row) => row.verdict)).toEqual(["supported", "skipped"]);
    expect(first.caveats).toHaveLength(2);
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
      runDir,
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
      runDir,
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
      runDir,
    );
    expect(issues[0]?.message).toContain("duplicate conflict");
  });

  it("accepts a well-formed file", () => {
    writeLedger(runDir, [ledgerEntry("https://a.example/x", "unreachable")]);
    const { issues } = validateVerdicts(
      JSON.stringify([{ claimId: "c001", url: "https://a.example/x", verdict: "supported" }]),
      claims,
      runDir,
    );
    expect(issues).toEqual([]);
  });
});

describe("quote grounding", () => {
  const url = "https://a.example/x";
  const claims = [claim({ citations: [{ locator: "Table 2", title: "A", url }] })];

  function page(text: string, status: FetchStatus = "ok"): void {
    writeLedger(runDir, [ledgerEntry(url, status)]);
    fs.mkdirSync(runLayout(runDir).fetchedDir, { recursive: true });
    fs.writeFileSync(runLayout(runDir).fetched(`${urlHash(url)}.txt`), text);
  }

  function check(quote?: string) {
    return validateVerdicts(
      JSON.stringify([{ claimId: "c001", quote, url, verdict: "supported" }]),
      claims,
      runDir,
    );
  }

  it("rejects missing quotes with one specific violation", () => {
    page("The treatment reduced annual turnover.");
    expect(check().issues).toEqual([
      { message: `c001 on ${url}: supported verdict requires a quote`, path: "0.quote" },
    ]);
  });

  it.each([
    ["absent string", "A completely invented factual statement", "not found"],
    ["short label", "Table 2", "at least 16"],
    ["punctuation-only", "!!!!!!!!!!!!!!!!!", "at least 16"],
    ["length after normalization", "  a...b...c...d...e...f...g...h...i  ", "at least 16"],
    ["wrong order", "turnover annual reduced treatment", "not found"],
    ["reused token", "treatment treatment reduced turnover", "not found"],
  ])("rejects %s", (_label, quote, message) => {
    page("Table 2. The treatment reduced annual turnover. abcdefghi");
    const { issues } = check(quote);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("0.quote");
    expect(issues[0]?.message).toContain(message);
  });

  it("accepts normalized contiguous substrings, including inside a token", () => {
    page("Prefix: the treatment reduced ANNUAL\n\tTURNOVER; dramatically.");
    const quote = "TREATMENT REDUCED annual turnover";
    const result = check(quote);
    expect(result.issues).toEqual([]);
    expect(result.entries[0]).toMatchObject({ quote });
    expect(check("reatment reduced annual turnover").issues).toEqual([]);
  });

  it("accepts ordered whole-token containment with gaps from markup and entities", () => {
    page(extractText("<p>The <b>treatment</b> &amp; coaching reduced <i>annual</i> turnover.</p>"));
    expect(check("The treatment reduced turnover.").issues).toEqual([]);
    expect(check("The treat reduced turnover.").issues[0]?.message).toContain("not found");
  });

  it("rejects ordered tokens assembled from distant sentences", () => {
    page(
      "The drug reduced headaches and then some substantially. Pages and pages of unrelated filler words fill the empty space here and then even more padding follows. Mortality changed by fifty percent overall in the final analysis.",
    );
    const issues = check("The drug reduced headaches and then mortality by fifty percent").issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("not found");
  });

  it("accepts ordered tokens inside the bounded window", () => {
    page("The drug reduced headaches and then mortality by fifty percent in the trial.");
    expect(check("The drug reduced headaches and then mortality by fifty percent").issues).toEqual(
      [],
    );
  });

  it("strips Unicode punctuation and collapses whitespace after stripping", () => {
    page("THE “TREATMENT”\t,  REDUCED\nTURNOVER.");
    expect(check("the treatment reduced turnover").issues).toEqual([]);
  });

  it("casefolds expanding letters and sigma without conflating dotless i", () => {
    page("STRASSE und grosse Wirkungen.");
    expect(check("Straße und große Wirkungen.").issues).toEqual([]);
    page("abcdefghijklmnop ΟΣΑ");
    expect(check("ABCDEFGHIJKLMNOP ΟΣ").issues).toEqual([]);
    page("An independent finding was confirmed.");
    expect(check("An ındependent finding").issues[0]?.message).toContain("not found");
  });

  it("counts normalized characters rather than UTF-16 code units", () => {
    page("𐐀𐐁𐐂𐐃𐐄𐐅𐐆𐐇");
    expect(check("𐐀𐐁𐐂𐐃𐐄𐐅𐐆𐐇").issues[0]?.message).toContain("at least 16");
  });

  it("requires exactly 16 normalized characters at the lower boundary", () => {
    page("abcdefghijklmnop");
    expect(check("abcdefghijklmno").issues[0]?.message).toContain("at least 16");
    expect(check("abcdefghijklmnop").issues).toEqual([]);
  });

  it.each(["unreachable", "robots-blocked", "paywalled", "binary-unreadable"] as const)(
    "skips %s even without a quote, and never counts its support",
    (status) => {
      page("The treatment reduced annual turnover.", status);
      const { entries, issues } = check();
      expect(issues).toEqual([]);
      const matrix = deriveMatrix(claims, entries, runDir, "2026-01-01T00:00:00Z");
      expect(matrix.claims[0]?.status).toBe("unreachable");
      expect(matrix.claims[0]?.citations[0]?.reachable).toBe(false);
      expect(matrix.caveats[0]).toContain("source-not-checked");
    },
  );

  it("rejects missing ledger evidence rather than treating it as a skip", () => {
    expect(check("The treatment reduced annual turnover").issues[0]?.message).toContain(
      "no fetch ledger entry",
    );
  });

  it("rejects unreadable or empty text on an ok document", () => {
    writeLedger(runDir, [ledgerEntry(url, "ok")]);
    expect(check("The treatment reduced annual turnover").issues[0]?.message).toContain(
      "cannot read fetched text",
    );
    page("");
    expect(check("The treatment reduced annual turnover").issues[0]?.message).toContain(
      "not found",
    );
  });

  it("uses the normalized citation URL to select the fetched evidence", () => {
    page("The treatment reduced annual turnover.");
    const { issues } = validateVerdicts(
      JSON.stringify([
        {
          claimId: "c001",
          quote: "The treatment reduced annual turnover",
          url: `${url}?utm_source=foo#table2`,
          verdict: "supported",
        },
      ]),
      claims,
      runDir,
    );
    expect(issues).toEqual([]);
  });

  it("does not check quotes on other verdicts or conflict entries", () => {
    for (const verdict of ["partial", "not-found", "contradicts"]) {
      expect(
        validateVerdicts(JSON.stringify([{ claimId: "c001", url, verdict }]), claims, runDir)
          .issues,
      ).toEqual([]);
    }
    expect(
      validateVerdicts(JSON.stringify([{ claimId: "c001", conflict: true }]), claims, runDir)
        .issues,
    ).toEqual([]);
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
