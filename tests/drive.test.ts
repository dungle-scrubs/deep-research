import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../src/envelope.js";
import { readLedger, writeLedger } from "../src/fetch.js";
import { runLayout } from "../src/rundir.js";

const DR = path.resolve(__dirname, "../dist/dr.mjs");
const FIXTURE = path.resolve(__dirname, "fixtures/hcn.mjs");
let root: string;
const models = ["foundation", "gaps", "followup", "claims", "verdicts", "briefing", "synthesis"];
function route(modelId = "good", hosted = true) {
  return {
    route: `${modelId}@pi`,
    harness: "pi",
    provider: "fixture",
    modelId,
    effort: "high",
    hosted,
  };
}
function config(model = "good", fallback = "good") {
  return {
    version: 1,
    privacy: "normal",
    policy: { minDistinctCitations: 2 },
    limits: { maxAttemptsPerWorkItem: 3, maxWorkItems: 1000 },
    verdicts: { lanes: 2, claimsPerBatch: 1 },
    steps: {
      brief: { kind: "topic" },
      ...Object.fromEntries(
        models.map((step) => [
          step,
          {
            query: { task: "research", privacy: "normal" },
            selection: route(step === "foundation" ? model : "good"),
            fallbacks: [route(fallback)],
            excluded: [],
            warnings: [],
          },
        ]),
      ),
    },
  };
}
function write(name: string, data: unknown): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  return file;
}
function cli(args: string[]) {
  const result = spawnSync(process.execPath, [DR, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
  });
  return {
    code: result.status,
    envelope: JSON.parse(result.stdout) as Envelope,
    stderr: result.stderr,
  };
}
function start(value = config()) {
  return cli([
    "drive",
    "Fixture question",
    "--root",
    root,
    "--config",
    write("config.json", value),
  ]);
}
function events(run: string) {
  return fs
    .readFileSync(path.join(run, "state/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
beforeEach(() => {
  fs.mkdirSync(path.resolve(".scratch/tests/drive"), { recursive: true });
  root = fs.mkdtempSync(path.resolve(".scratch/tests/drive/run-"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.copyFileSync(FIXTURE, path.join(root, "bin/hcn"));
  fs.chmodSync(path.join(root, "bin/hcn"), 0o755);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("drive CLI", () => {
  it("prints envelope error lines in human drive output too", () => {
    const result = spawnSync(
      process.execPath,
      [
        DR,
        "drive",
        "Invalid fixture",
        "--root",
        root,
        "--config",
        write("config.json", config("invalid")),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/\nE205: foundation:/);
  });
  it("matches manual canonical artifacts and engine events under equal inputs and policy", () => {
    const driven = start();
    expect(driven.code).toBe(0);
    const driveRun = driven.envelope.run ?? "";
    const journal = JSON.parse(
      fs.readFileSync(path.join(driveRun, "state/drive/journal.json"), "utf8"),
    );
    const made = cli(["new", "Fixture question", "--root", root, "--min-distinct-citations", "2"]);
    const manualRun = made.envelope.run ?? "";
    const candidates = journal.work.filter((work: { submitted: boolean }) => work.submitted);
    let candidate = 0;
    for (const event of events(driveRun).filter(
      (event) => event.scope === "command" && event.event === "start" && event.cmd !== "new",
    )) {
      const args = [event.cmd];
      if (event.cmd === "fulfill") {
        const file =
          event.step === "brief"
            ? path.join(driveRun, "steps/brief.md")
            : candidates[candidate++].attempts.at(-1).candidate;
        args.push(event.step, file);
      }
      const result = cli([...args, "--root", manualRun]);
      expect(result.code, JSON.stringify(result.envelope)).toBe(0);
    }
    const scrub = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .filter(
              ([key]) =>
                ![
                  "ts",
                  "pid",
                  "operationId",
                  "parentId",
                  "created",
                  "derivedAt",
                  "generatedAt",
                  "fetchedAt",
                  "run",
                ].includes(key),
            )
            .map(([key, value]) => [key, scrub(value)]),
        );
      return value;
    };
    for (const relative of [
      "state/state.json",
      "state/matrix.json",
      "state/fetch-ledger.json",
      "citations.json",
      "steps/claims.json",
      "steps/verdicts.json",
    ]) {
      expect(scrub(JSON.parse(fs.readFileSync(path.join(driveRun, relative), "utf8")))).toEqual(
        scrub(JSON.parse(fs.readFileSync(path.join(manualRun, relative), "utf8"))),
      );
    }
    for (const relative of [
      "steps/brief.md",
      "steps/foundation.md",
      "steps/gaps.md",
      "steps/followup.md",
      "steps/briefing.md",
      "report.md",
      "sources.md",
      ...fs.readdirSync(path.join(driveRun, "prompts")).map((name) => `prompts/${name}`),
    ]) {
      expect(fs.readFileSync(path.join(driveRun, relative), "utf8")).toBe(
        fs.readFileSync(path.join(manualRun, relative), "utf8"),
      );
    }
    expect(scrub(events(driveRun).filter((event) => event.scope === "command"))).toEqual(
      scrub(events(manualRun)),
    );
  });

  it.each([1, 3])("resumes parent-canceled work in the next slot within cap %i", async (cap) => {
    const value = config("wait-once", "wait-once");
    value.limits.maxAttemptsPerWorkItem = cap;
    const file = write("wait.json", value);
    const child = spawn(
      process.execPath,
      [DR, "drive", "Waiting fixture", "--root", root, "--config", file, "--json"],
      {
        cwd: root,
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("no live worker progress"));
      }, 5000);
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.includes('"scope":"work"')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    expect(stdout).toBe("");
    child.kill("SIGTERM");
    expect(await closed).toBe(2);
    const result = JSON.parse(stdout) as Envelope;
    expect(result.step).toBe("foundation");
    expect(result.errors.join()).toContain("E208");
    const run = result.run ?? "";
    expect(fs.existsSync(path.join(run, "state/mutation.json"))).toBe(false);
    const before = events(run).filter((event) => event.scope === "work").length;
    const resumed = cli(["drive", "--resume", run]);
    const starts = events(run).filter(
      (event) => event.scope === "work" && event.step === "foundation" && event.event === "start",
    );
    if (cap === 1) {
      expect(resumed.envelope.errors[0]).toMatch(/^E209:/);
      expect(events(run).filter((event) => event.scope === "work")).toHaveLength(before);
    } else {
      expect(resumed.code, JSON.stringify(resumed.envelope)).toBe(0);
      expect(starts.map((event) => event.attempt)).toEqual([1, 2]);
      expect(starts.map((event) => event.route)).toEqual(["wait-once@pi", "wait-once@pi"]);
    }
  });

  it.each(["start", "end"])("resumes after a hard kill at recovery %s", (stage) => {
    const hook = path.resolve(__dirname, "fixtures/kill-recovery.mjs");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        hook,
        DR,
        "drive",
        "Interrupted recovery",
        "--root",
        root,
        "--config",
        write("config.json", config()),
        "--json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          DR_TEST_KILL_RECOVERY: stage,
        },
      },
    );
    expect(result.signal).toBe("SIGKILL");
    const run = fs
      .readdirSync(root)
      .map((name) => path.join(root, name))
      .find((dir) => fs.existsSync(runLayout(dir).stateFile));
    if (!run) throw new Error("no interrupted run");
    const layout = runLayout(run);
    expect(JSON.parse(fs.readFileSync(layout.driveJournalFile, "utf8")).recovery).toBe("started");
    // The child has exited and this fixture owns its lease. Emulate the
    // documented operator repair, never have drive steal a stale lease.
    expect(JSON.parse(fs.readFileSync(layout.mutationFile, "utf8")).pid).toBe(result.pid);
    expect(() => process.kill(result.pid, 0)).toThrow();
    fs.unlinkSync(layout.mutationFile);
    const before = readLedger(run).map((entry) => entry.attempts);
    const resumed = cli(["drive", "--resume", run]);
    expect(resumed.code, JSON.stringify(resumed.envelope)).toBe(0);
    const journal = JSON.parse(fs.readFileSync(layout.driveJournalFile, "utf8"));
    expect(journal.recovery).toBe("done");
    if (stage === "end") {
      expect(journal.recoveryNote).toContain("recovery skipped");
      expect(readLedger(run).map((entry) => entry.attempts)).toEqual(before);
    } else {
      expect(readLedger(run).map((entry) => entry.attempts)).toEqual(before.map((n) => n + 1));
    }
    expect(
      events(run).filter((event) => event.cmd === "retry-fetch" && event.event === "start"),
    ).toHaveLength(stage === "start" ? 2 : 1);
  });

  it("runs fixtures to done, streams events, and resumes done without work", () => {
    const result = start();
    expect(result.code, JSON.stringify(result.envelope)).toBe(0);
    expect(result.envelope.step).toBe("done");
    const run = result.envelope.run ?? "";
    expect(result.envelope.data).toMatchObject({
      gate: "passed",
      sources: "sources.md",
      report: path.join(run, "report.md"),
      citations: path.join(run, "citations.json"),
      coverage: { tier3: { unreachable: 2 } },
    });
    for (const name of [
      "brief",
      "foundation",
      "gaps",
      "followup",
      "claims",
      "verdicts",
      "briefing",
    ]) {
      expect(
        fs.existsSync(
          path.join(
            run,
            "steps",
            `${name}.${["claims", "verdicts"].includes(name) ? "json" : "md"}`,
          ),
        ),
      ).toBe(true);
    }
    const progress = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(progress).toEqual(events(run));
    const retry = progress.findIndex(
      (event) => event.cmd === "retry-fetch" && event.event === "end",
    );
    const verdict = progress.findIndex(
      (event) => event.scope === "work" && event.step === "verdicts",
    );
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThan(verdict);
    expect(
      progress.filter((event) => event.cmd === "retry-fetch" && event.event === "start"),
    ).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(run, "state/drive/journal.json"), "utf8")).diagnostics,
    ).toEqual([
      { claimId: "c001", reachable: 0, required: 2 },
      { claimId: "c002", reachable: 0, required: 2 },
    ]);
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "command",
          step: "verdicts",
          event: "end",
          outcome: "partial",
        }),
        expect.objectContaining({ step: "finalize", event: "end", stateAfter: "done" }),
      ]),
    );
    const before = events(run).filter((event) => event.scope === "work").length;
    const resumed = cli(["drive", "--resume", run]);
    expect(resumed.code).toBe(0);
    expect(resumed.envelope.data).toEqual(result.envelope.data);
    expect(events(run).filter((event) => event.scope === "work")).toHaveLength(before);
  });
  it("keeps earlier quote-checked batches and refuses changed evidence on resume", () => {
    const baseline = start();
    const source = baseline.envelope.run ?? "";
    const value = config("task");
    Reflect.set(value.steps, "verdicts", {
      query: { task: "judge" },
      selection: route("quotes"),
      fallbacks: [],
      excluded: [],
      warnings: [],
    });
    const paused = start(value);
    const run = paused.envelope.run ?? "";
    const layout = runLayout(run);
    for (const step of ["foundation", "gaps", "followup", "claims"]) {
      expect(
        cli([
          "fulfill",
          step,
          path.join(source, "steps", `${step}.${step === "claims" ? "json" : "md"}`),
          "--root",
          run,
        ]).code,
      ).toBe(0);
    }
    expect(cli(["next", "--root", run]).code).toBe(0);
    writeLedger(
      run,
      readLedger(run).map((entry) => ({ ...entry, status: "ok" })),
    );
    for (const entry of readLedger(run))
      fs.writeFileSync(
        layout.fetched(`${entry.hash}.txt`),
        "The treatment reduced annual turnover.",
      );
    const stopped = cli(["drive", "--resume", run]);
    expect(stopped.code).toBe(2);
    expect(stopped.envelope.errors.join()).toContain("E205");
    expect(stopped.envelope.errors.join()).toContain("c002");
    const state = JSON.parse(fs.readFileSync(layout.stateFile, "utf8"));
    expect(state.verdictBatches).toHaveLength(1);
    expect(state.verdictBatches[0].map((entry: { claimId: string }) => entry.claimId)).toEqual([
      "c001",
      "c001",
    ]);
    const before = events(run).filter((event) => event.scope === "work").length;
    // Simulate death after engine acceptance but before journal bookkeeping.
    const journal = JSON.parse(fs.readFileSync(layout.driveJournalFile, "utf8"));
    for (const work of journal.work) work.submitted = false;
    fs.writeFileSync(layout.driveJournalFile, JSON.stringify(journal));
    expect(cli(["drive", "--resume", run]).envelope.errors.join()).toContain("E208");
    expect(events(run).filter((event) => event.scope === "work")).toHaveLength(before);
    expect(JSON.parse(fs.readFileSync(layout.stateFile, "utf8")).verdictBatches).toEqual(
      state.verdictBatches,
    );
    const first = readLedger(run)[0];
    if (!first) throw new Error("no fixture evidence");
    fs.appendFileSync(layout.fetched(`${first.hash}.txt`), " Changed evidence.");
    const changed = cli(["drive", "--resume", run]);
    expect(changed.envelope.errors.join()).toContain("evidence changed");
    expect(events(run).filter((event) => event.scope === "work")).toHaveLength(before);
    expect(JSON.parse(fs.readFileSync(layout.stateFile, "utf8")).verdictBatches).toEqual(
      state.verdictBatches,
    );
  });

  it("advances the frozen fallback only on provider unavailability", () => {
    const result = start(config("unavailable"));
    expect(result.code, JSON.stringify(result.envelope)).toBe(0);
    const work = events(result.envelope.run ?? "").filter(
      (event) => event.scope === "work" && event.step === "foundation" && event.event === "end",
    );
    expect(work.map((event) => event.outcome)).toEqual(["unavailable", "result"]);
    expect(work.map((event) => event.route)).toEqual(["unavailable@pi", "good@pi"]);
  });
  it("stops on work failure with the recorded step and resume path; resume does not reset attempts", () => {
    const result = start(config("task"));
    expect(result.code).toBe(2);
    expect(result.envelope.step).toBe("foundation");
    expect(result.envelope.errors.join()).toContain("E208");
    expect(JSON.stringify(result.envelope.data)).toContain("--resume");
    const run = result.envelope.run ?? "";
    const before = events(run).filter((event) => event.scope === "work").length;
    expect(cli(["drive", "--resume", run]).code).toBe(2);
    expect(events(run).filter((event) => event.scope === "work")).toHaveLength(before);
  });
  it("rejects reorder at E202 and unsupported drive flags at E106", () => {
    const result = start(config("task"));
    const run = result.envelope.run ?? "";
    const reordered = cli([
      "fulfill",
      "synthesis",
      write("candidate.md", "# Report"),
      "--root",
      run,
    ]);
    expect(reordered.code).toBe(2);
    expect(reordered.envelope.errors.join()).toContain("E202");
    expect(cli(["drive", "Topic", "--skip", "claims"]).envelope.errors.join()).toContain("E106");
  });
  it("freezes the explicit creation count and refuses policy flags on resume", () => {
    const result = cli([
      "drive",
      "Policy fixture",
      "--root",
      root,
      "--config",
      write("config.json", config()),
      "--min-distinct-citations",
      "1",
    ]);
    expect(result.code).toBe(0);
    const run = result.envelope.run ?? "";
    expect(JSON.parse(fs.readFileSync(path.join(run, "state/state.json"), "utf8")).policy).toEqual({
      minDistinctCitations: 1,
    });
    expect(cli(["drive", "--resume", run]).code).toBe(0);
    expect(
      cli(["drive", "--resume", run, "--min-distinct-citations", "1"]).envelope.errors.join(),
    ).toContain("E106");
  });

  it("refuses secret configs containing a hosted candidate before a run or launch", () => {
    const value = config();
    value.privacy = "secret";
    const result = start(value);
    expect(result.code).toBe(1);
    expect(result.envelope.errors.join()).toContain("E109");
    expect(result.envelope.run).toBeNull();
  });
  it("keeps topic bytes and question text out of secret stdout, with full detail local", () => {
    const topic = "Zephyrine Quillwick secret survey";
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".agents/skills/choose-model/references"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".agents/skills/choose-model/references/registry.json"),
      JSON.stringify({
        models: {
          fixture: {
            routes: [
              {
                harness: "pi",
                provider: "fixture",
                model: "question",
                hosted: false,
                privacyEligible: true,
              },
            ],
          },
        },
      }),
    );
    fs.copyFileSync(path.resolve(__dirname, "fixtures/hcn-secret.mjs"), path.join(root, "bin/hcn"));
    fs.chmodSync(path.join(root, "bin/hcn"), 0o755);
    const local = (modelId: string) => ({
      route: `fixture@pi/fixture`,
      harness: "pi",
      provider: "fixture",
      modelId,
      effort: "high",
      hosted: false,
    });
    const value = config("question", "question");
    value.privacy = "secret";
    for (const step of Object.values(value.steps))
      if ("selection" in step) {
        step.query.privacy = "secret";
        step.selection = local("question");
        step.fallbacks = [];
      }
    const spawned = spawnSync(
      process.execPath,
      [DR, "drive", topic, "--root", root, "--config", write("secret.json", value), "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, HOME: home, PATH: `${root}/bin:${process.env.PATH}` },
      },
    );
    expect(spawned.status).toBe(2);
    const stdout = spawned.stdout;
    expect(stdout).not.toContain("Zephyrine");
    expect(stdout).not.toContain("Quillwick");
    expect(stdout).not.toContain("Which scope");
    expect(stdout).toContain("E208");
    const envelope = JSON.parse(stdout) as Envelope;
    expect(envelope.run).toMatch(/\d{4}-\d{2}-\d{2}-run/);
    const diagnostics = JSON.parse(
      fs.readFileSync(path.join(envelope.run ?? "", "state/drive/diagnostics.json"), "utf8"),
    );
    expect(JSON.stringify(diagnostics)).toContain("Which scope, Narrow or Wide?");
    expect(JSON.stringify(diagnostics)).toContain("E208");
  });
  it("stops on invalid gate output, cross-lane output, malformed hcn, and questions", () => {
    for (const [model, code, error] of [
      ["invalid", 2, "E205"],
      ["malformed", 4, "E401"],
      ["question", 2, "E208"],
    ] as const) {
      const result = start(config(model));
      expect(result.code).toBe(code);
      expect(result.envelope.errors.join()).toContain(error);
    }
    const value = config();
    Reflect.set(value.steps, "verdicts", {
      query: { task: "judge" },
      selection: route("cross-lane"),
      fallbacks: [],
      excluded: [],
      warnings: [],
    });
    const result = start(value);
    expect(result.code).toBe(2);
    expect(result.envelope.errors.join()).toContain("assignment");
  });
});
