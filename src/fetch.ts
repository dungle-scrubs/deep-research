import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { runLayout } from "./rundir.js";
import { type GuardVerdict, guardUrl } from "./ssrf.js";
import { normalizeUrl, urlHash } from "./url.js";

export const MAX_BYTES = 5 * 1024 * 1024;
export const TIMEOUT_MS = 15_000;

export type FetchStatus =
  | "ok"
  | "unreachable"
  | "paywalled"
  | "binary-unreadable"
  | "robots-blocked";

export interface LedgerEntry {
  readonly url: string;
  readonly normalized: string;
  readonly hash: string;
  readonly status: FetchStatus;
  readonly finalUrl: string | null;
  readonly contentType: string | null;
  readonly bytes: number;
  readonly reason: string | null;
  readonly fetchedAt: string;
  readonly attempts: number;
}

export function readLedger(runDir: string): LedgerEntry[] {
  try {
    const raw = fs.readFileSync(runLayout(runDir).ledgerFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
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

/** Fetch every unique normalized URL once, write fetched/<hash>.raw and
 *  .txt, and record every outcome in the ledger. Never throws: every
 *  failure is an outcome. */
export async function fetchAll(options: FetchEngineOptions): Promise<LedgerEntry[]> {
  const guard = options.guard ?? guardUrl;
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => new Date());
  const previous = readLedger(options.runDir);
  const byNormalized = new Map(previous.map((entry) => [entry.normalized, entry]));

  const targets = [...new Set(options.urls.map(normalizeUrl))].filter((normalized) => {
    if (!options.retryOnly) return true;
    const prior = byNormalized.get(normalized);
    return prior === undefined || prior.status !== "ok";
  });

  const fetchedDir = runLayout(options.runDir).fetchedDir;
  fs.mkdirSync(fetchedDir, { recursive: true });
  const robotsCache: RobotsCache = new Map();
  const guardCache = new Map<string, GuardVerdict>();
  const clock: PerDomainClock = { lastHit: new Map() };
  const results: LedgerEntry[] = [];

  for (const normalized of targets) {
    const prior = byNormalized.get(normalized);
    const attempts = (prior?.attempts ?? 0) + 1;
    const target = new URL(normalized);
    const base = {
      hash: urlHash(normalized),
      normalized,
      url: prior?.url ?? normalized,
      attempts,
      fetchedAt: now().toISOString(),
    };

    let verdict = guardCache.get(target.origin);
    if (verdict === undefined) {
      verdict = await guard(normalized);
      guardCache.set(target.origin, verdict);
    }
    if (!verdict.allowed) {
      results.push({
        ...base,
        bytes: 0,
        contentType: null,
        finalUrl: null,
        reason: `SSRF guard: ${verdict.reason}`,
        status: "unreachable",
      });
      continue;
    }

    const origin = target.origin;
    let disallowList: string[] = [];
    try {
      disallowList = await robotsDisallows(origin, robotsCache, fetchFn);
    } catch {
      disallowList = [];
    }
    const pathname = target.pathname;
    if (disallowList.some((rule) => pathname.startsWith(rule))) {
      results.push({
        ...base,
        bytes: 0,
        contentType: null,
        finalUrl: null,
        reason: "robots.txt disallow",
        status: "robots-blocked",
      });
      continue;
    }

    await respectRateLimit(origin, clock, sleep, now);

    try {
      const response = await fetchFn(normalized, {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const contentType = response.headers.get("content-type");
      if (response.status === 401 || response.status === 402) {
        const body = Buffer.from(await response.arrayBuffer());
        writeDoc(fetchedDir, base.hash, body, null);
        results.push({
          ...base,
          bytes: body.byteLength,
          contentType,
          finalUrl: response.url || null,
          reason: `HTTP ${response.status}`,
          status: "paywalled",
        });
        continue;
      }
      if (!response.ok) {
        results.push({
          ...base,
          bytes: 0,
          contentType,
          finalUrl: response.url || null,
          reason: `HTTP ${response.status}`,
          status: "unreachable",
        });
        continue;
      }
      const buffer = await readCapped(response, options.maxBytes ?? MAX_BYTES);
      const isPdf = (contentType ?? "").toLowerCase().includes("application/pdf");
      writeDoc(fetchedDir, base.hash, buffer, isPdf ? null : extractText(buffer.toString("utf8")));
      if (isPdf) {
        const rawPath = path.join(fetchedDir, `${base.hash}.raw`);
        const text = await pdfText(rawPath);
        if (text === null) {
          results.push({
            ...base,
            bytes: buffer.byteLength,
            contentType,
            finalUrl: response.url || null,
            reason: "PDF stored; no text extraction available",
            status: "binary-unreadable",
          });
          continue;
        }
        fs.writeFileSync(path.join(fetchedDir, `${base.hash}.txt`), text, "utf8");
      }
      results.push({
        ...base,
        bytes: buffer.byteLength,
        contentType,
        finalUrl: response.url || null,
        reason: null,
        status: "ok",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        ...base,
        bytes: 0,
        contentType: null,
        finalUrl: null,
        reason: message,
        status: "unreachable",
      });
    }
  }

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
