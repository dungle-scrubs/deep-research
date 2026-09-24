import { execFile } from "node:child_process";
import { z } from "zod";

export type ScrapeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

const responseSchema = z.discriminatedUnion("ok", [
  z.object({ error: z.null(), markdown: z.string(), ok: z.literal(true) }),
  z.object({ error: z.string(), ok: z.literal(false) }),
]);

/** The CLI is the scraper package's stable boundary. No shell, service, model,
 *  or third-party reader is involved. The fetch engine owns guard policy and
 *  the stored byte cap; this adapter bounds the subprocess and validates JSON. */
export function scrapePage(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<ScrapeResult> {
  return new Promise((resolve) => {
    execFile(
      "scraper",
      ["scrape", "--timeout", String(Math.ceil(timeoutMs / 1000)), url],
      {
        encoding: "utf8",
        // Do not pass model credentials or caller SCRAPER_* policy overrides.
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          SCRAPER_CRAWL_RENDER_DELAY_SECONDS: "1",
          SCRAPER_JINA_ENABLED: "false",
          SCRAPER_MAX_MARKDOWN_CHARS: String(maxBytes),
          SCRAPER_MAX_RETRIES: "1",
          TMPDIR: process.env.TMPDIR,
        },
        // JSON may escape each character as six ASCII bytes. Bound framing too.
        maxBuffer: maxBytes * 6 + 64 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout) => {
        if (error?.code === "ENOENT") {
          resolve({
            ok: false,
            reason: "scraper is not installed; pipx install dungle-scrubs-scraper",
          });
          return;
        }
        if (error?.killed || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ ok: false, reason: "scraper exceeded its time or output limit" });
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(stdout);
        } catch {
          resolve({ ok: false, reason: "scraper returned invalid JSON or failed to start" });
          return;
        }
        const parsed = responseSchema.safeParse(payload);
        if (!parsed.success) {
          resolve({ ok: false, reason: "scraper returned an invalid response" });
        } else if (!parsed.data.ok) {
          resolve({ ok: false, reason: `scraper: ${parsed.data.error}` });
        } else if (error) {
          resolve({ ok: false, reason: "scraper exited unsuccessfully" });
        } else if (parsed.data.markdown.trim().length === 0) {
          resolve({ ok: false, reason: "scraper returned empty text" });
        } else {
          resolve({ ok: true, text: parsed.data.markdown });
        }
      },
    );
  });
}
