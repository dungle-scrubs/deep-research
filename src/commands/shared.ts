import * as fs from "node:fs";
import * as path from "node:path";
import { fail, type HandlerResult, ok } from "../envelope.js";
import { writePrompts } from "../prompts.js";
import { resolveRoot, uniqueRunDir } from "../run.js";
import { initialState, statePath, writeState } from "../state.js";
import { isStepName, STEPS, type StepName } from "../steps.js";

export interface NewOptions {
  readonly topic: string;
  readonly rootFlag?: string | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cmdNew(_runRoot: string, options: NewOptions): HandlerResult {
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
  const runDir = uniqueRunDir(root, topic);
  try {
    fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
    fs.mkdirSync(path.join(runDir, "fetched"), { recursive: true });
    writePrompts(runDir, topic);
    const created = new Date().toISOString();
    writeState(runDir, initialState(topic, created, "brief"));
  } catch (error) {
    return fail(4, null, null, [`E401: failed to create run: ${errorMessage(error)}`]);
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
    if (fs.existsSync(statePath(resolved))) return resolved;
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
    .filter((dir) => fs.existsSync(statePath(dir)))
    .sort();
  if (runs.length === 0) {
    // The root itself may be a run directory (e.g. --root points at it).
    if (fs.existsSync(statePath(root))) return root;
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

export function readStepArg(raw: string): StepName | null {
  const trimmed = raw.trim();
  if (isStepName(trimmed)) return trimmed;
  return null;
}

export function stepMetaForHelp(step: StepName): (typeof STEPS)[StepName] {
  return STEPS[step];
}
