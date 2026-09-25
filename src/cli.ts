import { writeSync } from "node:fs";
import { Command } from "commander";
import type { EngineCommand } from "./commands/execute.js";
import { execute } from "./commands/execute.js";
import { locateRun, noRunFound } from "./commands/shared.js";
import { drive } from "./drive.js";
import { driveConfigTemplate } from "./drive-config.js";
import type { HandlerResult } from "./envelope.js";
import { fail } from "./envelope.js";
import { activeRunOperations, appendRunEvent } from "./events.js";
import { resolveRoot } from "./run.js";
import { errorMessage } from "./util.js";

interface CliOpts {
  root?: string;
  json?: boolean;
}
function emit(result: HandlerResult, asJson: boolean): void {
  process.stdout.write(
    asJson ? `${JSON.stringify(result.envelope, null, 2)}\n` : `${result.human}\n`,
  );
  if (!asJson && !result.envelope.ok) {
    for (const error of result.envelope.errors) process.stdout.write(`${error}\n`);
  }
  process.exitCode = result.code;
}
async function inRun(opts: CliOpts, command: (run: string) => EngineCommand): Promise<void> {
  const root = resolveRoot({ rootFlag: opts.root });
  const run = locateRun(root);
  emit(run ? await execute(command(run)) : noRunFound(root), opts.json === true);
}
function common(command: Command): Command {
  return command
    .option("--root <dir>", "run root directory (overrides DR_ROOT and cwd)")
    .option("--json", "emit the stable envelope {ok, run, step, errors[]}");
}
export function buildProgram(): Command {
  const program = new Command()
    .name("dr")
    .description("Deterministic deep-research pipeline: caller intelligence, CLI validation.")
    .allowExcessArguments(false);
  common(
    program
      .command("new")
      .description("Create a run directory under cwd (or --root / DR_ROOT)")
      .argument("<topic>", "research topic"),
  )
    .option(
      "--min-distinct-citations <n>",
      "creation policy: minimum distinct documents per claim (default 1)",
    )
    .action(async (topic: string, opts: CliOpts & { minDistinctCitations?: string }) => {
      emit(
        await execute({
          kind: "new",
          topic,
          rootFlag: opts.root,
          ...(opts.minDistinctCitations === undefined
            ? {}
            : { policy: { minDistinctCitations: Number(opts.minDistinctCitations) } }),
        }),
        opts.json === true,
      );
    });
  program
    .command("drive")
    .description(
      "Run the gated pipeline through hcn; stream events on stderr and return the final report envelope",
    )
    .argument("[topic]", "research question (omit for --resume)")
    .option("--root <dir>", "new run root (overrides DR_ROOT and cwd)")
    .option(
      "--config <file>",
      "complete route config (default ./dr-drive.json; resume uses frozen config)",
    )
    .option("--resume <run>", "resume an exact run after manual repair; never resets caps")
    .option(
      "--min-distinct-citations <n>",
      "creation-only override of config policy; frozen in the run",
    )
    .option(
      "--print-config",
      "emit template JSON; replace all null steps with complete choose-model results",
    )
    .option("--json", "one final envelope on stdout; NDJSON progress on stderr")
    .addHelpText(
      "after",
      "\nConfig v1: privacy, policy.minDistinctCitations, limits.maxAttemptsPerWorkItem/maxWorkItems, verdicts.lanes/claimsPerBatch, steps.\nBrief uses kind: topic. Other steps require query, selection, fallbacks, excluded and warnings from choose-model.\nRoutes require route, harness, modelId, provider (null except pi), effort and hosted. No native flag overrides.\nFixed pipeline: foundation and followup each once. No quality retries or automatic gate corrections.\nTemplate policy: 2 distinct documents per claim. Select another positive count only before creation.\nSecret configs require local candidates throughout, confirmed pi registry identity and tool-free containment.\nTool-free search can be unavailable; use an authorized local agent research path instead.\nExit codes: 0 success; 1 usage/config/privacy; 2 gate/worker/cap; 3 nothing takeable; 4 internal; E499 crash.\n",
    )
    .action(
      async (
        topic: string | undefined,
        opts: CliOpts & {
          config?: string;
          resume?: string;
          printConfig?: boolean;
          minDistinctCitations?: string;
        },
      ) => {
        if (opts.printConfig) {
          process.stdout.write(`${JSON.stringify(driveConfigTemplate(), null, 2)}\n`);
          return;
        }
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        process.on("SIGINT", cancel);
        process.on("SIGTERM", cancel);
        try {
          emit(
            await drive({
              ...opts,
              minDistinctCitations:
                opts.minDistinctCitations === undefined
                  ? undefined
                  : Number(opts.minDistinctCitations),
              topic,
              signal: controller.signal,
              onEvent: (event) => {
                process.stderr.write(
                  opts.json
                    ? `${JSON.stringify(event)}\n`
                    : `${event.scope ?? "legacy"} ${event.step ?? "?"} ${event.event}${event.outcome ? `: ${event.outcome}` : ""}\n`,
                );
              },
            }),
            opts.json === true,
          );
        } finally {
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
        }
      },
    );
  common(
    program
      .command("next")
      .description("Name the single takeable step with its prompt and output location"),
  ).action(async (opts: CliOpts) => inRun(opts, (run) => ({ kind: "next", run })));
  common(
    program
      .command("fulfill")
      .description("Validate <file>; advance when complete (verdicts accept partial batches)")
      .argument("<step>", "pipeline step to fulfill")
      .argument("<file>", "file holding the step output"),
  ).action(async (step: string, file: string, opts: CliOpts) =>
    inRun(opts, (run) => ({ kind: "fulfill", run, step, file })),
  );
  common(
    program
      .command("citations")
      .description("Structured citation export for the run (join of claims, matrix, fetch ledger)")
      .option("--format <fmt>", "output format: json (default)"),
  ).action(async (opts: CliOpts & { format?: string }) =>
    inRun(opts, (run) => ({ kind: "citations", run, format: opts.format })),
  );
  common(
    program
      .command("retry-fetch")
      .description(
        "Retry non-ok URLs through scraper; keeps ok pages (DR_FETCH_TIER=plain for plain first)",
      ),
  ).action(async (opts: CliOpts) => inRun(opts, (run) => ({ kind: "retry-fetch", run })));
  common(
    program
      .command("status")
      .description("Run summary: current step, steps completed, coverage counts"),
  ).action(async (opts: CliOpts) => inRun(opts, (run) => ({ kind: "status", run })));
  common(
    program
      .command("help")
      .description("Pipeline overview, or per-step detail")
      .argument("[step]", "pipeline step"),
  ).action(async (step: string | undefined, opts: CliOpts) =>
    emit(
      await execute({ kind: "help", run: locateRun(resolveRoot({ rootFlag: opts.root })), step }),
      opts.json === true,
    ),
  );
  return program;
}
function crash(kind: string, error: unknown): void {
  const operations = activeRunOperations();
  const operation = operations.at(-1);
  const errors = [`E499: ${kind}: ${errorMessage(error)}`];
  for (const operation of operations) {
    try {
      appendRunEvent(operation.run, {
        ...operation.event,
        ts: new Date().toISOString(),
        event: "crash",
        errors,
      });
    } catch {
      /* Synchronous stdout is the remaining delivery channel. */
    }
  }
  try {
    writeSync(
      1,
      `${JSON.stringify({ ok: false, run: operation?.run ?? null, step: operation?.event.step ?? null, errors })}\n`,
    );
  } catch {
    /* Consumer is gone. */
  }
  process.exit(4);
}
process.on("uncaughtException", (error) => crash("uncaughtException", error));
process.on("unhandledRejection", (error) => crash("unhandledRejection", error));
async function main(): Promise<void> {
  const program = buildProgram();
  for (const command of [program, ...program.commands]) {
    command.exitOverride();
    command.allowExcessArguments(false);
    command.configureOutput({ writeErr: () => {}, writeOut: (text) => process.stdout.write(text) });
  }
  try {
    await program.parseAsync();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code.endsWith("helpDisplayed") || code.endsWith("versionDisplayed")) {
      process.exitCode = 0;
      return;
    }
    const parser = code.startsWith("commander.");
    emit(
      fail(parser ? 1 : 4, null, null, [`${parser ? "E106" : "E401"}: ${errorMessage(error)}`]),
      true,
    );
  }
}
void main();
