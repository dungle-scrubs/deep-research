import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchAll, type LedgerEntry, readLedger } from "../src/fetch.js";
import { runLayout } from "../src/rundir.js";
import { normalizeUrl, urlHash } from "../src/url.js";

let workdir: string;
let server: http.Server;
let baseUrl: string;
const hits: Record<string, number> = {};
const failPaths: Set<string> = new Set();

const permissiveGuard = async () => ({ allowed: true }) as const;

function serve(handler: http.RequestListener): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      }
    });
  });
}

beforeEach(async () => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-fetch-"));
  for (const key of Object.keys(hits)) delete hits[key];
  failPaths.clear();
  await serve((req, res) => {
    const pathname = req.url ?? "/";
    hits[pathname] = (hits[pathname] ?? 0) + 1;
    if (failPaths.has(pathname)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("gone");
      return;
    }
    if (pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private/\n");
      return;
    }
    if (pathname === "/private/doc") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>secret</body></html>");
      return;
    }
    if (pathname === "/redir") {
      res.writeHead(302, { location: "/target" });
      res.end();
      return;
    }
    if (pathname === "/target") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><p>final page</p></body></html>");
      return;
    }
    if (pathname === "/blocked") {
      res.writeHead(403);
      res.end("Access denied");
      return;
    }
    if (pathname === "/empty") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><script>render()</script><body></body></html>");
      return;
    }
    if (pathname === "/paywalled") {
      res.writeHead(401, { "content-type": "text/html" });
      res.end("<html><body>subscribe</body></html>");
      return;
    }
    if (pathname === "/gone") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (pathname === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(10_000));
      return;
    }
    if (pathname === "/flaky") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>flaky ok</body></html>");
      return;
    }
    if (pathname === "/pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.from("%PDF-1.4 fake pdf bytes"));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      "<html><head><script>evil()</script></head><body><h1>Doc</h1><p>Body text &amp; more</p></body></html>",
    );
  });
});

