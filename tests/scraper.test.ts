import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrapePage } from "../src/scraper.js";

let workdir: string;

function executable(body: string): void {
  fs.writeFileSync(path.join(workdir, "scraper"), `#!${process.execPath}\n${body}\n`, {
    mode: 0o755,
  });
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-scraper-"));
  vi.stubEnv("PATH", workdir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workdir, { force: true, recursive: true });
});

describe("scraper subprocess boundary", () => {
  it("passes URL as one argument and constrains the scraper's environment", async () => {
    vi.stubEnv("SCRAPER_JINA_ENABLED", "true");
    vi.stubEnv("SCRAPER_MAX_RETRIES", "99");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
    executable(`
      const args = process.argv.slice(2);
      const valid = JSON.stringify(args) === JSON.stringify([
        "scrape", "--timeout", "2", "https://example.com/?q=hello;echo"
      ]) && process.env.SCRAPER_JINA_ENABLED === "false"
        && process.env.SCRAPER_MAX_RETRIES === "1"
        && process.env.SCRAPER_MAX_MARKDOWN_CHARS === "1024"
        && !process.env.OPENAI_API_KEY;
      console.log(JSON.stringify({ ok: valid, markdown: "# Fixture", error: valid ? null : "unsafe invocation" }));
    `);
    expect(await scrapePage("https://example.com/?q=hello;echo", 1024, 2000)).toEqual({
      ok: true,
      text: "# Fixture",
    });
  });

  it("names the dependency when missing", async () => {
    expect(await scrapePage("https://example.com/", 1024, 2000)).toEqual({
      ok: false,
      reason: "scraper is not installed; pipx install dungle-scrubs-scraper",
    });
  });

  it.each([
    ["not-json", "scraper returned invalid JSON or failed to start"],
    [
      JSON.stringify({ ok: true, markdown: 12, error: null }),
      "scraper returned an invalid response",
    ],
    [JSON.stringify({ ok: true, markdown: "  ", error: null }), "scraper returned empty text"],
    [
      JSON.stringify({ ok: false, error: "Bot protection detected" }),
      "scraper: Bot protection detected",
    ],
  ])("rejects an unusable payload: %s", async (payload, reason) => {
    executable(`process.stdout.write(${JSON.stringify(payload)});`);
    expect(await scrapePage("https://example.com/", 1024, 2000)).toEqual({ ok: false, reason });
  });

  it("does not accept success JSON from an unsuccessful process", async () => {
    executable(
      `console.log(JSON.stringify({ ok: true, markdown: "text", error: null })); process.exitCode = 1;`,
    );
    expect(await scrapePage("https://example.com/", 1024, 2000)).toEqual({
      ok: false,
      reason: "scraper exited unsuccessfully",
    });
  });

  it("preserves structured failure on a nonzero exit", async () => {
    executable(
      `console.log(JSON.stringify({ ok: false, error: "blocked" })); process.exitCode = 2;`,
    );
    expect(await scrapePage("https://example.com/", 1024, 2000)).toEqual({
      ok: false,
      reason: "scraper: blocked",
    });
  });

  it("bounds a stalled subprocess", async () => {
    executable("setTimeout(() => {}, 10000);");
    expect(await scrapePage("https://example.com/", 1024, 100)).toEqual({
      ok: false,
      reason: "scraper exceeded its time or output limit",
    });
  });

  it("bounds stdout before parsing JSON", async () => {
    executable("process.stdout.write('x'.repeat(100000));");
    expect(await scrapePage("https://example.com/", 1, 2000)).toEqual({
      ok: false,
      reason: "scraper exceeded its time or output limit",
    });
  });
});
