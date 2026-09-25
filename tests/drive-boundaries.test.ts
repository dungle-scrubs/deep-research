import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commands from "../src/commands/execute.js";
import { acquireMutation, execute } from "../src/commands/execute.js";
import { drive } from "../src/drive.js";
import { driveConfigSchema, driveConfigTemplate, readDriveConfig } from "../src/drive-config.js";
import { fail } from "../src/envelope.js";
import * as events from "../src/events.js";
import { fetchAll, writeLedger } from "../src/fetch.js";
import * as hcn from "../src/hcn.js";
import { HcnStream, hcnArguments } from "../src/hcn.js";
import { runLayout } from "../src/rundir.js";
import { readState } from "../src/state.js";
import { normalizeUrl, urlHash } from "../src/url.js";

let root: string;
const route = {
  route: "fixture@pi",
  harness: "pi" as const,
  provider: "fixture",
  modelId: "fixture",
  effort: "high",
  hosted: true,
};
function config() {
  const choice = {
    query: { task: "research", privacy: "normal" },
    selection: route,
    fallbacks: [],
    excluded: [],
    warnings: [],
  };
  return driveConfigSchema.parse({
    ...driveConfigTemplate(),
    steps: {
      brief: { kind: "topic" },
      foundation: choice,
      gaps: choice,
      followup: choice,
      claims: choice,
      verdicts: choice,
      briefing: choice,
      synthesis: choice,
    },
  });
}
function write(name: string, value: unknown): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}
async function newRun(minDistinctCitations = 1): Promise<string> {
  const created = await execute({
    kind: "new",
    topic: "Fixture",
    rootFlag: root,
    policy: { minDistinctCitations },
  });
  if (!created.envelope.run) throw new Error("fixture run failed");
  return created.envelope.run;
}
async function fulfill(
  run: string,
  step: "brief" | "foundation" | "gaps" | "followup" | "claims",
  value: unknown,
) {
  return execute({ kind: "fulfill", run, step, file: write("input", value) });
}
async function atClaims(run: string) {
  for (const [step, value] of [
    ["brief", "Question?"],
    ["foundation", "https://example.com/a"],
    ["gaps", '```json\n["What else?"]\n```'],
    ["followup", "https://example.com/b"],
  ] as const) {
    expect((await fulfill(run, step, value)).code).toBe(0);
  }
}
async function atVerdicts(): Promise<string> {
  const run = await newRun(2);
  await atClaims(run);
  expect(
    (
      await fulfill(
        run,
        "claims",
        [1, 2].map((n) => ({
          id: `c00${n}`,
          statement: "Fixture fact",
          tier: 3,
          citations: ["http://127.0.0.1/a", "http://127.0.0.1/b"].map((url) => ({
            url,
            title: "Fixture",
            locator: "p1",
          })),
        })),
      )
    ).code,
  ).toBe(0);
  expect((await execute({ kind: "next", run })).code).toBe(0);
  fs.mkdirSync(runLayout(run).driveDir, { recursive: true });
  const value = config();
  value.verdicts.claimsPerBatch = 1;
  fs.writeFileSync(runLayout(run).driveConfigFile, JSON.stringify(value));
  return run;
}

