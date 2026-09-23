import { Command } from "commander";
import { cmdFetch, cmdRetryFetch } from "./commands/fetch.js";
import { cmdFulfill } from "./commands/fulfill.js";
import { cmdHelp } from "./commands/help.js";
import { cmdNext } from "./commands/next.js";
import { cmdNew, locateRun, noRunFound, readStepArg } from "./commands/shared.js";
import { cmdStatus } from "./commands/status.js";
import type { HandlerResult } from "./envelope.js";
import { resolveRoot } from "./run.js";
import { readState, type RunState } from "./state.js";

function emit(result: HandlerResult, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result.envelope, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.human}\n`);
    if (!result.envelope.ok && result.envelope.errors.length > 0) {
      for (const error of result.envelope.errors) process.stdout.write(`${error}\n`);
    }
  }
  process.exit(result.code);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("dr")
    .description("Deterministic deep-research pipeline: caller intelligence, CLI validation.")
    .allowExcessArguments(false);

  program
    .command("new")
    .description("Create a run directory under cwd (or --root / DR_ROOT)")
    .argument("<topic>", "research topic")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action((topic: string, opts: { root?: string; json?: boolean }) => {
      const root = resolveRoot({ rootFlag: opts.root });
      emit(cmdNew(root, { rootFlag: opts.root, topic }), opts.json === true);
    });

  program
    .command("next")
    .description("Name the single takeable step with its prompt and output location")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action(async (opts: { root?: string; json?: boolean }) => {
      const root = resolveRoot({ rootFlag: opts.root });
      const runDir = locateRun(root);
      if (!runDir) {
        emit(noRunFound(root), opts.json === true);
        return;
      }
      // CLI steps execute when takeable; the fetch step runs here.
      let state: RunState;
      try {
        state = readState(runDir);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit(
          {
            code: 4,
            envelope: {
              errors: [`E401: cannot read run state: ${message}`],
              ok: false,
              run: runDir,
              step: null,
            },
            human: `Cannot read run state: ${message}`,
          },
          opts.json === true,
        );
        return;
      }
      if (state.step === "fetch") {
        emit(await cmdFetch(runDir), opts.json === true);
        return;
      }
      emit(cmdNext(runDir), opts.json === true);
    });

  program
    .command("fulfill")
    .description("Validate <file> against the step checks; on success advance state")
    .argument("<step>", "pipeline step to fulfill")
    .argument("<file>", "file holding the step output")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action((stepRaw: string, file: string, opts: { root?: string; json?: boolean }) => {
      const asJson = opts.json === true;
      const step = readStepArg(stepRaw);
      const root = resolveRoot({ rootFlag: opts.root });
      const runDir = locateRun(root);
      if (!runDir) {
        emit(noRunFound(root), asJson);
        return;
      }
      if (!step) {
        emit(
          {
            code: 1,
            envelope: {
              errors: [`E103: unknown step ${stepRaw}; usage: dr fulfill <step> <file>`],
              ok: false,
              run: runDir,
              step: null,
            },
            human: `Unknown step: ${stepRaw}.`,
          },
          asJson,
        );
        return;
      }
      emit(cmdFulfill({ file, runDir, step }), asJson);
    });

  program
    .command("retry-fetch")
    .description("Re-attempt unreachable URLs idempotently; keeps fetched pages")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action(async (opts: { root?: string; json?: boolean }) => {
      const root = resolveRoot({ rootFlag: opts.root });
      const runDir = locateRun(root);
      if (!runDir) {
        emit(noRunFound(root), opts.json === true);
        return;
      }
      emit(await cmdRetryFetch(runDir), opts.json === true);
    });

  program
    .command("status")
    .description("Run summary: current step, steps completed, coverage counts")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action((opts: { root?: string; json?: boolean }) => {
      const root = resolveRoot({ rootFlag: opts.root });
      const runDir = locateRun(root);
      if (!runDir) {
        emit(noRunFound(root), opts.json === true);
        return;
      }
      emit(cmdStatus(runDir), opts.json === true);
    });

  program
    .command("help")
    .description("Pipeline overview, or per-step detail")
    .argument("[step]", "pipeline step")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action((stepRaw: string | undefined, opts: { root?: string; json?: boolean }) => {
      const root = resolveRoot({ rootFlag: opts.root });
      emit(cmdHelp(locateRun(root), stepRaw), opts.json === true);
    });

  return program;
}

buildProgram().parse();
