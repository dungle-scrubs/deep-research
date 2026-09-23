import { z } from "zod";
import { CLAIM_ID_PATTERN, type ClaimsFile } from "./claims.js";
import { type FetchStatus, readLedger } from "./fetch.js";
import { normalizeUrl } from "./url.js";
import { formatZodIssues, parseJsonText } from "./util.js";

export const verdictValueSchema = z.enum(["supported", "partial", "not-found", "contradicts"]);

export const verdictEntrySchema = z.union([
  z.object({
    claimId: z.string().regex(CLAIM_ID_PATTERN),
    note: z.string().default(""),
    url: z.string().url(),
    verdict: verdictValueSchema,
  }),
  z.object({
    claimId: z.string().regex(CLAIM_ID_PATTERN),
    conflict: z.literal(true),
    note: z.string().default(""),
  }),
]);

export const verdictsFileSchema = z.array(verdictEntrySchema).min(1);

export type VerdictEntry = z.infer<typeof verdictEntrySchema>;

export type ClaimStatus =
  | "verified"
  | "single-source"
  | "misrepresented"
  | "not-found"
  | "conflict"
  | "unreachable";

export interface CitationRow {
  readonly claimId: string;
  readonly url: string;
  readonly normalized: string;
  readonly document: string;
  readonly verdict: z.infer<typeof verdictValueSchema> | null;
  readonly reachable: boolean;
  readonly ledgerStatus: FetchStatus | null;
}

export interface MatrixClaim {
  readonly id: string;
  readonly statement: string;
  readonly tier: 1 | 2 | 3;
  readonly status: ClaimStatus;
  readonly citations: readonly CitationRow[];
}

export interface Matrix {
  readonly version: 1;
  readonly derivedAt: string;
  readonly claims: readonly MatrixClaim[];
  readonly coverage: Record<string, Record<string, number>>;
  readonly caveats: readonly string[];
}

export interface VerdictIssue {
  readonly message: string;
  readonly path: string;
}

/** Union-find over documents: nodes are normalized URLs; sameStudyAs
 *  links merge two citations into one document. */
export class DocumentSet {
  private readonly parent = new Map<string, string>();

  private find(node: string): string {
    let root = node;
    for (;;) {
      const next = this.parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    // Path compression.
    let current = node;
    for (;;) {
      const next = this.parent.get(current);
      if (next === undefined || next === root) break;
      this.parent.set(current, root);
      current = next;
    }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }

  add(url: string, sameStudyAs?: string | null): void {
    const a = normalizeUrl(url);
    if (!this.parent.has(a)) this.parent.set(a, a);
    if (sameStudyAs) {
      const b = normalizeUrl(sameStudyAs);
      if (!this.parent.has(b)) this.parent.set(b, b);
      const rootA = this.find(a);
      const rootB = this.find(b);
      if (rootA !== rootB) {
        // Deterministic canonical: lexicographically smaller root wins.
        const [winner, loser] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
        this.parent.set(loser, winner);
      }
    }
  }

  documentOf(url: string): string {
    return this.find(normalizeUrl(url));
  }
}

/** Validate the verdict file against claims + ledger context. Returns
 *  formatted issues; empty means the file can drive derivation. */
export function validateVerdicts(
  raw: string,
  claims: ClaimsFile,
): { entries: VerdictEntry[]; issues: VerdictIssue[] } {
  const { parsed, error } = parseJsonText(raw);
  if (error !== null) {
    return { entries: [], issues: [{ message: `not valid JSON: ${error}`, path: "(root)" }] };
  }
  const result = verdictsFileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      entries: [],
      issues: formatZodIssues(result.error).map((line) => {
        const separator = line.indexOf(": ");
        return { message: line.slice(separator + 2), path: line.slice(0, separator) };
      }),
    };
  }
  const entries = result.data;
  const issues: VerdictIssue[] = [];
  const citationsByClaim = new Map<string, Set<string>>();
  for (const claim of claims) {
    citationsByClaim.set(
      claim.id,
      new Set(claim.citations.map((citation) => normalizeUrl(citation.url))),
    );
  }
  const seenPairs = new Set<string>();
  const conflictsFor = new Set<string>();
  entries.forEach((entry, index) => {
    const knownCitations = citationsByClaim.get(entry.claimId);
    if (knownCitations === undefined) {
      issues.push({ message: `unknown claimId ${entry.claimId}`, path: `${index}` });
      return;
    }
    if ("conflict" in entry) {
      if (conflictsFor.has(entry.claimId)) {
        issues.push({ message: `duplicate conflict entry for ${entry.claimId}`, path: `${index}` });
      }
      conflictsFor.add(entry.claimId);
      return;
    }
    const normalized = normalizeUrl(entry.url);
    if (!knownCitations.has(normalized)) {
      issues.push({
        message: `${entry.url} is not a citation of ${entry.claimId}`,
        path: `${index}.url`,
      });
    }
    const pairKey = `${entry.claimId}|${normalized}`;
    if (seenPairs.has(pairKey)) {
      issues.push({
        message: `duplicate verdict for ${entry.claimId} on ${entry.url}`,
        path: `${index}`,
      });
    }
    seenPairs.add(pairKey);
  });
  return { entries, issues };
}

