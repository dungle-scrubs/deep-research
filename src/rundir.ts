import * as fs from "node:fs";
import * as path from "node:path";
import { createRunDir } from "./run.js";

/** The run-directory layout contract (RFC 01): one owner for every path
 *  inside a run. Modules stop joining runDir + segment strings themselves
 *  and learn this interface instead. */

export interface RunLayout {
  readonly runDir: string;
  /** claims.json -> steps/claims.json symlink at the run root. */
  readonly claimsFile: string;
  /** citations.json written at finalize. */
  readonly citationsFile: string;
  /** Per-run command event stream: one JSON line per command start/end. */
  readonly eventsFile: string;
  readonly fetchedDir: string;
  readonly ledgerFile: string;
  readonly matrixFile: string;
  readonly promptsDir: string;
  readonly reportFile: string;
  readonly sourcesFile: string;
  readonly stateDir: string;
  readonly stateFile: string;
  readonly stepsDir: string;
  fetched(name: string): string;
  prompt(name: string): string;
  step(name: string): string;
}

export function runLayout(runDir: string): RunLayout {
  const stateDir = path.join(runDir, "state");
  const stepsDir = path.join(runDir, "steps");
  return {
    claimsFile: path.join(runDir, "claims.json"),
    citationsFile: path.join(runDir, "citations.json"),
    eventsFile: path.join(stateDir, "events.jsonl"),
    fetched(name) {
      return path.join(runDir, "fetched", name);
    },
    fetchedDir: path.join(runDir, "fetched"),
    ledgerFile: path.join(stateDir, "fetch-ledger.json"),
    matrixFile: path.join(stateDir, "matrix.json"),
    prompt(name) {
      return path.join(runDir, "prompts", `${name}.md`);
    },
    promptsDir: path.join(runDir, "prompts"),
    reportFile: path.join(runDir, "report.md"),
    runDir,
    sourcesFile: path.join(runDir, "sources.md"),
    stateDir,
    stateFile: path.join(stateDir, "state.json"),
    step(name) {
      return path.join(stepsDir, name);
    },
    stepsDir,
  };
}

/** Create the run directory exclusively with its layout: steps/, fetched/,
 *  prompts/ (contents written by the caller), state/, and the root
 *  claims.json symlink. Returns the run directory path. */
export function createRunDirectory(root: string, topic: string, now: Date = new Date()): string {
  const runDir = createRunDir(root, topic, now);
  const layout = runLayout(runDir);
  fs.mkdirSync(layout.stepsDir, { recursive: true });
  fs.mkdirSync(layout.fetchedDir, { recursive: true });
  fs.mkdirSync(layout.promptsDir, { recursive: true });
  fs.mkdirSync(layout.stateDir, { recursive: true });
  fs.symlinkSync("steps/claims.json", layout.claimsFile);
  return runDir;
}
