import { z } from "zod";

export const citationSchema = z.object({
  locator: z.string().min(1),
  sameStudyAs: z.string().url().nullable().optional(),
  title: z.string().min(1),
  url: z.string().url(),
});

export const claimSchema = z.object({
  citations: z.array(citationSchema).min(1),
  flags: z.array(z.string()).default([]),
  id: z.string().regex(/^c\d{3,}$/, "id must match c### (c001, c002, ...)"),
  notes: z.string().default(""),
  statement: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

export const claimsFileSchema = z.array(claimSchema).min(1);

export type Citation = z.infer<typeof citationSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type ClaimsFile = z.infer<typeof claimsFileSchema>;

export interface ClaimsIssue {
  readonly path: string;
  readonly message: string;
}

/** Parse steps/claims.json content. Returns Zod issues formatted one per
 *  line; an empty issues array means the file is valid. */
export function parseClaims(raw: string):
  | { claims: ClaimsFile; issues: ClaimsIssue[] }
  | {
      claims: null;
      issues: ClaimsIssue[];
    } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { claims: null, issues: [{ message: `not valid JSON: ${message}`, path: "(root)" }] };
  }
  const result = claimsFileSchema.safeParse(parsed);
  if (result.success) return { claims: result.data, issues: [] };
  return {
    claims: null,
    issues: result.error.issues.map((issue) => ({
      message: issue.message,
      path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    })),
  };
}
