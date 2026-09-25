#!/usr/bin/env node
// Offline hcn protocol fixture. It never reads or writes canonical run files.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
if (args[0] === "inspect") {
  emit({ v: 1, source: "stores", models: [], skipped: [] });
} else {
  const model = value("--model");
  const prompt = readFileSync(value("--prompt-file"), "utf8");
  const step = /DR_STEP: (\w+)/.exec(prompt)?.[1];
  emit({ kind: "identity", sessionId: "fixture-session" });
  if (model === "wait") await new Promise((resolve) => setTimeout(resolve, 30_000));
  if (model === "unavailable" || model === "task") {
    emit({
      kind: "failure",
      class: model,
      retryable: model === "unavailable",
      message: "fixture failure",
    });
    emit({
      kind: "done",
      cause: "failed",
      exitCode: 1,
      failure: { class: model, retryable: model === "unavailable", message: "fixture failure" },
    });
    process.exitCode = 1;
  } else if (model === "question") {
    emit({ kind: "question", question: "Which scope?", options: ["Narrow", "Wide"] });
    emit({ kind: "done", cause: "awaiting-input", exitCode: 0 });
  } else {
    const urls = ["http://127.0.0.1/a", "http://127.0.0.1/b"];
    const claims = [1, 2].map((n) => ({
      id: `c00${n}`,
      statement: "The treatment reduced annual turnover.",
      tier: 3,
      citations: urls.map((url) => ({ url, locator: "p1", title: "Fixture" })),
    }));
    const context = JSON.parse(prompt.split("DR_INPUT_JSON\n")[1]);
    const outputs = {
      foundation: "# Foundation\n\nFindings https://example.com/a\n",
      gaps: '# Gaps\n\n```json\n["What else?"]\n```\n',
      followup: "# Followup\n\nFindings https://example.com/b\n",
      claims: JSON.stringify(claims),
      verdicts: JSON.stringify(
        (context.assignment?.pairs ?? []).map((pair) => ({
          ...pair,
          verdict: "not-found",
          note: "Source not checkable",
        })),
      ),
      briefing: "# Briefing\n\n## Coverage\n\nunreachable: 2\n",
      synthesis: [
        "# Report",
        "## Question",
        "What?",
        "## Verified findings",
        "None.",
        "## Single-source findings",
        "None.",
        "## Conflicts",
        "None.",
        "## Gaps and uncertainty",
        "Sources unavailable.",
        "## Practical implications",
        "Unknown.",
        "## Evidence table",
        "| Claim | Citation | Status |",
        "| --- | --- | --- |",
        ...claims.map((c) => `| ${c.id} | ${urls[0]} | unreachable (source-not-checked) |`),
        "## Discarded claims",
        "None.",
      ].join("\n"),
    };
    if (model === "quotes" && step === "verdicts") {
      outputs.verdicts = JSON.stringify(
        (context.assignment?.pairs ?? []).map((pair) => ({
          ...pair,
          verdict: "supported",
          quote:
            pair.claimId === "c001"
              ? "The treatment reduced annual turnover."
              : "An invented quotation absent from every document.",
        })),
      );
    }
    if (model === "malformed") process.stdout.write("broken\n");
    if (model === "cross-lane" && step === "verdicts")
      outputs.verdicts = JSON.stringify([
        {
          claimId: context.assignment?.pairs[0]?.claimId === "c001" ? "c002" : "c001",
          url: urls[0],
          verdict: "not-found",
        },
      ]);
    emit({
      kind: "message",
      role: "assistant",
      text: model === "invalid" ? "invalid" : outputs[step],
    });
    emit({ kind: "done", cause: "clean", exitCode: 0 });
  }
}