/** Derive every claim status. Deterministic: same claims + verdicts +
 *  ledger always produce the same matrix. */
export function deriveMatrix(
  claims: ClaimsFile,
  entries: readonly VerdictEntry[],
  runDir: string,
  derivedAt: string,
): Matrix {
  const documents = new DocumentSet();
  for (const claim of claims) {
    for (const citation of claim.citations) documents.add(citation.url, citation.sameStudyAs);
  }
  const ledger = new Map(readLedger(runDir).map((entry) => [entry.normalized, entry.status]));
  const verdictFor = new Map<string, z.infer<typeof verdictValueSchema>>();
  const conflictClaims = new Set<string>();
  for (const entry of entries) {
    if ("conflict" in entry) conflictClaims.add(entry.claimId);
    else verdictFor.set(`${entry.claimId}|${normalizeUrl(entry.url)}`, entry.verdict);
  }

  const matrixClaims: MatrixClaim[] = claims.map((claim) => {
    const rows: CitationRow[] = claim.citations.map((citation) => {
      const normalized = normalizeUrl(citation.url);
      const ledgerStatus = ledger.get(normalized) ?? null;
      // Unreachable and robots-blocked documents carry no fetched evidence.
      const reachable =
        ledgerStatus === null ||
        (ledgerStatus !== "unreachable" && ledgerStatus !== "robots-blocked");
      return {
        claimId: claim.id,
        document: documents.documentOf(citation.url),
        ledgerStatus,
        normalized,
        reachable,
        url: citation.url,
        verdict: verdictFor.get(`${claim.id}|${normalized}`) ?? null,
      };
    });
    return {
      citations: rows,
      id: claim.id,
      statement: claim.statement,
      status: statusFor(rows, conflictClaims.has(claim.id)),
      tier: claim.tier,
    };
  });

  const coverage: Record<string, Record<string, number>> = {};
  for (const claim of matrixClaims) {
    const tierKey = `tier${claim.tier}`;
    coverage[tierKey] ??= {};
    coverage[tierKey][claim.status] = (coverage[tierKey][claim.status] ?? 0) + 1;
  }

  const caveats: string[] = [];
  for (const claim of matrixClaims) {
    for (const row of claim.citations) {
      if (!row.reachable) {
        caveats.push(
          `${claim.id}: citation ${row.url} is ${row.ledgerStatus ?? "not-fetched"}; source-not-checked`,
        );
      }
    }
  }

  return { caveats, claims: matrixClaims, coverage, derivedAt, version: 1 };
}

function statusFor(rows: readonly CitationRow[], conflict: boolean): ClaimStatus {
  if (conflict) return "conflict";
  const supportedDocuments = new Set<string>();
  let anyContradicts = false;
  let anyReachable = false;
  for (const row of rows) {
    if (!row.reachable) continue;
    anyReachable = true;
    if (row.verdict === "supported") supportedDocuments.add(row.document);
    if (row.verdict === "contradicts") anyContradicts = true;
  }
  if (supportedDocuments.size >= 2) return "verified";
  if (supportedDocuments.size === 1) return "single-source";
  if (anyContradicts) return "misrepresented";
  if (!anyReachable && rows.length > 0) return "unreachable";
  return "not-found";
}
