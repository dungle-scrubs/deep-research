#!/usr/bin/env node
// End-to-end smoke: drive a fixture run from `dr new` to done with the
// built binary. Exits 0 only when every stage passes. Loopback citations
// exercise the SSRF refusal and the unreachable derivation without
// network access. Seed one fetched-text fixture to check quote rejection
// and a corrected fulfill through the same built binary.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dr = path.join(repo, "dist", "dr.mjs");

if (!fs.existsSync(dr)) {
  console.error("dist/dr.mjs missing; run pnpm build first");
  process.exit(1);
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-smoke-"));
const stages = [];
let failed = false;

function run(args, expectCode) {
  const result = { code: 0, out: "" };
  try {
    result.out = execFileSync(process.execPath, [dr, ...args], {
      cwd: workdir,
      encoding: "utf8",
    });
  } catch (error) {
    const err = error;
    result.code = err.status ?? 1;
    result.out = (err.stdout ?? "").toString();
  }
  const label = `${args.join(" ")} -> exit ${result.code}`;
  if (result.code !== expectCode) {
    stages.push(`FAIL ${label} (expected ${expectCode})\n${result.out}`);
    failed = true;
  } else {
    stages.push(`ok   ${label}`);
  }
  return result;
}

function write(name, text) {
  fs.writeFileSync(path.join(workdir, name), text, "utf8");
}

try {
  const created = run(["new", "smoke test run", "--json"], 0);
  const runDir = JSON.parse(created.out).run;
  if (!runDir) throw new Error("run directory not found");
  run(["next", "--json"], 0);
  run(["fulfill", "brief", "brief.md"], 2); // brief.md does not exist yet -> E204, nothing advances
  write(
    "brief.md",
    "# Brief\n\n## Question\n\nDoes the pipeline hold?\n\n## Context\n\nSmoke run.\n\n## Scope\n\nFixture only.\n",
  );
  run(["fulfill", "brief", "brief.md"], 0);
  write("f.md", "# Foundation\n\nA claim with a source (https://example.com/a).\n");
  run(["fulfill", "foundation", "f.md"], 0);
  write("g.md", '# Gaps\n\nOne gap.\n\n```json\n["is the gate real?"]\n```\n');
  run(["fulfill", "gaps", "g.md"], 0);
  write("fo.md", "# Followup\n\n## 1\n\nYes (https://example.com/b).\n");
  run(["fulfill", "followup", "fo.md"], 0);
  write(
    "claims.json",
    JSON.stringify([
      {
        citations: [{ locator: "p1", title: "Loopback", url: "http://127.0.0.1/x" }],
        id: "c001",
        statement: "The gate rejects loopback fetches.",
        tier: 3,
      },
      {
        citations: [{ locator: "Table 2", title: "Quote fixture", url: "http://127.0.0.1/quote" }],
        id: "c002",
        statement: "The treatment reduced annual turnover.",
        tier: 3,
      },
    ]),
  );
  run(["fulfill", "claims", "claims.json"], 0);
  run(["next"], 0); // fetch executes; loopback is SSRF-refused -> unreachable
  run(["retry-fetch"], 0); // idempotent re-attempt of the unreachable URL
  const ledgerPath = path.join(runDir, "state", "fetch-ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  const page = ledger.find((entry) => entry.url === "http://127.0.0.1/quote");
  if (!page) throw new Error("quote fixture ledger entry missing");
  const pageText = "The treatment and coaching reduced annual turnover.";
  fs.writeFileSync(path.join(runDir, "fetched", `${page.hash}.txt`), pageText);
  fs.writeFileSync(path.join(runDir, "fetched", `${page.hash}.raw`), pageText);
  Object.assign(page, {
    bytes: Buffer.byteLength(pageText),
    contentType: "text/plain",
    finalUrl: page.url,
    reason: null,
    status: "ok",
  });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
  const verdicts = [
    { claimId: "c001", url: "http://127.0.0.1/x", verdict: "supported" },
    {
      claimId: "c002",
      quote: "A fabricated quote absent from the page",
      url: page.url,
      verdict: "supported",
    },
  ];
  write("verdicts.json", JSON.stringify(verdicts));
  const rejected = run(["fulfill", "verdicts", "verdicts.json", "--json"], 2);
  const envelope = JSON.parse(rejected.out);
  if (
    envelope.ok ||
    envelope.step !== "verdicts" ||
    envelope.errors.length !== 1 ||
    !/^E205: verdicts: 1\.quote: c002.*not found/.test(envelope.errors[0])
  ) {
    throw new Error(`unexpected quote gate envelope: ${rejected.out}`);
  }
  if (
    fs.existsSync(path.join(runDir, "state", "matrix.json")) ||
    fs.existsSync(path.join(runDir, "steps", "verdicts.json"))
  ) {
    throw new Error("failed quote gate wrote verdicts or matrix");
  }
  verdicts[1].quote = "The treatment reduced turnover.";
  write("verdicts.json", JSON.stringify(verdicts));
  run(["fulfill", "verdicts", "verdicts.json"], 0);
  const matrix = JSON.parse(fs.readFileSync(path.join(runDir, "state", "matrix.json"), "utf8"));
  if (matrix.claims[0].status !== "unreachable" || matrix.claims[1].status !== "single-source") {
    throw new Error("quote gate or skip-set support derivation failed");
  }
  stages.push(
    "ok   quote gate rejects absent text, accepts ordered tokens, and excludes skipped support",
  );
  write("briefing.md", "# Briefing\n\n## Coverage\n\nunreachable: 1\nsingle-source: 1\n");
  run(["fulfill", "briefing", "briefing.md"], 0);
  write(
    "report.md",
    [
      "# Report",
      "",
      "## Question",
      "Does the pipeline hold?",
      "",
      "## Verified findings",
      "None in the smoke run.",
      "",
      "## Single-source findings",
      "The fixture reports reduced turnover (not corroborated).",
      "",
      "## Conflicts",
      "None.",
      "",
      "## Gaps and uncertainty",
      "The citation was unreachable by design.",
      "",
      "## Practical implications",
      "None; fixture run.",
      "",
      "## Evidence table",
      "",
      "| Claim | Citation | Status |",
      "| --- | --- | --- |",
      "| c001 | http://127.0.0.1/x | unreachable (source-not-checked) |",
      "| c002 | http://127.0.0.1/quote | single-source |",
      "",
      "## Discarded claims",
      "None.",
    ].join("\n"),
  );
  run(["fulfill", "synthesis", "report.md"], 0);
  run(["next"], 0); // finalize: gate passes, sources.md written, state done
  run(["next"], 3); // nothing takeable at done
  run(["retry-fetch"], 2); // closed run: retry-fetch refused (E201)

  const state = JSON.parse(fs.readFileSync(path.join(runDir, "state", "state.json"), "utf8"));
  if (state.step !== "done") {
    stages.push(`FAIL final state is ${state.step}, expected done`);
    failed = true;
  } else {
    stages.push("ok   final state is done");
  }
  for (const artifact of [
    "report.md",
    "sources.md",
    "state/matrix.json",
    "citations.json",
    "state/fetch-ledger.json",
    "steps/claims.json",
  ]) {
    const exists = fs.existsSync(path.join(runDir, artifact));
    stages.push(`${exists ? "ok  " : "FAIL"} artifact ${artifact}`);
    if (!exists) failed = true;
  }
} finally {
  console.log(stages.join("\n"));
  fs.rmSync(workdir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
