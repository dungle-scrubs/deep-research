import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { runLayout } from "./rundir.js";
import type { ScrapeResult } from "./scraper.js";
import { scrapePage } from "./scraper.js";
import { type GuardVerdict, guardUrl } from "./ssrf.js";
import { normalizeUrl, urlHash } from "./url.js";

export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 15_000;
export const MAX_PARALLEL_ORIGINS = 6;

const ledgerEntrySchema = z.object({
  attempts: z.number(),
  bytes: z.number(),
  contentType: z.string().nullable(),
  fetchedAt: z.string(),
  finalUrl: z.string().nullable(),
  hash: z.string(),
  normalized: z.string(),
  reason: z.string().nullable(),
  status: z.enum(["ok", "unreachable", "paywalled", "binary-unreadable", "robots-blocked"]),
  // Older runs predate the scraper tier and contain only plain fetches.
  tier: z.enum(["plain", "scraper"]).default("plain"),
  url: z.string(),
});

export type LedgerEntry = Readonly<z.infer<typeof ledgerEntrySchema>>;
export type FetchStatus = LedgerEntry["status"];
export type FetchTier = LedgerEntry["tier"];

export function readLedger(runDir: string): LedgerEntry[] {
  try {
    const raw = fs.readFileSync(runLayout(runDir).ledgerFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const result = z.array(ledgerEntrySchema).safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function writeLedger(runDir: string, entries: readonly LedgerEntry[]): void {
  const layout = runLayout(runDir);
  fs.mkdirSync(layout.stateDir, { recursive: true });
  fs.writeFileSync(layout.ledgerFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

/** Extract plain text from HTML: drop script/style, strip tags, decode the
 *  common entities. Best effort; the raw file stays as evidence. */
export function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

const execFileP = promisify(execFile);

async function pdfText(rawPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("pdftotext", ["-layout", rawPath, "-"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return stdout.trim().length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

type RobotsCache = Map<string, string[]>;

async function robotsDisallows(
  origin: string,
  cache: RobotsCache,
  fetchFn: typeof fetch,
): Promise<string[]> {
  const cached = cache.get(origin);
  if (cached) return cached;
  let disallow: string[] = [];
  try {
    const response = await fetchFn(`${origin}/robots.txt`, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) {
      const body = (await response.text()).slice(0, 64 * 1024);
      disallow = parseRobots(body);
    }
  } catch {
    // Unreachable robots.txt allows everything (standard 4xx/5xx behavior).
  }
  cache.set(origin, disallow);
  return disallow;
}

/** Parse robots.txt for User-agent: * Disallow prefixes. */
export function parseRobots(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const disallow: string[] = [];
  let inStar = false;
  for (const line of lines) {
    const clean = line.split("#")[0]?.trim() ?? "";
    if (clean.length === 0) continue;
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(clean);
    if (!match) continue;
    const field = match[1] ?? "";
    const value = match[2] ?? "";
    if (field.toLowerCase() === "user-agent") {
      inStar = value.trim() === "*";
    } else if (field.toLowerCase() === "disallow" && inStar && value.trim().length > 0) {
      disallow.push(value.trim());
    }
  }
  return disallow;
}

export interface FetchEngineOptions {
  readonly runDir: string;
  readonly urls: readonly string[];
  /** Retry mode: re-attempt only ledger entries not ok. Idempotent for ok. */
  readonly retryOnly?: boolean;
  /** Drive recovery never repeats a recorded scraper acquisition, including failures. */
  readonly onlyUntriedScraper?: boolean;
  /** Plain first with 403/empty-text fallback, or scraper directly. */
  readonly tier?: FetchTier;
  /** Injectable subprocess boundary; all engine guards still apply. */
  readonly scrapeFn?: (url: string, maxBytes: number, timeoutMs: number) => Promise<ScrapeResult>;
  /** Injectable for tests; production uses the real SSRF guard. */
  readonly guard?: (url: string) => Promise<GuardVerdict>;
  /** Injectable clock/sleep for tests. */
  readonly fetchFn?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  /** Per-document size cap override for tests. */
  readonly maxBytes?: number;
}

interface PerDomainClock {
  lastHit: Map<string, number>;
}

async function respectRateLimit(
  origin: string,
  clock: PerDomainClock,
  sleep: (ms: number) => Promise<void>,
  now: () => Date,
): Promise<void> {
  const last = clock.lastHit.get(origin);
  if (last !== undefined) {
    const wait = 1000 - (now().getTime() - last);
    if (wait > 0) await sleep(wait);
  }
  clock.lastHit.set(origin, now().getTime());
}

/** Fetch each unique normalized URL, optionally escalating from plain to
 *  scraper, and store the final tier's evidence and outcome. Network and
 *  subprocess failures are ledger outcomes; persistence errors may throw. */
export async function fetchAll(options: FetchEngineOptions): Promise<LedgerEntry[]> {
  const guard = options.guard ?? guardUrl;
  const fetchFn = options.fetchFn ?? fetch;
  const scrapeFn = options.scrapeFn ?? scrapePage;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const tier = options.tier ?? "plain";
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const previous = readLedger(options.runDir);
  const byNormalized = new Map(previous.map((entry) => [entry.normalized, entry]));

  const targets = [...new Set(options.urls.map(normalizeUrl))].filter((normalized) => {
    if (!options.retryOnly) return true;
    const prior = byNormalized.get(normalized);
    if (options.onlyUntriedScraper && prior?.tier === "scraper") return false;
    return prior === undefined || prior.status !== "ok";
  });

  const fetchedDir = runLayout(options.runDir).fetchedDir;
  fs.mkdirSync(fetchedDir, { recursive: true });
  const robotsCache: RobotsCache = new Map();
  const guardCache = new Map<string, GuardVerdict>();
  const clock: PerDomainClock = { lastHit: new Map() };
  const results: LedgerEntry[] = [];

  const processTarget = async (normalized: string): Promise<LedgerEntry> => {
    const prior = byNormalized.get(normalized);
    const attempts = (prior?.attempts ?? 0) + 1;
    const target = new URL(normalized);
    const origin = target.origin;
    const base = {
      hash: urlHash(normalized),
      normalized,
      url: prior?.url ?? normalized,
      attempts,
      fetchedAt: now().toISOString(),
      tier,
    };

    // A replacement attempt must not leave text from an older tier available
    // to the verdict gate. These files belong to this normalized URL alone.
    for (const extension of ["raw", "txt"]) {
      fs.rmSync(path.join(fetchedDir, `${base.hash}.${extension}`), { force: true });
    }

    const runScraper = async (fallback: boolean): Promise<LedgerEntry> => {
      const scraperBase = {
        ...base,
        attempts: attempts + (fallback ? 1 : 0),
        bytes: 0,
        contentType: null,
        fetchedAt: now().toISOString(),
        // scraper's `url` echoes the input, not a verified final redirect URL.
        finalUrl: null,
        tier: "scraper" as const,
      };
      try {
        if (fallback) await respectRateLimit(origin, clock, sleep, now);
        const result = await scrapeFn(normalized, maxBytes, TIMEOUT_MS);
        if (!result.ok) {
          return { ...scraperBase, reason: result.reason, status: "unreachable" };
        }
        // Decode without an incomplete trailing UTF-8 sequence, which would
        // expand to a replacement character and could exceed the byte cap.
        const decoder = new TextDecoder();
        const raw = Buffer.from(result.text).subarray(0, maxBytes);
        const text = decoder.decode(raw, { stream: true });
        if (text.trim().length === 0) {
          return { ...scraperBase, reason: "scraper returned empty text", status: "unreachable" };
        }
        const buffer = Buffer.from(text);
        writeDoc(fetchedDir, base.hash, buffer, text);
        return {
          ...scraperBase,
          bytes: buffer.byteLength,
          contentType: "text/markdown; charset=utf-8",
          reason: null,
          status: "ok",
        };
      } catch {
        return { ...scraperBase, reason: "scraper failed", status: "unreachable" };
      }
    };

    let verdict = guardCache.get(target.origin);
    if (verdict === undefined) {
      verdict = await guard(normalized);
      guardCache.set(target.origin, verdict);
    }
    if (!verdict.allowed) {
      return {
        ...base,
        bytes: 0,
        contentType: null,
        finalUrl: null,
        reason: `SSRF guard: ${verdict.reason}`,
        status: "unreachable",
      };
    }

    let disallowList: string[] = [];
    try {
      disallowList = await robotsDisallows(origin, robotsCache, fetchFn);
    } catch {
      disallowList = [];
    }
    const pathname = target.pathname;
    if (disallowList.some((rule) => pathname.startsWith(rule))) {
      return {
        ...base,
        bytes: 0,
        contentType: null,
        finalUrl: null,
        reason: "robots.txt disallow",
        status: "robots-blocked",
      };
    }

    await respectRateLimit(origin, clock, sleep, now);

    if (tier === "scraper") return runScraper(false);

    try {
      const response = await fetchFn(normalized, {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const contentType = response.headers.get("content-type");
      if (response.status === 403) {
        await response.body?.cancel();
        return runScraper(true);
      }
      if (response.status === 401 || response.status === 402) {
        const body = await readCapped(response, maxBytes);
        writeDoc(fetchedDir, base.hash, body, null);
        return {
          ...base,
          bytes: body.byteLength,
          contentType,
          finalUrl: response.url || null,
          reason: `HTTP ${response.status}`,
          status: "paywalled",
        };
      }
      if (!response.ok) {
        return {
          ...base,
          bytes: 0,
          contentType,
          finalUrl: response.url || null,
          reason: `HTTP ${response.status}`,
          status: "unreachable",
        };
      }
      const buffer = await readCapped(response, maxBytes);
      const isPdf = (contentType ?? "").toLowerCase().includes("application/pdf");
      const text = isPdf ? null : extractText(buffer.toString("utf8"));
      if (text === "") return runScraper(true);
      writeDoc(fetchedDir, base.hash, buffer, text);
      if (isPdf) {
        const rawPath = path.join(fetchedDir, `${base.hash}.raw`);
        const text = await pdfText(rawPath);
        if (text === null) {
          return {
            ...base,
            bytes: buffer.byteLength,
            contentType,
            finalUrl: response.url || null,
            reason: "PDF stored; no text extraction available",
            status: "binary-unreadable",
          };
        }
        fs.writeFileSync(path.join(fetchedDir, `${base.hash}.txt`), text, "utf8");
      }
      return {
        ...base,
        bytes: buffer.byteLength,
        contentType,
        finalUrl: response.url || null,
        reason: null,
        status: "ok",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        bytes: 0,
        contentType: null,
        finalUrl: null,
        reason: message,
        status: "unreachable",
      };
    }
  };

  // Cross-origin concurrency: each origin's URLs run in one sequential
  // queue (preserving the per-domain 1 req/s spacing); up to
  // MAX_PARALLEL_ORIGINS queues run at once. Same-origin URLs never
  // interleave across workers, so the rate limit holds without locks.
  const queuesByOrigin = new Map<string, string[]>();
  for (const normalized of targets) {
    const origin = new URL(normalized).origin;
    const queue = queuesByOrigin.get(origin) ?? [];
    queue.push(normalized);
    queuesByOrigin.set(origin, queue);
  }
  const queues = [...queuesByOrigin.values()];
  let nextQueue = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextQueue;
      nextQueue += 1;
      if (index >= queues.length) return;
      const queue = queues[index];
      if (!queue) continue;
      for (const normalized of queue) {
        results.push(await processTarget(normalized));
      }
    }
  };
  const workerCount = Math.min(MAX_PARALLEL_ORIGINS, queues.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Deterministic ledger order regardless of completion order.
  const targetIndex = new Map(targets.map((normalized, index) => [normalized, index]));
  results.sort(
    (a, b) => (targetIndex.get(a.normalized) ?? 0) - (targetIndex.get(b.normalized) ?? 0),
  );

  // Merge: new results replace prior entries for the same normalized URL;
  // untouched prior entries (retry mode keeps ok pages) survive.
  if (results.length === 0) return [...byNormalized.values()];
  const merged = new Map(byNormalized);
  for (const entry of results) merged.set(entry.normalized, entry);
  const all = [...merged.values()];
  writeLedger(options.runDir, all);
  return all;
}

async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const room = cap - total;
      chunks.push(Buffer.from(value).subarray(0, room));
      total += Math.min(value.byteLength, room);
      if (total >= cap) {
        await reader.cancel();
        break;
      }
    }
  }
  return Buffer.concat(chunks);
}

function writeDoc(fetchedDir: string, hash: string, raw: Buffer, text: string | null): void {
  fs.writeFileSync(path.join(fetchedDir, `${hash}.raw`), raw);
  if (text !== null && text.length > 0) {
    fs.writeFileSync(path.join(fetchedDir, `${hash}.txt`), text, "utf8");
  }
}
