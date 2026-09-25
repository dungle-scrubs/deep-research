import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLedger } from "../src/fetch.js";
import { runLayout } from "../src/rundir.js";
import { initialState, readState, writeState } from "../src/state.js";

const DR = path.resolve(__dirname, "../dist/dr.mjs");
let workdir: string;
let runDir: string;
let preload: string;
let bin: string;

function run(command: string, tier?: string): { code: number; envelope: Record<string, unknown> } {
  let code = 0;
  let stdout: string;
  try {
    stdout = execFileSync(
      process.execPath,
      ["--import", preload, DR, command, "--root", runDir, "--json"],
      {
        encoding: "utf8",
        env: { ...process.env, DR_FETCH_TIER: tier, PATH: bin },
      },
    );
  } catch (error) {
    const failure = error as { status: number; stdout: string };
    code = failure.status;
    stdout = failure.stdout;
  }
  return { code, envelope: JSON.parse(stdout) };
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-scraper-cli-"));
  runDir = path.join(workdir, "run");
  bin = path.join(workdir, "bin");
  fs.mkdirSync(bin);
  const layout = runLayout(runDir);
  writeState(runDir, initialState("Scraper fixture", "2026-01-01", "fetch"));
  fs.mkdirSync(path.dirname(layout.step("claims.json")), { recursive: true });
  fs.writeFileSync(
    layout.step("claims.json"),
    JSON.stringify([
      {
        id: "c001",
        statement: "A rendered statement.",
        tier: 3,
        citations: [
          { locator: "paragraph 1", title: "Fixture", url: "https://93.184.216.34/blocked" },
        ],
      },
      {
        id: "c002",
        statement: "Another rendered statement.",
        tier: 3,
        citations: [
          { locator: "paragraph 1", title: "Other fixture", url: "https://93.184.216.35/gone" },
        ],
      },
    ]),
  );
  // Replace only transport in the real CLI process. The real SSRF guard still
  // checks these public IP literals; no DNS or remote network is used.
  preload = path.join(workdir, "transport.mjs");
  fs.writeFileSync(
    preload,
    `globalThis.fetch = async (url) => {
    if (String(url).endsWith('/robots.txt')) return new Response('User-agent: *\\nDisallow: /private/');
    return new Response('blocked', {status: String(url).endsWith('/gone') ? 404 : 403});
  };`,
  );
  fs.writeFileSync(
    path.join(bin, "scraper"),
    `#!${process.execPath}\nconsole.log(JSON.stringify({
    ok: true, markdown: "# Rendered\\nA rendered statement from the page.", error: null
  }));\n`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(workdir, { force: true, recursive: true });
});

describe("scraper through the built dr CLI", () => {
  it("falls back, retries only non-ok rows, and reports the retried outcome", () => {
    expect(run("next").code).toBe(0);
    expect(readState(runDir).step).toBe("verdicts");
    expect(readLedger(runDir).map((e) => [e.status, e.tier, e.attempts])).toEqual([
      ["ok", "scraper", 2],
      ["unreachable", "plain", 1],
    ]);
    const retry = run("retry-fetch");
    expect(retry.code).toBe(0);
    expect(retry.envelope).toMatchObject({
      data: {
        entries: [
          { normalized: "https://93.184.216.35/gone", status: "ok", tier: "scraper", attempts: 2 },
        ],
      },
    });
    expect(readLedger(runDir).map((e) => e.attempts)).toEqual([2, 2]);
    expect(run("retry-fetch").envelope).toMatchObject({ data: { entries: [] } });
  });

  it("honors run-level opt-in without a saved config", () => {
    expect(run("next", "scraper").code).toBe(0);
    expect(readLedger(runDir).map((e) => [e.status, e.tier, e.attempts])).toEqual([
      ["ok", "scraper", 1],
      ["ok", "scraper", 1],
    ]);
  });

  it("rejects invalid tier selection without advancing or fetching", () => {
    const result = run("next", "unknown");
    expect(result).toMatchObject({
      code: 1,
      envelope: { ok: false, errors: ["E106: DR_FETCH_TIER must be plain or scraper"] },
    });
    expect(readState(runDir).step).toBe("fetch");
    expect(readLedger(runDir)).toEqual([]);
  });
});
