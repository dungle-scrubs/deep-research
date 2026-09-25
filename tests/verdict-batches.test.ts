import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLedger, writeLedger } from "../src/fetch.js";
import { runLayout } from "../src/rundir.js";

const DR = path.resolve(__dirname, "../dist/dr.mjs");
const QUOTE = "The treatment reduced annual turnover.";
const URL_A = "http://127.0.0.1/a";
const URL_B = "http://127.0.0.1/b";
let root: string;

interface Envelope {
  readonly data?: Record<string, unknown>;
  readonly errors: readonly string[];
  readonly run: string;
  readonly step: string;
}

function run(...args: string[]): { code: number; envelope: Envelope } {
  try {
    return {
      code: 0,
      envelope: JSON.parse(
        execFileSync(process.execPath, [DR, ...args, "--root", root, "--json"], {
          encoding: "utf8",
        }),
      ),
    };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { code: failed.status, envelope: JSON.parse(failed.stdout) };
  }
}

function fulfill(step: string, content: unknown): ReturnType<typeof run> {
  const file = path.join(root, "input");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return run("fulfill", step, file);
}

function fixture(): ReturnType<typeof runLayout> {
  const created = run("new", "Batch fixture");
  expect(created.code).toBe(0);
  for (const [step, text] of [
    ["brief", "# Brief\n\nA question."],
    ["foundation", "# Foundation\n\nhttps://example.com"],
    ["gaps", '# Gaps\n\n```json\n["What else?"]\n```'],
    ["followup", "# Followup\n\nhttps://example.com"],
  ]) {
    expect(fulfill(step ?? "", text).code).toBe(0);
  }
  expect(
    fulfill("claims", [
      {
        citations: [URL_A, URL_B].map((url) => ({ locator: "p1", title: "Fixture", url })),
        id: "c001",
        statement: QUOTE,
        tier: 2,
      },
      {
        citations: [{ locator: "p1", title: "Fixture", url: URL_A }],
        id: "c002",
        statement: "Another statement.",
        tier: 3,
      },
    ]).code,
  ).toBe(0);
  expect(run("next").envelope.step).toBe("verdicts");
  const layout = runLayout(created.envelope.run);
  // The CLI fetch refuses loopback. Supply deterministic extracted evidence
  // to test quote grounding without a network or a model.
  writeLedger(
    created.envelope.run,
    readLedger(created.envelope.run).map((entry) => ({ ...entry, status: "ok" })),
  );
  for (const entry of readLedger(created.envelope.run)) {
    fs.writeFileSync(layout.fetched(`${entry.hash}.txt`), QUOTE);
  }
  return layout;
}

function supported(url: string): Record<string, unknown> {
  return { claimId: "c001", quote: QUOTE, url, verdict: "supported" };
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dr-batches-"));
});

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true });
});

