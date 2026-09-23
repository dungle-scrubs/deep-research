import type { z } from "zod";

/** Shared small utilities used across command modules. */

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ParsedJson {
  readonly parsed: unknown;
  readonly error: string | null;
}

/** Parse JSON text; the error string carries the parse message. */
export function parseJsonText(raw: string): ParsedJson {
  try {
    return { error: null, parsed: JSON.parse(raw) };
  } catch (error) {
    return { error: errorMessage(error), parsed: undefined };
  }
}

/** Format Zod issues as `path: message` lines with a (root) fallback. */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

/** Count occurrences by key; returns a plain object map. */
export function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
