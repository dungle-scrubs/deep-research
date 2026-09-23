import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { runLayout } from "./rundir.js";
import { STEP_ORDER, type StepName } from "./steps.js";
import { formatZodIssues, parseJsonText } from "./util.js";

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

/** Parse state.json with the Zod schema (the schema is the type source).
 *  refine checks that need isStepName narrow the parsed value after. */
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
  runStateSchema.parse({
    completed: [...state.completed],
    created: state.created,
    step: state.step,
    topic: state.topic,
    version: state.version,
  });
  fs.mkdirSync(layout.stateDir, { recursive: true });
  const tmp = path.join(layout.stateDir, `state.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, layout.stateFile);
}

export function initialState(topic: string, created: string, step: StepName): RunState {
  return { completed: [], created, step, topic, version: 1 };
}