describe("incremental verdict fulfillment", () => {
  it("merges batches, keeps unresolved pairs blocking, and leaves claims byte-identical", () => {
    const layout = fixture();
    const claimsBefore = read(layout.step("claims.json"));
    const first = fulfill("verdicts", [supported(URL_A)]);
    expect(first.code).toBe(0);
    expect(first.envelope.step).toBe("verdicts");
    expect(first.envelope.data).toMatchObject({ batch: 1, remaining: 2 });
    expect(run("next").envelope.step).toBe("verdicts");
    expect(fulfill("briefing", "# Briefing\n\n## Coverage\n\nsingle-source: 1").code).toBe(2);
    const partial = JSON.parse(read(layout.matrixFile));
    expect(partial.claims[0].status).toBe("single-source");
    expect(partial.claims[0].citations.map((row: { verdict: string }) => row.verdict)).toEqual([
      "supported",
      null,
    ]);

    const second = fulfill("verdicts", [
      supported(URL_B),
      { claimId: "c002", url: URL_A, verdict: "not-found" },
    ]);
    expect(second.code).toBe(0);
    expect(second.envelope.step).toBe("briefing");
    expect(second.envelope.data).toMatchObject({ batch: 2, remaining: 0 });
    expect(JSON.parse(read(layout.step("verdicts.json")))).toHaveLength(3);
    expect(JSON.parse(read(layout.matrixFile)).coverage).toEqual({
      tier2: { verified: 1 },
      tier3: { "not-found": 1 },
    });
    expect(read(layout.step("claims.json"))).toBe(claimsBefore);
    expect(run("status").envelope.data?.completed).toEqual([
      "brief",
      "foundation",
      "gaps",
      "followup",
      "claims",
      "fetch",
      "verdicts",
    ]);
  });

  it("rejects cross-batch normalized duplicates with both batch indexes and no mutation", () => {
    const layout = fixture();
    expect(fulfill("verdicts", [supported(URL_A)]).code).toBe(0);
    const files = [layout.stateFile, layout.matrixFile, layout.step("verdicts.json")];
    const before = files.map(read);
    const rejected = fulfill("verdicts", [supported(`${URL_A}?utm_source=test#p1`)]);
    expect(rejected.code).toBe(2);
    expect(rejected.envelope.errors.join("\n")).toMatch(/batch 2.*duplicate verdict.*batch 1/);
    expect(files.map(read)).toEqual(before);
  });

  it("persists explicit skips with coverage and report caveats, without counting support", () => {
    const layout = fixture();
    const skipped = fulfill("verdicts", [
      { claimId: "c001", url: URL_A, verdict: "skipped", note: "Deferred by caller" },
      { claimId: "c002", url: URL_A, verdict: "skipped" },
    ]);
    expect(skipped.code).toBe(0);
    expect(skipped.envelope.step).toBe("verdicts");
    const partial = JSON.parse(read(layout.matrixFile));
    expect(partial.coverage).toEqual({ tier2: { skipped: 1 }, tier3: { skipped: 1 } });
    expect(partial.claims[0].citations[0].verdict).toBe("skipped");
    expect(partial.caveats).toEqual([
      `c001: citation ${URL_A} is skipped; source-not-checked`,
      `c002: citation ${URL_A} is skipped; source-not-checked`,
    ]);
    expect(fulfill("verdicts", [supported(URL_B)]).envelope.step).toBe("briefing");
    expect(JSON.parse(read(layout.matrixFile)).coverage).toEqual({
      tier2: { "single-source": 1 },
      tier3: { skipped: 1 },
    });
    expect(fulfill("briefing", "# Briefing\n\n## Coverage\n\nsingle-source: 1").code).toBe(2);
    expect(
      fulfill("briefing", "# Briefing\n\n## Coverage\n\nsingle-source: 1\nskipped: 1").code,
    ).toBe(0);
    const report = [
      "# Report",
      "## Question",
      "What?",
      "## Verified findings",
      "None.",
      "## Single-source findings",
      "c001 (not corroborated).",
      "## Conflicts",
      "None.",
      "## Gaps and uncertainty",
      "Some citations were skipped.",
      "## Practical implications",
      "Unknown.",
      "## Evidence table",
      "| Claim | Citation | Status | Caveat |",
      "| --- | --- | --- | --- |",
      `| c001 | ${URL_B} | single-source | |`,
      `| c002 | ${URL_A} | skipped | |`,
      "## Discarded claims",
      "None.",
    ].join("\n");
    expect(fulfill("synthesis", report).code).toBe(0);
    const rejected = run("next");
    expect(rejected.code).toBe(2);
    expect(rejected.envelope.errors.join("\n")).toContain("skipped");
    // Finalize's documented repair surface is report.md, not re-fulfillment.
    fs.writeFileSync(
      layout.reportFile,
      report.replaceAll("| |", "| skipped; source-not-checked |"),
    );
    expect(run("next").envelope.step).toBe("done");
  });

  it("checks quotes on every batch and leaves previously accepted results intact", () => {
    const layout = fixture();
    expect(fulfill("verdicts", [supported(URL_A)]).code).toBe(0);
    const before = [layout.stateFile, layout.matrixFile, layout.step("verdicts.json")].map(read);
    const rejected = fulfill("verdicts", [
      { ...supported(URL_B), quote: "Invented text not found in the document." },
    ]);
    expect(rejected.code).toBe(2);
    expect(rejected.envelope.errors.join("\n")).toContain("quote not found");
    expect([layout.stateFile, layout.matrixFile, layout.step("verdicts.json")].map(read)).toEqual(
      before,
    );
    expect(fulfill("verdicts", [supported(URL_B)]).code).toBe(0);
    expect(JSON.parse(read(layout.matrixFile)).claims[0].status).toBe("verified");
  });

  it("does not resolve citation pairs through a conflict marker and rejects repeated conflicts", () => {
    const layout = fixture();
    const first = fulfill("verdicts", [{ claimId: "c001", conflict: true }]);
    expect(first.code).toBe(0);
    expect(first.envelope.step).toBe("verdicts");
    expect(first.envelope.data?.remaining).toBe(3);
    const duplicate = fulfill("verdicts", [{ claimId: "c001", conflict: true }]);
    expect(duplicate.code).toBe(2);
    expect(duplicate.envelope.errors.join("\n")).toMatch(/batch 2.*duplicate conflict.*batch 1/);
    expect(fulfill("verdicts", [supported(URL_A), supported(URL_B)]).envelope.step).toBe(
      "verdicts",
    );
    expect(JSON.parse(read(layout.matrixFile)).claims[0].status).toBe("conflict");
  });

  it("rejects malformed batches and verdicts replacing prior skips without changing accepted state", () => {
    const layout = fixture();
    expect(fulfill("verdicts", [{ claimId: "c001", url: URL_A, verdict: "skipped" }]).code).toBe(0);
    const files = [layout.stateFile, layout.matrixFile, layout.step("verdicts.json")];
    const before = files.map(read);
    for (const input of [
      [],
      "not json",
      [{ claimId: "c999", url: URL_A, verdict: "skipped" }],
      [{ claimId: "c001", url: "https://unknown.example", verdict: "skipped" }],
      [supported(URL_B), supported(URL_B)],
    ]) {
      expect(fulfill("verdicts", input).code).toBe(2);
      expect(files.map(read)).toEqual(before);
    }
    const duplicate = fulfill("verdicts", [supported(URL_A)]);
    expect(duplicate.code).toBe(2);
    expect(duplicate.envelope.errors.join("\n")).toMatch(/batch 2.*duplicate verdict.*batch 1/);
    expect(files.map(read)).toEqual(before);
  });

  it("blocks batches when retry-fetch makes an accepted quoteless verdict checkable", () => {
    const created = run("new", "Retry fixture");
    expect(created.code).toBe(0);
    for (const [step, text] of [
      ["brief", "# Brief\n\nA question."],
      ["foundation", "# Foundation\n\nhttps://example.com"],
      ["gaps", '# Gaps\n\n```json\n["What else?"]\n```'],
      ["followup", "# Followup\n\nhttps://example.com"],
    ]) {
      expect(fulfill(step ?? "", text).code).toBe(0);
    }
    expect(
      fulfill("claims", [
        {
          citations: [{ locator: "p1", title: "Fixture", url: URL_A }],
          id: "c001",
          statement: QUOTE,
          tier: 2,
        },
        {
          citations: [{ locator: "p1", title: "Fixture", url: URL_B }],
          id: "c002",
          statement: "Another statement.",
          tier: 3,
        },
      ]).code,
    ).toBe(0);
    expect(run("next").envelope.step).toBe("verdicts");
    const layout = runLayout(created.envelope.run);
    // URL_A stays unreachable: batch 1 accepts a quoteless supported verdict.
    // URL_B is checkable from the start.
    const flipped = readLedger(created.envelope.run).map((entry) => ({
      ...entry,
      status: entry.normalized.includes("/b") ? "ok" : entry.status,
    }));
    writeLedger(created.envelope.run, flipped);
    for (const entry of readLedger(created.envelope.run)) {
      if (entry.status === "ok") fs.writeFileSync(layout.fetched(`${entry.hash}.txt`), QUOTE);
    }
    expect(fulfill("verdicts", [{ claimId: "c001", url: URL_A, verdict: "supported" }]).code).toBe(
      0,
    );
    // Retry recovers URL_A. The next batch must fail on the stale history,
    // not silently count the unchecked verdict.
    writeLedger(
      created.envelope.run,
      readLedger(created.envelope.run).map((entry) => ({ ...entry, status: "ok" as const })),
    );
    for (const entry of readLedger(created.envelope.run)) {
      fs.writeFileSync(layout.fetched(`${entry.hash}.txt`), QUOTE);
    }
    const blocked = fulfill("verdicts", [{ claimId: "c002", url: URL_B, verdict: "not-found" }]);
    expect(blocked.code).toBe(2);
    expect(blocked.envelope.errors.join("\n")).toMatch(/batch 1.*requires a quote/);
    // Resubmitting the stale pair with its quote unblocks; last write wins.
    const fixed = fulfill("verdicts", [
      { claimId: "c002", url: URL_B, verdict: "not-found" },
      { claimId: "c001", quote: QUOTE, url: URL_A, verdict: "supported" },
    ]);
    expect(fixed.code).toBe(0);
    expect(fixed.envelope.step).toBe("briefing");
    expect(JSON.parse(read(layout.matrixFile)).coverage).toEqual({
      tier2: { "single-source": 1 },
      tier3: { "not-found": 1 },
    });
  });

  it("retries an uncommitted batch after projection I/O failure without losing accepted entries", () => {
    const layout = fixture();
    expect(fulfill("verdicts", [supported(URL_A)]).code).toBe(0);
    const before = read(layout.stateFile);
    fs.unlinkSync(layout.matrixFile);
    fs.mkdirSync(layout.matrixFile);
    expect(fulfill("verdicts", [supported(URL_B)]).code).toBe(4);
    expect(read(layout.stateFile)).toBe(before);
    fs.rmdirSync(layout.matrixFile);
    const retried = fulfill("verdicts", [supported(URL_B)]);
    expect(retried.code).toBe(0);
    expect(retried.envelope.data?.batch).toBe(2);
    expect(JSON.parse(read(layout.step("verdicts.json")))).toHaveLength(2);
    expect(JSON.parse(read(layout.matrixFile)).claims[0].status).toBe("verified");
  });
});
