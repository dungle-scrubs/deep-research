import * as fs from "node:fs";
import type { ClaimsFile } from "./claims.js";
import { parseClaims } from "./claims.js";
import { type LedgerEntry, readLedger } from "./fetch.js";
import { readMatrixFile } from "./report.js";
import { runLayout } from "./rundir.js";
import { readState } from "./state.js";
import type { Matrix } from "./verdicts.js";

/** Structured citation export: the join of claims.json, matrix.json, and
 *  the fetch ledger, grouped by document. A pure function of the run
 *  directory; nothing here re-derives statuses. */

export interface CitedBy {
  readonly claimId: string;
  readonly statement: string;
  readonly locator: string;
  readonly verdict: string | null;
  readonly claimStatus: string;
}

export interface FetchInfo {
  readonly status: string;
  readonly finalUrl: string | null;
  readonly contentType: string | null;
  readonly fetchedAt: string;
}

export interface CitationDocument {
  readonly url: string;
  readonly normalized: string;
  readonly title: string;
  readonly tiers: readonly number[];
  readonly fetch: FetchInfo;
  readonly citedBy: readonly CitedBy[];
}

export interface UnfetchedDocument {
  readonly url: string;
  readonly reason: string;
  readonly citedBy: readonly { claimId: string; claimStatus: string }[];
}

export interface CitationsExport {
  readonly run: string;
  readonly topic: string;
  readonly generatedAt: string;
  readonly documents: readonly CitationDocument[];
  readonly unfetched: readonly UnfetchedDocument[];
}

export class CitationsUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CitationsUnavailableError";
  }
}

/** Render the citation export for a run. Throws CitationsUnavailableError
 *  when the run has not reached derivation yet. */
export function renderCitations(runDir: string, generatedAt: string): CitationsExport {
  const layout = runLayout(runDir);
  const state = readState(runDir);
  let matrix: Matrix;
  let claims: ClaimsFile;
  try {
    matrix = readMatrixFile(runDir);
  } catch {
    throw new CitationsUnavailableError(
      "state/matrix.json is missing; citations exist after the verdicts step fulfills",
    );
  }
  const claimsRaw = fs.readFileSync(layout.step("claims.json"), "utf8");
  const parsed = parseClaims(claimsRaw);
  if (!parsed.claims) throw new CitationsUnavailableError("steps/claims.json does not validate");
  claims = parsed.claims;
  const ledger = new Map(readLedger(runDir).map((entry: LedgerEntry) => [entry.normalized, entry]));

  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const statusById = new Map(matrix.claims.map((claim) => [claim.id, claim.status]));

  // citation lookup keyed by claim id + normalized url, for locator/title
  const citationMeta = new Map<string, { locator: string; title: string; url: string }>();
  for (const claim of claims) {
    for (const citation of claim.citations) {
      citationMeta.set(`${claim.id}|${citation.url}`, {
        locator: citation.locator,
        title: citation.title,
        url: citation.url,
      });
    }
  }

  const fetchedGroups = new Map<string, CitationDocument>();
  const unfetchedGroups = new Map<string, UnfetchedDocument>();

  for (const matrixClaim of matrix.claims) {
    for (const row of matrixClaim.citations) {
      const meta = citationMeta.get(`${matrixClaim.id}|${row.url}`);
      const citedBy: CitedBy = {
        claimId: matrixClaim.id,
        claimStatus: statusById.get(matrixClaim.id) ?? matrixClaim.status,
        locator: meta?.locator ?? "",
        statement: claimById.get(matrixClaim.id)?.statement ?? "",
        verdict: row.verdict,
      };
      if (row.reachable) {
        const ledgerEntry = ledger.get(row.normalized);
        const existing = fetchedGroups.get(row.document);
        if (existing) {
          fetchedGroups.set(row.document, {
            ...existing,
            citedBy: [...existing.citedBy, citedBy],
            tiers: [
              ...new Set([...existing.tiers, claimById.get(matrixClaim.id)?.tier ?? 0]),
            ].sort(),
          });
        } else {
          fetchedGroups.set(row.document, {
            citedBy: [citedBy],
            fetch: {
              contentType: ledgerEntry?.contentType ?? null,
              fetchedAt: ledgerEntry?.fetchedAt ?? "",
              finalUrl: ledgerEntry?.finalUrl ?? null,
              status: ledgerEntry?.status ?? "not-fetched",
            },
            normalized: row.normalized,
            tiers: [claimById.get(matrixClaim.id)?.tier ?? 0],
            title: meta?.title ?? "",
            url: row.url,
          });
        }
      } else {
        const existing = unfetchedGroups.get(row.document);
        const entry = { claimId: matrixClaim.id, claimStatus: citedBy.claimStatus };
        if (existing) {
          unfetchedGroups.set(row.document, { ...existing, citedBy: [...existing.citedBy, entry] });
        } else {
          unfetchedGroups.set(row.document, {
            citedBy: [entry],
            reason: row.ledgerStatus ?? "not-fetched",
            url: row.url,
          });
        }
      }
    }
  }

  const byUrl = (a: { url: string }, b: { url: string }) =>
    a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  const documents = [...fetchedGroups.values()]
    .map((doc) => ({
      ...doc,
      citedBy: [...doc.citedBy].sort((a, b) => (a.claimId < b.claimId ? -1 : 1)),
    }))
    .sort(byUrl);
  const unfetched = [...unfetchedGroups.values()].sort(byUrl);

  return { documents, generatedAt, run: runDir, topic: state.topic, unfetched };
}
