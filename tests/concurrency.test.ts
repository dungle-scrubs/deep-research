import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchAll } from "../src/fetch.js";

const permissiveGuard = async () => ({ allowed: true }) as const;

// Two loopback servers on different ports = two origins for the
// concurrency engine, without touching the network.
async function startServer(handler: http.RequestListener): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("fetch concurrency", () => {
  it("runs different origins in parallel while same-origin stays sequential", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-conc-"));
    const origins: { baseUrl: string; close: () => Promise<void> }[] = [];
    const handlers: http.RequestListener[] = [];
    const inFlight = { count: 0, max: 0 };
    const makeHandler = (): http.RequestListener => (req, res) => {
      inFlight.count += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.count);
      setTimeout(() => {
        inFlight.count -= 1;
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>doc ${req.url}</body></html>`);
      }, 120);
    };
    for (let i = 0; i < 4; i += 1) handlers.push(makeHandler());
    for (const handler of handlers) origins.push(await startServer(handler));
    try {
      // Four origins, one URL each: no per-domain rate-limit waits, so
      // sequential execution costs 4 x 120ms while concurrent runs in
      // about one round.
      const started = Date.now();
      const entries = await fetchAll({
        guard: permissiveGuard,
        runDir: workdir,
        urls: origins.map((origin, i) => `${origin.baseUrl}/doc-${i}`),
      });
      const elapsed = Date.now() - started;
      expect(entries).toHaveLength(4);
      expect(entries.every((entry) => entry.status === "ok")).toBe(true);
      // Overlap observed across origins.
      expect(inFlight.max).toBeGreaterThanOrEqual(2);
      // 4 x 120ms sequential = 480ms+; concurrent lands near ~130ms.
      expect(elapsed).toBeLessThan(400);
    } finally {
      for (const origin of origins) await origin.close();
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("keeps same-origin requests spaced by the rate limit", async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-rate-"));
    const sleeps: number[] = [];
    let clock = 1_000_000;
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>x</body></html>");
    });
    try {
      const entries = await fetchAll({
        guard: permissiveGuard,
        now: () => new Date(clock),
        runDir: workdir,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        urls: [`${server.baseUrl}/a`, `${server.baseUrl}/b`],
      });
      expect(entries.every((entry) => entry.status === "ok")).toBe(true);
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
      expect(sleeps[0]).toBeGreaterThanOrEqual(900);
    } finally {
      await server.close();
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
});
