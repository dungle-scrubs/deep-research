import { createHash } from "node:crypto";

/** Tracking query parameters stripped during normalization. */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "referrer",
  "spm",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
  "vero_id",
  "vero_conv",
]);

export function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  // Trailing-slash equivalence: no path slash on a bare host path.
  if (url.pathname === "/" && url.search === "") url.pathname = "";
  const params = [...url.searchParams.entries()].filter(
    ([key]) => !TRACKING_PARAMS.has(key.toLowerCase()),
  );
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);
  return url.toString();
}

export function urlHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
