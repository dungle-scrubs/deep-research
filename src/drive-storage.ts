import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { MODEL_STEPS, routeSchema } from "./drive-config.js";
import { runLayout } from "./rundir.js";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function savePrivate(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flush: true });
  renameSync(temp, file);
}
export function saveJson(file: string, value: unknown): void {
  savePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}
const attemptSchema = z.object({
  route: routeSchema,
  number: z.number().int().positive(),
  directory: z.string(),
  outcome: z.enum(["launching", "result", "unavailable", "stopped", "question", "internal"]),
  failureClass: z.string().optional(),
  candidate: z.string().optional(),
  candidateHash: z.string().optional(),
  question: z
    .object({
      question: z.string(),
      options: z.array(z.string()),
      recommended: z.string().optional(),
    })
    .optional(),
  sessionId: z.string().optional(),
});
export type Attempt = z.infer<typeof attemptSchema>;
const workSchema = z.object({
  id: z.string(),
  step: z.enum(MODEL_STEPS),
  inputHash: z.string(),
  pairs: z.array(z.object({ claimId: z.string(), url: z.string() })),
  conflicts: z.array(z.string()),
  batch: z.number().optional(),
  attempts: z.array(attemptSchema),
  gateFailed: z.boolean().default(false),
  submitted: z.boolean().default(false),
});
export type WorkRecord = z.infer<typeof workSchema>;
const journalSchema = z.object({
  version: z.literal(1),
  configHash: z.string(),
  recovery: z.enum(["pending", "started", "done"]),
  evidenceHash: z.string().optional(),
  work: z.array(workSchema),
  diagnostics: z
    .array(z.object({ claimId: z.string(), reachable: z.number(), required: z.number() }))
    .default([]),
});
export type DriveJournal = z.infer<typeof journalSchema>;
export function loadJournal(run: string, configHash: string): DriveJournal {
  const file = runLayout(run).driveJournalFile;
  if (!existsSync(file))
    return { version: 1, configHash, recovery: "pending", work: [], diagnostics: [] };
  const journal = journalSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (journal.configHash !== configHash)
    throw new Error("E108: frozen config differs from the recorded work plan");
  return journal;
}
