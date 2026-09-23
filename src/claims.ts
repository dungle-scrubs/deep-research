import { z } from "zod";
import { formatZodIssues, parseJsonText } from "./util.js";

export const citationSchema = z.object({
  locator: z.string().min(1),
  sameStudyAs: z.string().url().nullable().optional(),
  title: z.string().min(1),
  url: z.string().url(),
});

export const CLAIM_ID_PATTERN = /^c\d{3,}$/;

export const claimSchema = z.object({
  citations: z.array(citationSchema).min(1),
  flags: z.array(z.string()).default([]),
  id: z.string().regex(CLAIM_ID_PATTERN, "id must match c### (c001, c002, ...)"),
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

export function parseClaims(raw: string):
  | { claims: ClaimsFile; issues: ClaimsIssue[] }
  | {
      claims: null;
      issues: ClaimsIssue[];
    } {
  const { parsed, error } = parseJsonText(raw);
  if (error !== null) {
    return { claims: null, issues: [{ message: `not valid JSON: ${error}`, path: "(root)" }] };
  }
  const result = claimsFileSchema.safeParse(parsed);
  if (result.success) return { claims: result.data, issues: [] };
  return {
    claims: null,
    issues: formatZodIssues(result.error).map((line) => {
      const separator = line.indexOf(": ");
      return { message: line.slice(separator + 2), path: line.slice(0, separator) };
    }),
  };
}
