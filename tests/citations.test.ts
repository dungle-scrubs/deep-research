import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderCitations } from "../src/citations.js";
import { parseClaims } from "../src/claims.js";
import { writeLedger } from "../src/fetch.js";
import { runLayout } from "../src/rundir.js";
import { initialState, writeState } from "../src/state.js";
import { deriveMatrix } from "../src/verdicts.js";

let workdir: string;
beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-citations-"));
});
afterEach(() => {
  fs.rmSync(workdir, { force: true, recursive: true });
});

it("exports the fetch tier for both fetched and failed documents, separate from evidence tiers", () => {
  const urls = [
    "https://example.com/plain",
    "https://example.com/rendered",
    "https://example.com/failed",
    "https://example.com/missing",
  ];
  const layout = runLayout(workdir);
  writeState(workdir, initialState("Tiers", "2026-01-01", "briefing"));
  fs.mkdirSync(path.dirname(layout.step("claims.json")), { recursive: true });
  const raw = JSON.stringify(
    urls.map((url, index) => ({
      citations: [{ locator: "p1", title: "Fixture", url }],
      id: `c00${index + 1}`,
      statement: "A statement",
      tier: 3,
    })),
  );
  fs.writeFileSync(layout.step("claims.json"), raw);
  const parsed = parseClaims(raw);
  if (!parsed.claims) throw new Error("invalid test claims");
  writeLedger(
    workdir,
    urls.slice(0, 3).map((url, index) => ({
      attempts: 1,
      bytes: index === 2 ? 0 : 20,
      contentType: "text/markdown",
      fetchedAt: "2026-01-01",
      finalUrl: null,
      hash: String(index),
      normalized: url,
      reason: index === 2 ? "failed" : null,
      status: index === 2 ? "unreachable" : "ok",
      tier: index === 0 ? "plain" : "scraper",
      url,
    })),
  );
  fs.writeFileSync(
    layout.matrixFile,
    JSON.stringify(deriveMatrix(parsed.claims, [], workdir, "2026-01-01")),
  );
  const result = renderCitations(workdir, "2026-01-01");
  // Reachability belongs to the matrix. A missing ledger row has no known
  // fetch tier, even when the matrix groups it with reachable documents.
  expect(result.documents.map((doc) => [doc.url, doc.fetch.tier, doc.tiers])).toEqual([
    [urls[3], null, [3]],
    [urls[0], "plain", [3]],
    [urls[1], "scraper", [3]],
  ]);
  expect(result.unfetched.map((doc) => [doc.url, doc.tier])).toEqual([[urls[2], "scraper"]]);
});
