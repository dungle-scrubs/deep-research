import type { ClaimsFile } from "./claims.js";
import { normalizeUrl } from "./url.js";

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

export function documentsFor(claims: ClaimsFile): DocumentSet {
  const documents = new DocumentSet();
  for (const claim of claims) {
    for (const citation of claim.citations) documents.add(citation.url, citation.sameStudyAs);
  }
  return documents;
}
