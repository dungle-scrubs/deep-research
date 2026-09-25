import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { runLayout } from "./rundir.js";
import { STEP_ORDER, type StepName } from "./steps.js";
import { formatZodIssues, parseJsonText } from "./util.js";
import { verdictsFileSchema } from "./verdicts.js";

const stepSchema = z.enum(STEP_ORDER);

export const runPolicySchema = z
  .object({ minDistinctCitations: z.number().int().positive() })
  .strict();
export type RunPolicy = Readonly<z.infer<typeof runPolicySchema>>;

const runStateSchema = z.object({
  completed: z.array(stepSchema),
  created: z.string(),
  policy: runPolicySchema.optional(),
  step: z.union([stepSchema, z.literal("done")]),
  topic: z.string(),
  // Commit accepted batches and the step transition together. Missing history
  // identifies an existing run that has not fulfilled an incremental batch.
  verdictBatches: z.array(verdictsFileSchema).optional(),
  version: z.literal(1),
});

export type RunState = Readonly<z.infer<typeof runStateSchema>>;

/** Parse persisted run state and accepted batch history at the boundary. */
export function readState(runDir: string): RunState {
  const raw = fs.readFileSync(runLayout(runDir).stateFile, "utf8");
  const { parsed, error } = parseJsonText(raw);
  if (error !== null) throw new Error(`state.json is not valid JSON in ${runDir}: ${error}`);
  const result = runStateSchema.safeParse(parsed);
  if (!result.success) {
    const issues = formatZodIssues(result.error).join("; ");
    throw new Error(`state.json failed validation in ${runDir}: ${issues}`);
  }
  return result.data;
}

export function writeState(runDir: string, state: RunState): void {
  const layout = runLayout(runDir);
  runStateSchema.parse(state);
  fs.mkdirSync(layout.stateDir, { recursive: true });
  const tmp = path.join(layout.stateDir, `state.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, layout.stateFile);
}

export function initialState(topic: string, created: string, step: StepName): RunState {
  return { completed: [], created, step, topic, version: 1 };
}
