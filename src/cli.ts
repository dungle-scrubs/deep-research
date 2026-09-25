import { writeSync } from "node:fs";
import { Command } from "commander";
import { cmdCitations } from "./commands/citations.js";
import { cmdFetch, cmdRetryFetch } from "./commands/fetch.js";
import { cmdFinalize } from "./commands/finalize.js";
import { cmdFulfill } from "./commands/fulfill.js";
import { cmdHelp } from "./commands/help.js";
import { cmdNext } from "./commands/next.js";
import { cmdNew, locateRun, noRunFound, readStepArg } from "./commands/shared.js";
import { cmdStatus } from "./commands/status.js";
import type { HandlerResult } from "./envelope.js";
import { appendRunEvent, endEvent, startEvent } from "./events.js";
import { resolveRoot } from "./run.js";
import { type RunState, readState } from "./state.js";
import { errorMessage } from "./util.js";

interface CliOpts {
  root?: string;
  json?: boolean;
}

function emit(result: HandlerResult, asJson: boolean, cmd: string): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result.envelope, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.human}\n`);
    if (!result.envelope.ok && result.envelope.errors.length > 0) {
      for (const error of result.envelope.errors) process.stdout.write(`${error}\n`);
    }
  }
  const run = result.envelope.run;
  if (run !== null) {
    appendRunEvent(run, endEvent(cmd, result.code, result.envelope.ok, result.envelope.errors));
  }
  // Natural exit, not process.exit(): pending stdout writes flush before
  // the process ends, so a piped consumer never loses the envelope.
  process.exitCode = result.code;
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
    .action((topic: string, opts: CliOpts) => {
      emit(cmdNew({ rootFlag: opts.root, topic }), opts.json === true, "new");
    });

  program
    .command("next")
    .description("Name the single takeable step with its prompt and output location")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action(async (opts: CliOpts) => {
      const root = resolveRoot({ rootFlag: opts.root });
      const runDir = locateRun(root);
      if (!runDir) {
        emit(noRunFound(root), opts.json === true, "next");
        return;
      }
      enterRun(runDir, "next");
      // CLI steps execute when takeable; fetch and finalize run here.
      let state: RunState;
      try {
        state = readState(runDir);
      } catch (error) {
        emit(
          {
            code: 4,
            envelope: {
              errors: [`E401: cannot read run state: ${errorMessage(error)}`],
              ok: false,
              run: runDir,
              step: null,
            },
            human: `Cannot read run state: ${errorMessage(error)}`,
          },
          opts.json === true,
          "next",
        );
        return;
      }
      if (state.step === "fetch") {
        emit(await cmdFetch(runDir), opts.json === true, "next");
        return;
      }
      if (state.step === "finalize") {
        emit(cmdFinalize(runDir), opts.json === true, "next");
        return;
      }
      emit(cmdNext(runDir), opts.json === true, "next");
    });

  program
    .command("fulfill")
    .description("Validate <file>; advance when complete (verdicts accept partial batches)")
    .argument("<step>", "pipeline step to fulfill")
    .argument("<file>", "file holding the step output")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action((stepRaw: string, file: string, opts: CliOpts) => {
      const asJson = opts.json === true;
      const step = readStepArg(stepRaw);
      const root = resolveRoot({ rootFlag: opts.root });
      const runDir = locateRun(root);
      if (!runDir) {
        emit(noRunFound(root), asJson, "fulfill");
        return;
      }
      enterRun(runDir, "fulfill");
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
          "fulfill",
        );
        return;
      }
      emit(cmdFulfill({ file, runDir, step }), asJson, "fulfill");
    });

  program
    .command("citations")
    .description("Structured citation export for the run (join of claims, matrix, fetch ledger)")
    .option("--format <fmt>", "output format: json (default)")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action(async (opts: CliOpts & { format?: string }) => {
      const root = resolveRoot({ rootFlag: opts.root });
      const runDir = locateRun(root);
      if (!runDir) {
        emit(noRunFound(root), opts.json === true, "citations");
        return;
      }
      enterRun(runDir, "citations");
      emit(await cmdCitations(runDir, opts.format), opts.json === true, "citations");
    });

  program
    .command("retry-fetch")
    .description(
      "Retry non-ok URLs through scraper; keeps ok pages (DR_FETCH_TIER=plain for plain first)",
    )
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action(async (opts: CliOpts) => {
      const root = resolveRoot({ rootFlag: opts.root });
      const runDir = locateRun(root);
      if (!runDir) {
        emit(noRunFound(root), opts.json === true, "retry-fetch");
        return;
      }
      enterRun(runDir, "retry-fetch");
      emit(await cmdRetryFetch(runDir), opts.json === true, "retry-fetch");
    });

  program
    .command("status")
    .description("Run summary: current step, steps completed, coverage counts")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action((opts: CliOpts) => {
      const root = resolveRoot({ rootFlag: opts.root });
      const runDir = locateRun(root);
      if (!runDir) {
        emit(noRunFound(root), opts.json === true, "status");
        return;
      }
      enterRun(runDir, "status");
      emit(cmdStatus(runDir), opts.json === true, "status");
    });

  program
    .command("help")
    .description("Pipeline overview, or per-step detail")
    .argument("[step]", "pipeline step")
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}")
    .action((stepRaw: string | undefined, opts: CliOpts) => {
      const root = resolveRoot({ rootFlag: opts.root });
      emit(cmdHelp(locateRun(root), stepRaw), opts.json === true, "help");
    });

  return program;
}

// The run the current invocation resolved, for crash reporting.
let crashRun: string | null = null;

function enterRun(runDir: string, cmd: string): void {
  crashRun = runDir;
  appendRunEvent(runDir, startEvent(cmd));
}

function crashEnvelope(kind: string, error: unknown): string {
  return `${JSON.stringify(
    {
      errors: [`E499: ${kind}: ${errorMessage(error)}`],
      ok: false,
      run: crashRun,
      step: null,
    },
    null,
    2,
  )}\n`;
}

process.on("uncaughtException", (error) => {
  if (crashRun !== null) {
    appendRunEvent(crashRun, {
      cmd: "unknown",
      errors: [`E499: uncaughtException: ${errorMessage(error)}`],
      event: "crash",
      pid: process.pid,
      ts: new Date().toISOString(),
    });
  }
  try {
    writeSync(1, crashEnvelope("uncaughtException", error));
  } catch {
    // Nothing more can be delivered; the crash event above is on disk.
  }
  process.exit(4);
});

process.on("unhandledRejection", (reason) => {
  if (crashRun !== null) {
    appendRunEvent(crashRun, {
      cmd: "unknown",
      errors: [`E499: unhandledRejection: ${errorMessage(reason)}`],
      event: "crash",
      pid: process.pid,
      ts: new Date().toISOString(),
    });
  }
  try {
    writeSync(1, crashEnvelope("unhandledRejection", reason));
  } catch {
    // Nothing more can be delivered; the crash event above is on disk.
  }
  process.exit(4);
});

function main(): void {
  const program = buildProgram();
  // exitOverride and output routing apply per command, including
  // subcommands; argument errors become E106 envelopes, help text
  // still flows to stdout.
  for (const command of [program, ...program.commands]) {
    command.exitOverride();
    command.configureOutput({
      writeErr: () => {},
      writeOut: (text) => process.stdout.write(text),
    });
  }
  try {
    program.parse();
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (code.endsWith("helpDisplayed") || code.endsWith("versionDisplayed")) {
      // Help/version text is already on stdout; a clean exit.
      process.exitCode = 0;
      return;
    }
    // Commander argument errors join the envelope contract as E106.
    const message = (error as { message?: string }).message ?? "unknown CLI error";
    process.stdout.write(
      `${JSON.stringify(
        { errors: [`E106: ${message}`], ok: false, run: null, step: null },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

main();
