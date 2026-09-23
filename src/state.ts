import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { isStepName, STEP_ORDER, type StepName } from "./steps.js";

const stepSchema = z.enum(STEP_ORDER);

const runStateSchema = z.object({
  completed: z.array(stepSchema),
  created: z.string(),
  step: z.union([stepSchema, z.literal("done")]),
  topic: z.string(),
  version: z.literal(1),
});

export interface RunState {
  readonly version: 1;
  readonly topic: string;
  readonly created: string;
  readonly step: StepName | "done";
  readonly completed: readonly StepName[];
}

export function statePath(runDir: string): string {
  return path.join(runDir, "state", "state.json");
}

/** Parse state.json with the Zod schema (the schema is the type source).
 *  refine checks that need isStepName narrow the parsed value after. */
export function readState(runDir: string): RunState {
  const raw = fs.readFileSync(statePath(runDir), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`state.json is not valid JSON in ${runDir}: ${message}`);
  }
  const result = runStateSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`state.json failed validation in ${runDir}: ${issues}`);
  }
  const data = result.data;
  if (data.step !== "done" && !isStepName(data.step)) {
    throw new Error(`state.json has an unknown step in ${runDir}`);
  }
  for (const name of data.completed) {
    if (!isStepName(name)) throw new Error(`state.json has an unknown completed step in ${runDir}`);
  }
  return {
    completed: data.completed.filter(isStepName),
    created: data.created,
    step: data.step === "done" ? "done" : data.step,
    topic: data.topic,
    version: 1,
  };
}

export function writeState(runDir: string, state: RunState): void {
  // Validate our own writes against the same schema.
  runStateSchema.parse({
    completed: [...state.completed],
    created: state.created,
    step: state.step,
    topic: state.topic,
    version: state.version,
  });
  const dir = path.join(runDir, "state");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `state.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, path.join(dir, "state.json"));
}

export function initialState(topic: string, created: string, step: string): RunState {
  if (!isStepName(step)) throw new Error(`unknown initial step: ${step}`);
  return { completed: [], created, step, topic, version: 1 };
}
