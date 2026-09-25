import { readFileSync } from "node:fs";
import { z } from "zod";
import type { HandlerResult } from "./envelope.js";
import { fail } from "./envelope.js";
import { runPolicySchema } from "./state.js";
import { formatZodIssues } from "./util.js";

export const MODEL_STEPS = [
  "foundation",
  "gaps",
  "followup",
  "claims",
  "verdicts",
  "briefing",
  "synthesis",
] as const;
export type ModelStep = (typeof MODEL_STEPS)[number];
// Choice metadata belongs to choose-model. Preserve its complete snapshot;
// validate every field used at the launch boundary, without scoring it again.
export const routeSchema = z
  .object({
    route: z.string().min(1),
    harness: z.enum(["claude", "codex", "pi", "muse", "cursor", "antigravity"]),
    modelId: z.string().min(1),
    provider: z.string().min(1).nullable(),
    effort: z.string().min(1),
    hosted: z.boolean(),
  })
  .passthrough();
export type Route = Readonly<z.infer<typeof routeSchema>>;
const choiceSchema = z
  .object({
    query: z
      .object({ task: z.string().min(1), privacy: z.enum(["normal", "secret"]).optional() })
      .passthrough(),
    selection: routeSchema,
    fallbacks: z.array(routeSchema),
    excluded: z.array(z.object({ route: z.string(), reason: z.string() }).passthrough()),
    warnings: z.array(z.string()),
  })
  .passthrough();
export type Choice = Readonly<z.infer<typeof choiceSchema>>;
export const driveConfigSchema = z
  .object({
    version: z.literal(1),
    privacy: z.enum(["normal", "secret"]),
    policy: runPolicySchema,
    limits: z
      .object({
        maxAttemptsPerWorkItem: z.number().int().positive(),
        maxWorkItems: z.number().int().positive(),
      })
      .strict(),
    verdicts: z
      .object({ lanes: z.number().int().positive(), claimsPerBatch: z.number().int().positive() })
      .strict(),
    steps: z
      .object({
        brief: z.object({ kind: z.literal("topic") }).strict(),
        foundation: choiceSchema,
        gaps: choiceSchema,
        followup: choiceSchema,
        claims: choiceSchema,
        verdicts: choiceSchema,
        briefing: choiceSchema,
        synthesis: choiceSchema,
      })
      .strict(),
  })
  .strict();
export type DriveConfig = Readonly<z.infer<typeof driveConfigSchema>>;
export function routeChain(choice: Choice): Route[] {
  const seen = new Set<string>();
  return [choice.selection, ...choice.fallbacks].filter((route) => {
    // Aliases cannot grant a second attempt on the same configured route.
    const key = JSON.stringify([route.harness, route.provider, route.modelId, route.effort]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function readDriveConfig(
  file: string,
): { readonly config: DriveConfig } | { readonly result: HandlerResult } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {
      result: fail(1, null, null, [
        `E108: cannot read drive config ${file}; use dr drive --print-config`,
      ]),
    };
  }
  // Missing locality in a secret config is a privacy refusal, not a permissive
  // default. Test this before the general schema reports absent fields.
  if (raw && typeof raw === "object" && "privacy" in raw && raw.privacy === "secret") {
    const secretShape = z.object({ steps: z.record(z.string(), z.unknown()) }).safeParse(raw);
    if (secretShape.success) {
      for (const step of MODEL_STEPS) {
        const choice = z
          .object({
            query: z.object({ privacy: z.literal("secret") }),
            selection: z.object({ hosted: z.literal(false) }),
            fallbacks: z.array(z.object({ hosted: z.literal(false) })),
          })
          .safeParse(secretShape.data.steps[step]);
        if (!choice.success)
          return {
            result: fail(1, null, null, [
              `E109: ${step}: secret privacy requires a secret query and explicitly local candidates throughout the chain`,
            ]),
          };
      }
    }
  }
  const parsed = driveConfigSchema.safeParse(raw);
  if (!parsed.success)
    return {
      result: fail(1, null, null, [
        `E108: invalid drive config: ${formatZodIssues(parsed.error).join("; ")}; use dr drive --print-config`,
      ]),
    };
  for (const step of MODEL_STEPS) {
    const choice = parsed.data.steps[step];
    if (choice.query.privacy === "secret" && parsed.data.privacy !== "secret")
      return {
        result: fail(1, null, null, [
          "E109: a secret step query requires top-level secret privacy",
        ]),
      };
    for (const route of routeChain(choice)) {
      if (route.harness !== "pi" && route.provider !== null)
        return {
          result: fail(1, null, null, [`E108: ${step}: provider is supported only for pi`]),
        };
    }
  }
  return { config: parsed.data };
}

/** No fabricated routes: null choices deliberately fail until replaced with
 * complete choose-model results. The fixed pipeline is two search passes. */
export function driveConfigTemplate(): Record<string, unknown> {
  return {
    version: 1,
    privacy: "normal",
    policy: { minDistinctCitations: 2 },
    limits: { maxAttemptsPerWorkItem: 3, maxWorkItems: 1000 },
    verdicts: { lanes: 2, claimsPerBatch: 20 },
    steps: {
      brief: { kind: "topic" },
      ...Object.fromEntries(MODEL_STEPS.map((step) => [step, null])),
    },
  };
}