afterEach(async () => {
  fs.rmSync(workdir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function entryFor(entries: readonly LedgerEntry[], url: string): LedgerEntry | undefined {
  const normalized = normalizeUrl(url);
  return entries.find((e) => e.normalized === normalized);
}

describe("fetch engine", () => {
  it("stores raw and extracted text for an ok page", async () => {
    const url = `${baseUrl}/doc`;
    const entries = await fetchAll({ guard: permissiveGuard, runDir: workdir, urls: [url] });
    const entry = entryFor(entries, url);
    expect(entry?.status).toBe("ok");
    expect(entry?.tier).toBe("plain");
    expect(entry?.contentType).toContain("text/html");
    expect(entry?.finalUrl).toBe(`${baseUrl}/doc`);
    const hash = urlHash(normalizeUrl(url));
    const raw = fs.readFileSync(path.join(workdir, "fetched", `${hash}.raw`), "utf8");
    expect(raw).toContain("<html>");
    const text = fs.readFileSync(path.join(workdir, "fetched", `${hash}.txt`), "utf8");
    expect(text).toContain("Doc");
    expect(text).toContain("Body text & more");
    expect(text).not.toContain("evil()");
    expect(fs.existsSync(path.join(workdir, "state", "fetch-ledger.json"))).toBe(true);
  });

  it("follows redirects and records the final URL", async () => {
    const entries = await fetchAll({
      guard: permissiveGuard,
      runDir: workdir,
      urls: [`${baseUrl}/redir`],
    });
    expect(entryFor(entries, `${baseUrl}/redir`)?.finalUrl).toBe(`${baseUrl}/target`);
    expect(entryFor(entries, `${baseUrl}/redir`)?.status).toBe("ok");
  });

  it("records 404 as unreachable and keeps the run going", async () => {
    const entries = await fetchAll({
      guard: permissiveGuard,
      runDir: workdir,
      urls: [`${baseUrl}/gone`, `${baseUrl}/doc`],
    });
    expect(entryFor(entries, `${baseUrl}/gone`)?.status).toBe("unreachable");
    expect(entryFor(entries, `${baseUrl}/gone`)?.reason).toContain("404");
    expect(entryFor(entries, `${baseUrl}/doc`)?.status).toBe("ok");
  });

  it("flags 401 as paywalled and stores the body", async () => {
    const url = `${baseUrl}/paywalled`;
    const entries = await fetchAll({ guard: permissiveGuard, runDir: workdir, urls: [url] });
    const entry = entryFor(entries, url);
    expect(entry?.status).toBe("paywalled");
    const hash = urlHash(normalizeUrl(url));
    expect(fs.existsSync(path.join(workdir, "fetched", `${hash}.raw`))).toBe(true);
  });

  it("flags a disallowed path as robots-blocked", async () => {
    const entries = await fetchAll({
      guard: permissiveGuard,
      runDir: workdir,
      urls: [`${baseUrl}/private/doc`],
    });
    const entry = entryFor(entries, `${baseUrl}/private/doc`);
    expect(entry?.status).toBe("robots-blocked");
    expect(entry?.reason).toContain("robots.txt");
    expect(hits["/private/doc"] ?? 0).toBe(0);
  });

  it("truncates at the per-document size cap", async () => {
    const entries = await fetchAll({
      guard: permissiveGuard,
      maxBytes: 1024,
      runDir: workdir,
      urls: [`${baseUrl}/big`],
    });
    expect(entryFor(entries, `${baseUrl}/big`)?.status).toBe("ok");
    expect(entryFor(entries, `${baseUrl}/big`)?.bytes).toBeLessThanOrEqual(2048);
  });

  it("stores PDFs and marks binary-unreadable when no text extracts", async () => {
    const url = `${baseUrl}/pdf`;
    const entries = await fetchAll({ guard: permissiveGuard, runDir: workdir, urls: [url] });
    const entry = entryFor(entries, url);
    expect(["binary-unreadable", "ok"]).toContain(entry?.status);
    const hash = urlHash(normalizeUrl(url));
    expect(fs.existsSync(path.join(workdir, "fetched", `${hash}.raw`))).toBe(true);
    if (entry?.status === "binary-unreadable") {
      expect(entry.reason).toContain("PDF stored");
    }
  });

  it("rate limits to one request per second per domain", async () => {
    const sleeps: number[] = [];
    let clock = 1_000_000;
    const entries = await fetchAll({
      guard: permissiveGuard,
      now: () => new Date(clock),
      runDir: workdir,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      urls: [`${baseUrl}/doc`, `${baseUrl}/target`],
    });
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(900);
    expect(entries.every((e) => e.status === "ok")).toBe(true);
  });

  it("retry-fetch refetches only non-ok entries", async () => {
    failPaths.add("/flaky");
    const first = await fetchAll({
      guard: permissiveGuard,
      runDir: workdir,
      urls: [`${baseUrl}/doc`, `${baseUrl}/flaky`],
    });
    expect(entryFor(first, `${baseUrl}/flaky`)?.status).toBe("unreachable");
    const docHitsAfterFirst = hits["/doc"] ?? 0;
    failPaths.delete("/flaky");
    const retry = await fetchAll({
      guard: permissiveGuard,
      retryOnly: true,
      runDir: workdir,
      urls: [`${baseUrl}/doc`, `${baseUrl}/flaky`],
    });
    expect(entryFor(retry, `${baseUrl}/flaky`)?.status).toBe("ok");
    expect(entryFor(retry, `${baseUrl}/doc`)?.status).toBe("ok");
    expect(hits["/doc"] ?? 0).toBe(docHitsAfterFirst);
    expect(entryFor(retry, `${baseUrl}/flaky`)?.attempts).toBe(2);
    // Ledger persists both entries.
    expect(readLedger(workdir)).toHaveLength(2);
  });

  it("normalizes duplicate citations into one document", async () => {
    const url = `${baseUrl}/doc?a=1&utm_source=x`;
    const same = `${baseUrl}/doc?a=1`;
    const entries = await fetchAll({
      guard: permissiveGuard,
      runDir: workdir,
      urls: [url, same],
    });
    expect(entries).toHaveLength(1);
    expect(hits["/doc?a=1"]).toBe(1);
    expect(fs.existsSync(runLayout(workdir).ledgerFile)).toBe(true);
  });
});

describe("scraper tier", () => {
  it("does not invoke scraper for an ordinary plain page", async () => {
    let invoked = false;
    const entries = await fetchAll({
      guard: permissiveGuard,
      runDir: workdir,
      scrapeFn: async () => {
        invoked = true;
        return { ok: false, reason: "must not run" };
      },
      urls: [`${baseUrl}/doc`],
    });
    expect(invoked).toBe(false);
    expect(entries[0]).toMatchObject({ attempts: 1, status: "ok", tier: "plain" });
  });

  it("keeps capped UTF-8 text valid without exceeding the byte cap", async () => {
    const url = `${baseUrl}/doc`;
    const entries = await fetchAll({
      guard: permissiveGuard,
      maxBytes: 6,
      runDir: workdir,
      scrapeFn: async () => ({ ok: true, text: "abc€€" }),
      tier: "scraper",
      urls: [url],
    });
    expect(entries[0]).toMatchObject({ bytes: 6, status: "ok", tier: "scraper" });
    expect(fs.readFileSync(path.join(workdir, "fetched", `${urlHash(url)}.txt`), "utf8")).toBe(
      "abc€",
    );
    const partial = await fetchAll({
      guard: permissiveGuard,
      maxBytes: 5,
      runDir: workdir,
      scrapeFn: async () => ({ ok: true, text: "abc€€" }),
      tier: "scraper",
      urls: [url],
    });
    expect(partial[0]?.bytes).toBe(3);
    expect(fs.readFileSync(path.join(workdir, "fetched", `${urlHash(url)}.txt`), "utf8")).toBe(
      "abc",
    );
  });

  it.each(["/blocked", "/empty"])(
    "recovers %s through scraper and records its text and attempt",
    async (pathname) => {
      const url = `${baseUrl}${pathname}`;
      const calls: string[] = [];
      const entries = await fetchAll({
        guard: permissiveGuard,
        runDir: workdir,
        scrapeFn: async (target) => {
          calls.push(target);
          return { ok: true, text: "# Rendered pricing\nPlan costs $12." };
        },
        sleep: async () => {},
        urls: [url],
      });
      expect(calls).toEqual([url]);
      expect(entries[0]).toMatchObject({ attempts: 2, status: "ok", tier: "scraper" });
      expect(readLedger(workdir)[0]?.tier).toBe("scraper");
      expect(fs.readFileSync(path.join(workdir, "fetched", `${urlHash(url)}.txt`), "utf8")).toBe(
        "# Rendered pricing\nPlan costs $12.",
      );
    },
  );

  it("uses scraper directly while keeping robots, SSRF, byte caps, and per-origin pacing", async () => {
    let clock = 0;
    const calls: { url: string; at: number }[] = [];
    const entries = await fetchAll({
      guard: async (url) =>
        url.includes("blocked.example")
          ? { allowed: false, reason: "private address" }
          : { allowed: true },
      maxBytes: 16,
      now: () => new Date(clock),
      runDir: workdir,
      scrapeFn: async (url) => {
        calls.push({ at: clock, url });
        return { ok: true, text: "Rendered ".repeat(20) };
      },
      sleep: async (ms) => {
        clock += ms;
      },
      tier: "scraper",
      urls: [
        `${baseUrl}/doc`,
        `${baseUrl}/target`,
        `${baseUrl}/private/doc`,
        "https://blocked.example/doc",
      ],
    });
    expect(calls).toEqual([
      { at: 0, url: `${baseUrl}/doc` },
      { at: 1000, url: `${baseUrl}/target` },
    ]);
    expect(entries.map((e) => [e.status, e.tier, e.bytes])).toEqual([
      ["ok", "scraper", 16],
      ["ok", "scraper", 16],
      ["robots-blocked", "scraper", 0],
      ["unreachable", "scraper", 0],
    ]);
    expect(hits["/doc"] ?? 0).toBe(0);
    expect(hits["/robots.txt"]).toBe(1);
    expect(
      fs.readFileSync(path.join(workdir, "fetched", `${urlHash(`${baseUrl}/doc`)}.txt`), "utf8"),
    ).toBe("Rendered Rendere");
  });

  it("paces fallback after the plain attempt and leaves ordinary failures on plain", async () => {
    let clock = 0;
    const times: number[] = [];
    const entries = await fetchAll({
      guard: permissiveGuard,
      now: () => new Date(clock),
      runDir: workdir,
      scrapeFn: async () => {
        times.push(clock);
        return { ok: false, reason: "scraper unavailable" };
      },
      sleep: async (ms) => {
        clock += ms;
      },
      urls: [`${baseUrl}/blocked`, `${baseUrl}/gone`, `${baseUrl}/paywalled`],
    });
    expect(times).toEqual([1000]);
    expect(entries.map((e) => [e.status, e.tier, e.attempts])).toEqual([
      ["unreachable", "scraper", 2],
      ["unreachable", "plain", 1],
      ["paywalled", "plain", 1],
    ]);
    expect(entries[0]?.reason).toContain("scraper unavailable");
  });

  it("retries non-ok entries with scraper, keeps ok entries, and counts each attempt", async () => {
    const urls = [`${baseUrl}/doc`, `${baseUrl}/gone`];
    await fetchAll({ guard: permissiveGuard, runDir: workdir, sleep: async () => {}, urls });
    const calls: string[] = [];
    const options = {
      guard: permissiveGuard,
      retryOnly: true,
      runDir: workdir,
      scrapeFn: async (url: string) => {
        calls.push(url);
        return { ok: true as const, text: "Recovered document" };
      },
      tier: "scraper" as const,
      urls,
    };
    const entries = await fetchAll(options);
    expect(entries.map((e) => [e.status, e.tier, e.attempts])).toEqual([
      ["ok", "plain", 1],
      ["ok", "scraper", 2],
    ]);
    expect(await fetchAll(options)).toEqual(entries);
    expect(calls).toEqual([`${baseUrl}/gone`]);
  });

  it("does not leave stale text when a later attempt fails", async () => {
    const url = `${baseUrl}/doc`;
    await fetchAll({ guard: permissiveGuard, runDir: workdir, urls: [url] });
    await fetchAll({
      guard: permissiveGuard,
      runDir: workdir,
      scrapeFn: async () => ({ ok: false, reason: "failed" }),
      tier: "scraper",
      urls: [url],
    });
    expect(fs.existsSync(path.join(workdir, "fetched", `${urlHash(url)}.txt`))).toBe(false);
  });

  it("reads pre-tier ledger entries as plain", () => {
    const layout = runLayout(workdir);
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(
      layout.ledgerFile,
      JSON.stringify([
        {
          attempts: 1,
          bytes: 12,
          contentType: "text/html",
          fetchedAt: "2026-01-01",
          finalUrl: null,
          hash: "h",
          normalized: "https://example.com/",
          reason: null,
          status: "ok",
          url: "https://example.com/",
        },
      ]),
    );
    expect(readLedger(workdir)[0]?.tier).toBe("plain");
  });
});
