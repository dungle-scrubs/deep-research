import * as fs from "node:fs";
import * as path from "node:path";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { writePrompts } from "../prompts.js";
import { resolveRoot } from "../run.js";
import { createRunDirectory, runLayout } from "../rundir.js";
import {
  initialState,
  type RunPolicy,
  type RunState,
  readState,
  runPolicySchema,
  writeState,
} from "../state.js";
import { isStepName, nextStep, type StepName } from "../steps.js";
import { errorMessage } from "../util.js";

export interface NewOptions {
  readonly topic: string;
  readonly policy?: RunPolicy;
  readonly rootFlag?: string | undefined;
  /** False names the directory without the topic slug (secret drive
   *  runs). The topic is still recorded inside the run; only the
   *  stdout-visible path is content-free. */
  readonly nameTopic?: boolean;
}

export function cmdNew(options: NewOptions, onCreated?: (runDir: string) => void): HandlerResult {
  if (options.policy && !runPolicySchema.safeParse(options.policy).success) {
    return fail(1, null, null, ["E106: min-distinct-citations must be a positive integer"]);
  }
  const topic = options.topic.trim();
  if (topic.length === 0) {
    return fail(1, null, null, [
      "E101: topic must not be empty; usage: dr new <topic> [--root <dir>]",
    ]);
  }
  const root = resolveRoot({ rootFlag: options.rootFlag });
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (error) {
    return fail(1, null, null, [`E101: cannot use root ${root}: ${errorMessage(error)}`]);
  }
  let runDir: string | null = null;
  try {
    // A content-free directory name keeps the topic out of any logged run
    // reference. The topic is still recorded inside the run.
    runDir = createRunDirectory(root, options.nameTopic === false ? "run" : topic);
    onCreated?.(runDir);
    writePrompts(runDir, topic);
    const created = new Date().toISOString();
    writeState(runDir, {
      ...initialState(topic, created, "brief"),
      ...(options.policy ? { policy: options.policy } : {}),
    });
  } catch (error) {
    return fail(4, runDir, null, [`E401: failed to create run: ${errorMessage(error)}`]);
  }
  const human =
    `Created run ${runDir}\n` +
    `Topic: ${topic}\n` +
    `Next: dr next (step: brief; write to steps/brief.md, then dr fulfill brief <file>)`;
  return ok(runDir, "brief", human, { dir: runDir, topic });
}

export interface LocateOptions {
  readonly runRoot?: string | undefined;
}

/** Locate the single run directory under root. A run directory is a
 *  directory containing state/state.json. */
export function locateRun(root: string, options: LocateOptions = {}): string | null {
  const explicit = options.runRoot;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (fs.existsSync(runLayout(resolved).stateFile)) return resolved;
    return null;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const runs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(runLayout(dir).stateFile))
    .sort();
  if (runs.length === 0) {
    // The root itself may be a run directory (e.g. --root points at it).
    if (fs.existsSync(runLayout(root).stateFile)) return root;
    return null;
  }
  // Deterministic: newest dated name wins (names sort chronologically).
  return runs[runs.length - 1] ?? null;
}

export function noRunFound(root: string): HandlerResult {
  return fail(
    1,
    null,
    null,
    [`E102: no run found under ${root}; run \`dr new <topic>\` first or pass --root`],
    `No run found under ${root}.\nRun \`dr new <topic>\` first or pass --root <dir>.`,
  );
}

export type StateOrFail = { state: RunState } | { result: HandlerResult };

/** Read state.json or produce the E401 failure envelope. */
export function loadStateOrFail(runDir: string, step: StepName | null): StateOrFail {
  try {
    return { state: readState(runDir) };
  } catch (error) {
    return {
      result: fail(4, runDir, step, [`E401: cannot read run state: ${errorMessage(error)}`]),
    };
  }
}

/** The E202 failure for a fulfill/execute on a non-takeable step. */
export function notTakeable(runDir: string, want: string, actual: string): HandlerResult {
  return fail(
    2,
    runDir,
    actual,
    [`E202: step ${want} is not takeable; the takeable step is ${actual}`],
    `Step ${want} is not takeable now. The takeable step is ${actual}.`,
  );
}

/** Persist the advance to the next step after completing `completed`. */
export function advanceState(runDir: string, state: RunState, completed: StepName): void {
  writeState(runDir, {
    ...state,
    completed: [...state.completed, completed],
    step: nextStep(completed),
  });
}

export function readStepArg(raw: string): StepName | null {
  const trimmed = raw.trim();
  if (isStepName(trimmed)) return trimmed;
  return null;
}