beforeEach(() => {
  fs.mkdirSync(path.resolve(".scratch/tests/drive-boundaries"), { recursive: true });
  root = fs.mkdtempSync(path.resolve(".scratch/tests/drive-boundaries/test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("engine boundaries shared by drive", () => {
  it("records new start before writing prompts and engine state", async () => {
    const append = events.appendRunEvent;
    let observed = false;
    vi.spyOn(events, "appendRunEvent").mockImplementation((run, event) => {
      if (event.cmd === "new" && event.event === "start") {
        observed = true;
        expect(fs.existsSync(runLayout(run).stateFile)).toBe(false);
        expect(fs.readdirSync(runLayout(run).promptsDir)).toEqual([]);
      }
      append(run, event);
    });
    const run = await newRun();
    expect(observed).toBe(true);
    expect(fs.statSync(run).mode & 0o777).toBe(0o700);
  });
  it("enforces distinct identities before committing claims, and repairs at the same step", async () => {
    const run = await newRun(2);
    await atClaims(run);
    const citation = (url: string, sameStudyAs?: string) => ({
      url,
      sameStudyAs,
      locator: "p1",
      title: "Fixture",
    });
    const a = "https://example.com/a",
      b = "https://example.com/b";
    const claim = {
      id: "c001",
      statement: "Fact",
      tier: 1,
      citations: [citation(a), citation(`${a}?utm_source=x#p2`)],
    };
    for (const claims of [
      [claim],
      [{ ...claim, citations: [citation(a), citation(b, a)] }],
      [
        { ...claim, citations: [citation(a), citation(b)] },
        { ...claim, id: "c002", citations: [citation(a, b)] },
      ],
    ]) {
      const failed = await fulfill(run, "claims", claims);
      expect(failed.code).toBe(2);
      expect(failed.envelope.errors.join()).toContain("distinct-citation-count 1 < required 2");
      expect(readState(run).step).toBe("claims");
      expect(fs.existsSync(runLayout(run).claimsFile)).toBe(false);
    }
    expect(
      (await fulfill(run, "claims", [{ ...claim, citations: [citation(a), citation(b)] }])).code,
    ).toBe(0);
    expect(readState(run).policy).toEqual({ minDistinctCitations: 2 });
  });
  it("refuses mutations while a lease is held, permits status, and never steals stale leases", async () => {
    const run = await newRun();
    const lease = acquireMutation(run);
    expect((await fulfill(run, "brief", "Question?")).code).toBe(4);
    expect((await execute({ kind: "status", run })).code).toBe(0);
    expect(readState(run).step).toBe("brief");
    lease.release();
    expect((await fulfill(run, "brief", "Question?")).code).toBe(0);
    fs.writeFileSync(runLayout(run).mutationFile, JSON.stringify({ pid: 99999999, token: "old" }));
    expect((await execute({ kind: "next", run })).envelope.errors.join()).toContain(
      "ownership unavailable",
    );
  });
  it("requires a start event before mutation and reports post-commit event failure with the actual pointer", async () => {
    const run = await newRun();
    const layout = runLayout(run);
    const append = events.appendRunEvent;
    const spy = vi.spyOn(events, "appendRunEvent").mockImplementation(() => {
      throw new Error("storage failure");
    });
    expect((await fulfill(run, "brief", "Question?")).code).toBe(4);
    expect(readState(run).step).toBe("brief");
    expect(fs.existsSync(layout.step("brief.md"))).toBe(false);
    spy.mockImplementation((dir, event) => {
      if (event.event === "end") throw new Error("end storage failure");
      append(dir, event);
    });
    const result = await fulfill(run, "brief", "Question?");
    expect(result.envelope).toMatchObject({ step: "foundation", data: { committed: true } });
    expect(readState(run).step).toBe("foundation");
    expect(fs.readFileSync(layout.step("brief.md"), "utf8")).toBe("Question?");
  });
  it("does not retry a failed scraper acquisition during drive recovery", async () => {
    const run = await newRun();
    const url = "https://example.com/a";
    writeLedger(run, [
      {
        attempts: 2,
        bytes: 0,
        contentType: null,
        fetchedAt: "now",
        finalUrl: null,
        hash: urlHash(url),
        normalized: normalizeUrl(url),
        reason: "scraper failed",
        status: "unreachable",
        tier: "scraper",
        url,
      },
    ]);
    const scrapeFn = vi.fn();
    const fetchFn = vi.fn();
    const result = await fetchAll({
      runDir: run,
      urls: [url],
      retryOnly: true,
      onlyUntriedScraper: true,
      tier: "scraper",
      scrapeFn,
      fetchFn,
    });
    expect(result[0]?.attempts).toBe(2);
    expect(scrapeFn).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("progress and hcn protocol boundaries", () => {
  it("buffers split JSON and UTF-8, reads legacy rows, and refuses truncation/replacement", () => {
    const file = write("events", "");
    const cursor = new events.EventCursor(file);
    const row = { cmd: "status", event: "end", pid: 1, ts: "now", errors: ["café"] };
    const buffer = Buffer.from(`${JSON.stringify(row)}\n`);
    const split = buffer.indexOf(Buffer.from("é")) + 1;
    fs.appendFileSync(file, buffer.subarray(0, split));
    expect(cursor.read()).toEqual([]);
    expect(() => new events.EventCursor(file, true)).toThrow("incomplete record");
    fs.appendFileSync(file, buffer.subarray(split, buffer.length - 1));
    expect(cursor.read()).toEqual([]);
    fs.appendFileSync(file, "\n");
    expect(cursor.read()).toEqual([row]);
    fs.writeFileSync(file, "");
    expect(() => cursor.read()).toThrow("truncated");
    const replacement = new events.EventCursor(file);
    replacement.read();
    fs.renameSync(file, `${file}.old`);
    fs.writeFileSync(file, "");
    expect(() => replacement.read()).toThrow("replaced");
  });
  it("accepts only clean final assistant output, classifies failures, and preserves questions", () => {
    const parse = (rows: unknown[], code = 0) => {
      const stream = new HcnStream();
      for (const row of rows) stream.line(JSON.stringify(row));
      return stream.finish(code);
    };
    const message = { kind: "message", role: "assistant", text: "artifact" };
    const done = { kind: "done", exitCode: 0, cause: "clean" };
    expect(parse([{ kind: "token", text: "ignored" }, message, done])).toEqual({
      kind: "result",
      text: "artifact",
    });
    for (const rows of [
      [message],
      [message, done, done],
      [message, { ...done, exitCode: 2 }],
      [{ kind: "failure", class: "new-class" }, done],
    ])
      expect(parse(rows).kind).toBe("internal");
    for (const [name, expected] of [
      ["quota", "unavailable"],
      ["trust-refused", "stopped"],
      ["budget", "stopped"],
      ["internal", "internal"],
    ]) {
      const failure = { class: name, retryable: true, message: "detail" };
      expect(
        parse(
          [
            { kind: "failure", ...failure },
            { kind: "done", cause: "failed", exitCode: 1, failure },
          ],
          1,
        ).kind,
      ).toBe(expected);
    }
    const native = { class: "native", retryable: false, message: "shutdown" };
    const timeout = { class: "timeout", retryable: false, message: "deadline" };
    expect(
      parse(
        [
          { kind: "failure", ...native },
          { kind: "failure", ...timeout },
          { kind: "done", cause: "killed", exitCode: null, failure: timeout },
        ],
        1,
      ),
    ).toMatchObject({ kind: "stopped", failure: { class: "timeout" } });
    expect(
      parse([
        { kind: "identity", sessionId: "confirmed" },
        { kind: "question", question: "Scope?", options: ["A", "B"] },
        { kind: "done", cause: "awaiting-input", exitCode: 0 },
      ]),
    ).toMatchObject({ kind: "question", sessionId: "confirmed" });
    expect(hcnArguments(route, "/attempt", false)).toEqual(
      expect.arrayContaining(["--access", "read"]),
    );
    expect(hcnArguments(route, "/attempt", false)).not.toContain("--no-extensions");
    expect(hcnArguments({ ...route, hosted: false }, "/attempt", true)).toEqual(
      expect.arrayContaining([
        "--no-tools",
        "--no-instruction-files",
        "--no-extensions",
        "--no-skills",
        "--prompt-file",
        "/attempt/prompt.txt",
      ]),
    );
  });
});

describe("durable scheduler", () => {
  it("retries recovery after an engine failure rather than stranding the started flag", async () => {
    const run = await atVerdicts();
    const original = commands.execute;
    let recoveries = 0;
    vi.spyOn(commands, "execute").mockImplementation(async (command, options) => {
      if (command.kind === "retry-fetch" && ++recoveries === 1)
        return fail(4, run, "verdicts", ["E401: fixture persistence failure"]);
      return original(command, options);
    });
    vi.spyOn(hcn, "runHcn").mockResolvedValue({
      kind: "stopped",
      failure: { class: "task", retryable: false, message: "stop after recovery" },
    });
    expect((await drive({ resume: run })).envelope.errors).toEqual([
      "E401: fixture persistence failure",
    ]);
    expect((await drive({ resume: run })).envelope.errors.join()).toContain("worker stopped");
    expect(recoveries).toBe(2);
    expect(JSON.parse(fs.readFileSync(runLayout(run).driveJournalFile, "utf8")).recovery).toBe(
      "done",
    );
  });

  it("resumes a sibling canceled by lane failure without replaying manually repaired pairs", async () => {
    const run = await atVerdicts();
    const launch = vi
      .spyOn(hcn, "runHcn")
      .mockImplementation(async (_route, directory, _secret, signal) => {
        const prompt = fs.readFileSync(path.join(directory, "prompt.txt"), "utf8");
        const input = JSON.parse(prompt.split("DR_INPUT_JSON\n")[1] ?? "{}");
        if (input.assignment.pairs[0].claimId === "c001")
          return {
            kind: "stopped",
            failure: { class: "task", retryable: false, message: "lane failed" },
          };
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ kind: "canceled" }), { once: true }),
        );
      });
    expect((await drive({ resume: run })).code).toBe(2);
    expect(
      (
        await execute({
          kind: "fulfill",
          run,
          step: "verdicts",
          file: write(
            "repair.json",
            ["http://127.0.0.1/a", "http://127.0.0.1/b"].map((url) => ({
              claimId: "c001",
              url,
              verdict: "not-found",
            })),
          ),
        })
      ).code,
    ).toBe(0);
    launch.mockImplementation(async (_route, directory) => {
      const prompt = fs.readFileSync(path.join(directory, "prompt.txt"), "utf8");
      if (!prompt.includes("DR_STEP: verdicts"))
        return {
          kind: "stopped",
          failure: { class: "task", retryable: false, message: "stop at briefing" },
        };
      const input = JSON.parse(prompt.split("DR_INPUT_JSON\n")[1] ?? "{}");
      expect(input.assignment.pairs.map((pair: { claimId: string }) => pair.claimId)).toEqual([
        "c002",
        "c002",
      ]);
      return {
        kind: "result",
        text: JSON.stringify(
          input.assignment.pairs.map((pair: object) => ({ ...pair, verdict: "not-found" })),
        ),
      };
    });
    expect((await drive({ resume: run })).envelope.step).toBe("briefing");
    const journal = JSON.parse(fs.readFileSync(runLayout(run).driveJournalFile, "utf8"));
    expect(
      journal.work
        .filter((work: { step: string }) => work.step === "verdicts")
        .map((work: { attempts: { number: number }[] }) =>
          work.attempts.map((attempt) => attempt.number),
        ),
    ).toEqual([[1], [1, 2]]);
  });

  it.each(["gate", "done", "pre-commit"])(
    "preserves the %s result when cleanup fails",
    async (scenario) => {
      vi.spyOn(hcn, "runHcn").mockResolvedValue({ kind: "result", text: "invalid" });
      const stopped = await drive({
        topic: "Fixture",
        root,
        config: write("config.json", config()),
      });
      const run = stopped.envelope.run ?? "";
      const layout = runLayout(run);
      if (scenario === "done") {
        fs.writeFileSync(layout.stateFile, JSON.stringify({ ...readState(run), step: "done" }));
        fs.writeFileSync(
          layout.matrixFile,
          JSON.stringify({ coverage: { tier3: { unreachable: 1 } } }),
        );
      } else if (scenario === "pre-commit") {
        fs.writeFileSync(layout.mutationFile, JSON.stringify({ token: "stale", pid: 99999999 }));
      }
      const resetGate = (): void => {
        if (scenario !== "gate") return;
        const journal = JSON.parse(fs.readFileSync(layout.driveJournalFile, "utf8"));
        fs.writeFileSync(layout.driveJournalFile, JSON.stringify({ ...journal, work: [] }));
      };
      resetGate();
      const expected = await drive({ resume: run });
      if (scenario === "gate") expect(expected.envelope.errors[0]).toMatch(/^E205:/);
      resetGate();
      const follow = events.followEvents;
      vi.spyOn(events, "followEvents").mockImplementation((...args) => {
        const tail = follow(...args);
        return {
          ...tail,
          close() {
            tail.close();
            throw new Error("fixture cleanup failure");
          },
        };
      });
      const result = await drive({ resume: run });
      expect(result.code).toBe(expected.code);
      expect(result.envelope).toMatchObject(expected.envelope);
      expect(result.envelope.data?.cleanupErrors).toEqual([
        "E401: drive cleanup/progress failed: fixture cleanup failure",
      ]);
      expect(result.envelope.data?.committed).toBeUndefined();
    },
  );

  it("keeps a real post-commit failure and both cleanup diagnostics", async () => {
    const append = events.appendRunEvent;
    vi.spyOn(events, "appendRunEvent").mockImplementation((run, event) => {
      if (event.cmd === "fulfill" && event.step === "brief" && event.event === "end")
        throw new Error("fixture post-commit event failure");
      append(run, event);
    });
    const follow = events.followEvents;
    vi.spyOn(events, "followEvents").mockImplementation((...args) => {
      const tail = follow(...args);
      return {
        ...tail,
        close() {
          tail.close();
          throw new Error("fixture close failure");
        },
      };
    });
    const acquire = commands.acquireMutation;
    vi.spyOn(commands, "acquireMutation").mockImplementation((run) => {
      const lease = acquire(run);
      return {
        token: lease.token,
        release() {
          lease.release();
          throw new Error("fixture release failure");
        },
      };
    });
    const result = await drive({ topic: "Fixture", root, config: write("config.json", config()) });
    expect(result.code).toBe(4);
    expect(result.envelope).toMatchObject({
      step: "foundation",
      errors: ["E401: end event not saved: fixture post-commit event failure"],
      data: {
        committed: true,
        cleanupErrors: [
          "E401: drive cleanup/progress failed: fixture close failure",
          "E401: drive cleanup/progress failed: fixture release failure",
        ],
      },
    });
    expect(readState(result.envelope.run ?? "").step).toBe("foundation");
    expect(fs.existsSync(runLayout(result.envelope.run ?? "").mutationFile)).toBe(false);
  });

  it("surfaces journal E108 and stale-lease E401 without relabeling", async () => {
    vi.spyOn(hcn, "runHcn").mockResolvedValue({
      kind: "stopped",
      failure: { class: "task", retryable: false, message: "pause" },
    });
    const initial = await drive({ topic: "Fixture", root, config: write("config.json", config()) });
    const run = initial.envelope.run ?? "";
    const layout = runLayout(run);
    const journal = JSON.parse(fs.readFileSync(layout.driveJournalFile, "utf8"));
    fs.writeFileSync(
      layout.driveJournalFile,
      JSON.stringify({ ...journal, configHash: "mismatch" }),
    );
    const mismatch = await drive({ resume: run });
    expect(mismatch.code).toBe(1);
    expect(mismatch.envelope.errors).toEqual([
      "E108: frozen config differs from the recorded work plan",
    ]);
    fs.writeFileSync(layout.mutationFile, JSON.stringify({ token: "stale", pid: 99999999 }));
    const leased = await drive({ resume: run });
    expect(leased.code).toBe(4);
    expect(leased.envelope.errors[0]).toMatch(/^E401: mutation ownership unavailable:/);
    expect(leased.envelope.errors[0]?.match(/E401/g)).toHaveLength(1);
  });

  it("rechecks secret routes before counting an attempt or emitting a work start, including resume", async () => {
    const value = config();
    value.privacy = "secret";
    for (const choice of Object.values(value.steps))
      if ("selection" in choice) {
        choice.query.privacy = "secret";
        choice.selection.hosted = false;
      }
    // Synthetic metadata only. No credential store or live model is used.
    vi.spyOn(hcn, "validateLaunchConfig").mockResolvedValue(null);
    const recheck = vi.spyOn(hcn, "validateLocalRoutes").mockResolvedValue("identity changed");
    const launch = vi
      .spyOn(hcn, "runHcn")
      .mockResolvedValue({ kind: "internal", reason: "should not launch" });
    const initial = await drive({ topic: "Fixture", root, config: write("secret.json", value) });
    const run = initial.envelope.run ?? "";
    for (const result of [initial, await drive({ resume: run })]) {
      expect(result.code).toBe(1);
      expect(result.envelope.errors).toEqual(["E109: identity changed"]);
    }
    expect(launch).not.toHaveBeenCalled();
    const journal = JSON.parse(fs.readFileSync(runLayout(run).driveJournalFile, "utf8"));
    expect(journal.work[0].attempts).toEqual([]);
    const rows = fs
      .readFileSync(runLayout(run).eventsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.scope === "work")).toEqual([]);
    recheck.mockResolvedValue(null);
    launch.mockResolvedValue({
      kind: "unavailable",
      failure: { class: "quota", retryable: true, message: "fixture stop" },
    });
    expect((await drive({ resume: run })).code).toBe(2);
    expect(launch).toHaveBeenCalledTimes(1);
    const admitted = JSON.parse(fs.readFileSync(runLayout(run).driveJournalFile, "utf8"));
    expect(admitted.work[0].attempts.map((attempt: { number: number }) => attempt.number)).toEqual([
      1,
    ]);
  });

  it("reuses a persisted clean result after interruption before fulfill, without another launch", async () => {
    const value = config();
    const file = write("config.json", value);
    let foundationCalls = 0;
    vi.spyOn(hcn, "runHcn").mockImplementation(async (_route, directory) => {
      const prompt = fs.readFileSync(path.join(directory, "prompt.txt"), "utf8");
      if (prompt.includes("DR_STEP: foundation")) {
        foundationCalls += 1;
        return { kind: "result", text: "https://example.com/a" };
      }
      return {
        kind: "stopped",
        failure: { class: "task", retryable: false, message: "stop at gaps" },
      };
    });
    const stopped = await drive({
      topic: "Fixture",
      root,
      config: file,
      onEvent(event) {
        if (event.scope === "work" && event.outcome === "result")
          throw new Error("consumer failed after result persistence");
      },
    });
    const run = stopped.envelope.run ?? "";
    expect(stopped.code).toBe(4);
    expect(readState(run).step).toBe("foundation");
    expect((await drive({ resume: run })).envelope.step).toBe("gaps");
    expect(foundationCalls).toBe(1);
  });
  it("counts launching attempts on resume and preserves fixed caps and config", async () => {
    const value = config();
    value.limits.maxAttemptsPerWorkItem = 1;
    value.steps.foundation.fallbacks = [{ ...route, modelId: "fallback", route: "fallback@pi" }];
    const file = write("config.json", value);
    const spy = vi.spyOn(hcn, "runHcn").mockResolvedValue({
      kind: "unavailable",
      failure: { class: "quota", retryable: true, message: "limited" },
    });
    const stopped = await drive({ topic: "Fixture", root, config: file });
    const run = stopped.envelope.run ?? "";
    expect(stopped.envelope.errors.join()).toContain("E209");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await drive({ resume: run })).envelope.errors.join()).toContain("E209");
    expect(spy).toHaveBeenCalledTimes(1);
    const changed = { ...value, limits: { ...value.limits, maxAttemptsPerWorkItem: 2 } };
    expect(
      (await drive({ resume: run, config: write("changed.json", changed) })).envelope.errors.join(),
    ).toContain("E108");
    const journal = JSON.parse(fs.readFileSync(runLayout(run).driveJournalFile, "utf8"));
    journal.work[0].attempts[0].outcome = "launching";
    fs.writeFileSync(runLayout(run).driveJournalFile, JSON.stringify(journal));
    expect((await drive({ resume: run })).envelope.errors.join()).toContain("E208");
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("refuses unverified local identities before any worker launch", async () => {
    const value = config();
    value.privacy = "secret";
    for (const choice of Object.values(value.steps))
      if ("selection" in choice) {
        choice.query.privacy = "secret";
        choice.selection.hosted = false;
      }
    const launch = vi.spyOn(hcn, "runHcn");
    const result = await drive({ topic: "Fixture", root, config: write("secret.json", value) });
    expect(result.envelope.errors.join()).toContain("E109");
    expect(result.envelope.run).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });

  it("bounds total work items without inventing skips", async () => {
    const value = config();
    value.limits.maxWorkItems = 1;
    const launch = vi
      .spyOn(hcn, "runHcn")
      .mockResolvedValue({ kind: "result", text: "https://example.com/a" });
    const result = await drive({ topic: "Fixture", root, config: write("config.json", value) });
    expect(result.envelope.errors.join()).toContain("E209");
    expect(result.envelope.step).toBe("gaps");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("validates default/template/unknown config and missing locality without launching", () => {
    expect(readDriveConfig(write("template.json", driveConfigTemplate()))).toHaveProperty("result");
    expect(readDriveConfig(write("unknown.json", { ...config(), skip: "claims" }))).toHaveProperty(
      "result",
    );
    const value = config();
    value.privacy = "secret";
    for (const choice of Object.values(value.steps))
      if ("selection" in choice) {
        choice.query.privacy = "secret";
        choice.selection.hosted = false;
      }
    const raw = JSON.parse(JSON.stringify(value));
    delete raw.steps.foundation.selection.hosted;
    const result = readDriveConfig(write("secret.json", raw));
    expect("result" in result && result.result.envelope.errors.join()).toContain("E109");
  });
});
