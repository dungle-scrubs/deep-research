import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { HandlerResult } from "../envelope.js";
import { fail } from "../envelope.js";
import type { EventContext } from "../events.js";
import { appendRunEvent, endEvent, eventContext, startEvent } from "../events.js";
import { runLayout } from "../rundir.js";
import { readState } from "../state.js";
import type { StepName } from "../steps.js";
import { isStepName } from "../steps.js";
import { errorMessage } from "../util.js";
import { cmdCitations } from "./citations.js";
import { cmdFetch, cmdRetryFetch } from "./fetch.js";
import { cmdFinalize } from "./finalize.js";
import { cmdFulfill } from "./fulfill.js";
import { cmdHelp } from "./help.js";
import { cmdNext } from "./next.js";
import type { NewOptions } from "./shared.js";
import { cmdNew } from "./shared.js";
import { cmdStatus } from "./status.js";

export type EngineCommand =
  | ({ readonly kind: "new" } & NewOptions)
  | { readonly kind: "next"; readonly run: string; readonly plainFirst?: boolean }
  | {
      readonly kind: "fulfill";
      readonly run: string;
      readonly step: StepName;
      readonly file: string;
    }
  | { readonly kind: "retry-fetch"; readonly run: string; readonly onlyUntriedScraper?: boolean }
  | { readonly kind: "status"; readonly run: string }
  | { readonly kind: "citations"; readonly run: string; readonly format?: string }
  | { readonly kind: "help"; readonly run: string | null; readonly step?: string };
export interface ExecuteOptions {
  readonly owner?: string;
  readonly parentId?: string;
  readonly onRun?: (run: string) => void;
}

/** The token, not PID liveness, establishes ownership. Never steal an ambiguous
 * lease. Operator recovery must first establish that its owner has stopped. */
export function acquireMutation(run: string): { readonly token: string; release(): void } {
  const file = runLayout(run).mutationFile;
  const token = randomUUID();
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch {
    throw new Error(
      `E401: mutation ownership unavailable: ${file}; stop the owner and verify its identity before removing this lease`,
    );
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify({ token, pid: process.pid, started: new Date().toISOString() }),
    );
  } finally {
    closeSync(fd);
  }
  return {
    token,
    release() {
      if (readFileSync(file, "utf8").includes(token)) unlinkSync(file);
    },
  };
}
function assertOwner(run: string, token: string): void {
  const raw: unknown = JSON.parse(readFileSync(runLayout(run).mutationFile, "utf8"));
  if (!raw || typeof raw !== "object" || !("token" in raw) || raw.token !== token)
    throw new Error("E401: mutation owner token changed");
}
/** Shared command boundary: admission, automatic steps, event durability and
 * exception translation. Both drivers use this, gates remain in handlers. */
export async function execute(
  command: EngineCommand,
  options: ExecuteOptions = {},
): Promise<HandlerResult> {
  let run = command.kind === "new" ? null : command.run;
  let release: (() => void) | undefined;
  let context: EventContext | undefined;
  let result: HandlerResult | undefined;
  const mutating = !["status", "help"].includes(command.kind);
  try {
    if (run && mutating) {
      if (options.owner) assertOwner(run, options.owner);
      else release = acquireMutation(run).release;
    }
    const step =
      command.kind === "fulfill"
        ? command.step
        : command.kind === "help"
          ? command.step && isStepName(command.step)
            ? command.step
            : null
          : run
            ? readState(run).step
            : command.kind === "new"
              ? "brief"
              : null;
    context = eventContext(command.kind, step, { parentId: options.parentId });
    if (command.kind === "new") {
      const createdContext = context;
      result = cmdNew(command, (directory) => {
        run = directory;
        options.onRun?.(directory);
        appendRunEvent(directory, startEvent(createdContext));
      });
      run = result.envelope.run;
      if (!result.envelope.ok) return result;
    }
    if (run && command.kind !== "new") {
      try {
        appendRunEvent(run, startEvent(context));
      } catch (error) {
        if (mutating) throw error;
      }
    }
    switch (command.kind) {
      case "new":
        break;
      case "next": {
        const state = readState(command.run);
        result =
          state.step === "fetch"
            ? await cmdFetch(command.run, command.plainFirst ? "plain" : undefined)
            : state.step === "finalize"
              ? cmdFinalize(command.run)
              : cmdNext(command.run);
        break;
      }
      case "fulfill":
        result = cmdFulfill({ runDir: command.run, step: command.step, file: command.file });
        break;
      case "retry-fetch":
        result = await cmdRetryFetch(command.run, command.onlyUntriedScraper);
        break;
      case "status":
        result = cmdStatus(command.run);
        break;
      case "citations":
        result = await cmdCitations(command.run, command.format);
        break;
      case "help":
        result = cmdHelp(command.run, command.step);
        break;
    }
    if (!result) throw new Error("E401: command returned no result");
    if (run) {
      let after: string | null = null;
      try {
        after = readState(run).step;
      } catch (error) {
        if (mutating) throw error;
      }
      const outcome = !result.envelope.ok
        ? "failed"
        : after === "done" && mutating
          ? "done"
          : command.kind === "fulfill"
            ? after === command.step
              ? "partial"
              : "accepted"
            : (command.kind === "next" && context.step !== after) ||
                command.kind === "new" ||
                command.kind === "retry-fetch" ||
                command.kind === "citations"
              ? "accepted"
              : "described";
      try {
        appendRunEvent(
          run,
          endEvent(
            context,
            result.code,
            result.envelope.ok,
            result.envelope.errors,
            after,
            outcome,
          ),
        );
      } catch (error) {
        if (mutating)
          return fail(
            4,
            run,
            after,
            [`E401: end event not saved: ${errorMessage(error)}`],
            undefined,
            {
              committed: result.envelope.ok && (command.kind !== "next" || context.step !== after),
              state: runLayout(run).stateFile,
            },
          );
      }
    }
    return result;
  } catch (error) {
    let step: string | null = null;
    try {
      if (run) step = readState(run).step;
    } catch {
      /* Unreadable state is reported at this boundary. */
    }
    const failed = fail(
      4,
      run,
      step,
      [`E401: ${errorMessage(error)}`],
      undefined,
      result?.envelope.ok ? { committed: true } : undefined,
    );
    if (run && context) {
      try {
        appendRunEvent(run, endEvent(context, 4, false, failed.envelope.errors, step, "failed"));
      } catch {
        /* No work is started after storage failure. */
      }
    }
    return failed;
  } finally {
    release?.();
  }
}
