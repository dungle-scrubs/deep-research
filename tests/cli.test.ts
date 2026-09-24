import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const DR = path.join(REPO, "dist", "dr.mjs");

interface Envelope {
  readonly ok: boolean;
  readonly run: string | null;
  readonly step: string | null;
  readonly errors: readonly string[];
  readonly data?: Record<string, unknown>;
}

let workdir: string;

function run(args: readonly string[], env?: NodeJS.ProcessEnv): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [DR, ...args], {
      cwd: workdir,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "").toString() };
  }
}

function runJson(
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): { code: number; env: Envelope } {
  const { code, out } = run([...args, "--json"], env);
  return { code, env: JSON.parse(out) as Envelope };
}

function write(name: string, text: string): string {
  const file = path.join(workdir, name);
  fs.writeFileSync(file, text, "utf8");
  return file;
}

const BRIEF = `# Brief\n\n## Question\n\nWhat drives burnout?\n\n## Context\n\nTurnover.\n\n## Scope\n\nUS. Excludes family care.\n`;
const FOUNDATION = `# Foundation\n\n## Findings\n\nBurnout 45-72% (https://example.com/a).\n`;
const GAPS = `# Gaps\n\nThin evidence.\n\n\`\`\`json\n[\n  "Does coaching help?",\n  "What pay predicts exits?"\n]\n\`\`\`\n`;
const FOLLOWUP = `# Followup\n\n## 1\n\nCoaching small effects (https://example.com/b).\n\n## 2\n\nPay bands predict exits (https://example.com/c).\n`;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-test-"));
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("dr new", () => {
  it("creates a dated run dir with prompts, steps, state", () => {
    const { code, out } = run(["new", "Burnout in ECE!"]);
    expect(code).toBe(0);
    expect(out).toContain("Created run");
    const dirs = fs.readdirSync(workdir);
    expect(dirs).toHaveLength(1);
    const runDir = path.join(workdir, dirs[0] ?? "");
    expect(dirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-burnout-in-ece$/);
    for (const sub of ["prompts", "steps", "state", "fetched"]) {
      expect(fs.statSync(path.join(runDir, sub)).isDirectory()).toBe(true);
    }
    for (const template of ["brief.md", "foundation.md", "gaps.md", "followup.md"]) {
      const text = fs.readFileSync(path.join(runDir, "prompts", template), "utf8");
      expect(text).toContain("Burnout in ECE!");
      expect(text).not.toContain("{{TOPIC}}");
    }
    const state = JSON.parse(fs.readFileSync(path.join(runDir, "state", "state.json"), "utf8"));
    expect(state.step).toBe("brief");
    expect(state.topic).toBe("Burnout in ECE!");
  });

  it("honors --root over cwd", () => {
    const root = path.join(workdir, "custom-root");
    const { code } = run(["new", "Topic", "--root", root]);
    expect(code).toBe(0);
    expect(fs.readdirSync(root)).toHaveLength(1);
    expect(fs.readdirSync(workdir)).toEqual(["custom-root"]);
  });

  it("honors DR_ROOT when no --root flag", () => {
    const root = path.join(workdir, "env-root");
    const { code } = run(["new", "Topic"], { DR_ROOT: root });
    expect(code).toBe(0);
    expect(fs.readdirSync(root)).toHaveLength(1);
  });

  it("rejects an empty topic with exit 1", () => {
    const { code, env } = runJson(["new", "   "]);
    expect(code).toBe(1);
    expect(env.ok).toBe(false);
    expect(env.errors[0]).toMatch(/^E101/);
  });

  it("makes unique names for repeat topics", () => {
    expect(run(["new", "Same"]).code).toBe(0);
    expect(run(["new", "Same"]).code).toBe(0);
    expect(fs.readdirSync(workdir)).toHaveLength(2);
  });
});

describe("prose pipeline", () => {
  function newRun(topic = "Burnout"): string {
    expect(run(["new", topic]).code).toBe(0);
    return path.join(workdir, fs.readdirSync(workdir)[0] ?? "");
  }

  it("walks brief -> foundation -> gaps -> followup -> claims", () => {
    newRun();
    expect(run(["fulfill", "brief", write("brief.md", BRIEF)]).code).toBe(0);
    expect(run(["next"]).out).toContain("Takeable step: foundation");
    expect(run(["fulfill", "foundation", write("f.md", FOUNDATION)]).code).toBe(0);
    expect(run(["fulfill", "gaps", write("g.md", GAPS)]).code).toBe(0);
    expect(run(["fulfill", "followup", write("fo.md", FOLLOWUP)]).code).toBe(0);
    const { code, env } = runJson(["status"]);
    expect(code).toBe(0);
    expect(env.step).toBe("claims");
    expect(env.data?.completed).toEqual(["brief", "foundation", "gaps", "followup"]);
  });

  it("rejects citations before derivation with exit 1", () => {
    newRun();
    const { code, env } = runJson(["citations"]);
    expect(code).toBe(1);
    expect(env.errors[0]).toMatch(/^E104/);
  });

  it("rejects empty fulfill with exit 2 and does not advance", () => {
    newRun();
    const { code, env } = runJson(["fulfill", "brief", write("empty.md", "  \n")]);
    expect(code).toBe(2);
    expect(env.errors.join("\n")).toContain("empty");
    expect(runJson(["status"]).env.step).toBe("brief");
  });

  it("rejects foundation without URLs", () => {
    newRun();
    run(["fulfill", "brief", write("brief.md", BRIEF)]);
    const { code, env } = runJson(["fulfill", "foundation", write("f.md", "# F\n\nNo links.\n")]);
    expect(code).toBe(2);
    expect(env.errors.join("\n")).toContain("no URLs");
    expect(runJson(["status"]).env.step).toBe("foundation");
  });

  it("rejects gaps without a question list", () => {
    newRun();
    run(["fulfill", "brief", write("brief.md", BRIEF)]);
    run(["fulfill", "foundation", write("f.md", FOUNDATION)]);
    const { code, env } = runJson(["fulfill", "gaps", write("g.md", "# G\n\nNo list.\n")]);
    expect(code).toBe(2);
    expect(env.errors.join("\n")).toContain("```json");
  });

  it("rejects gaps with invalid question JSON", () => {
    newRun();
    run(["fulfill", "brief", write("brief.md", BRIEF)]);
    run(["fulfill", "foundation", write("f.md", FOUNDATION)]);
    const bad = `# G\n\n\`\`\`json\n{"not": "an array"}\n\`\`\`\n`;
    const { code, env } = runJson(["fulfill", "gaps", write("g.md", bad)]);
    expect(code).toBe(2);
    expect(env.errors.join("\n")).toContain("array");
  });

  it("fills the follow-up template from the gaps question list", () => {
    const runDir = newRun("Burnout in ECE");
    run(["fulfill", "brief", write("brief.md", BRIEF)]);
    run(["fulfill", "foundation", write("f.md", FOUNDATION)]);
    run(["fulfill", "gaps", write("g.md", GAPS)]);
    const followup = fs.readFileSync(path.join(runDir, "prompts", "followup.md"), "utf8");
    expect(followup).toContain("1. Does coaching help?");
    expect(followup).toContain("2. What pay predicts exits?");
    expect(followup).not.toContain("{{QUESTIONS}}");
    expect(followup).toContain("Burnout in ECE");
  });

  it("rejects fulfill for a non-takeable step", () => {
    newRun();
    const { code, env } = runJson(["fulfill", "gaps", write("g.md", GAPS)]);
    expect(code).toBe(2);
    expect(env.errors.join("\n")).toContain("not takeable");
  });

  it("rejects unknown steps with exit 1", () => {
    newRun();
    const { code, env } = runJson(["fulfill", "bogus", write("g.md", GAPS)]);
    expect(code).toBe(1);
    expect(env.errors[0]).toMatch(/^E103/);
  });

  it("next on a future-owned step exits 2", () => {
    newRun();
    run(["fulfill", "brief", write("brief.md", BRIEF)]);
    run(["fulfill", "foundation", write("f.md", FOUNDATION)]);
    run(["fulfill", "gaps", write("g.md", GAPS)]);
    run(["fulfill", "followup", write("fo.md", FOLLOWUP)]);
    // claims is implemented in ticket #12: next names it with its prompt.
    const claims = runJson(["next"]);
    expect(claims.code).toBe(0);
    expect(claims.env.step).toBe("claims");
    // Walk claims with a loopback-only citation; the fetch step then
    // executes, records the SSRF refusal as unreachable, and advances.
    const claimsJson = JSON.stringify([
      {
        id: "c001",
        statement: "A factual statement.",
        citations: [{ url: "http://127.0.0.1/x", locator: "p1", title: "T" }],
        tier: 3,
      },
    ]);
    expect(run(["fulfill", "claims", write("claims.json", claimsJson)]).code).toBe(0);
    const runDir = path.join(workdir, fs.readdirSync(workdir)[0] ?? "");
    const claimsBefore = fs.readFileSync(path.join(runDir, "steps", "claims.json"), "utf8");
    const fetched = runJson(["next"]);
    expect(fetched.code).toBe(0);
    expect(fetched.env.step).toBe("verdicts");
    // Verdicts fulfill (ticket #13) derives statuses and advances.
    const verdictsJson = JSON.stringify([
      { claimId: "c001", url: "http://127.0.0.1/x", verdict: "not-found", note: "" },
    ]);
    const verdict = runJson(["fulfill", "verdicts", write("verdicts.json", verdictsJson)]);
    expect(verdict.code).toBe(0);
    expect(verdict.env.step).toBe("briefing");
    // claims.json is byte-identical after derivation.
    const claimsAfter = fs.readFileSync(path.join(runDir, "steps", "claims.json"), "utf8");
    expect(claimsAfter).toBe(claimsBefore);
    // matrix.json exists with derived statuses.
    const matrix = JSON.parse(fs.readFileSync(path.join(runDir, "state", "matrix.json"), "utf8"));
    expect(matrix.claims[0].status).toBe("unreachable");
    // Full walk to done (ticket #14): briefing, synthesis, finalize.
    const briefing = "# Briefing\n\n## Coverage\n\nunreachable: 1\n";
    const briefed = runJson(["fulfill", "briefing", write("briefing.md", briefing)]);
    expect(briefed.code).toBe(0);
    expect(briefed.env.step).toBe("synthesis");
    // Briefing coverage mismatch is rejected.
    const badBriefing = "# Briefing\n\n## Coverage\n\nverified: 5\n";
    expect(runJson(["fulfill", "briefing", write("bad.md", badBriefing)]).code).toBe(2);
    const report = [
      "# Report",
      "",
      "## Question",
      "What?",
      "",
      "## Verified findings",
      "None.",
      "",
      "## Single-source findings",
      "None.",
      "",
      "## Conflicts",
      "None.",
      "",
      "## Gaps and uncertainty",
      "The only citation was unreachable.",
      "",
      "## Practical implications",
      "None yet.",
      "",
      "## Evidence table",
      "",
      "| Claim | Citation | Status |",
      "| --- | --- | --- |",
      "| c001 | http://127.0.0.1/x | unreachable (source-not-checked) |",
      "",
      "## Discarded claims",
      "None.",
    ].join("\n");
    const synthesized = runJson(["fulfill", "synthesis", write("report.md", report)]);
    expect(synthesized.code).toBe(0);
    expect(synthesized.env.step).toBe("finalize");
    const done = runJson(["next"]);
    expect(done.code).toBe(0);
    expect(done.env.step).toBe("done");
    expect(fs.existsSync(path.join(runDir, "sources.md"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "citations.json"))).toBe(true);
    // dr citations reads the same export from the closed run.
    const cited = runJson(["citations"]);
    expect(cited.code).toBe(0);
    const exportData = cited.env.data?.citations as {
      documents: { url: string; citedBy: { claimId: string; claimStatus: string }[] }[];
      unfetched: { url: string }[];
    };
    expect(exportData.documents).toHaveLength(0);
    expect(exportData.unfetched).toHaveLength(1);
    expect(exportData.unfetched[0]?.url).toBe("http://127.0.0.1/x");
    expect(exportData.unfetched[0]?.citedBy[0]?.claimStatus).toBe("unreachable");
    // Unknown format is a usage error.
    expect(runJson(["citations", "--format", "bibtex"]).code).toBe(1);
    expect(runJson(["next"]).code).toBe(3);
    expect(runJson(["status"]).env.data?.current).toBe("done");
    // A closed run can be read but not advanced.
    const closed = runJson(["fulfill", "briefing", write("again.md", briefing)]);
    expect(closed.code).toBe(2);
    expect(closed.env.errors.join("\n")).toContain("E201");
  });
});

describe("envelope and help", () => {
  it("emits the stable envelope on every command", () => {
    const created = runJson(["new", "Topic"]);
    expect(created.env.ok).toBe(true);
    for (const key of ["ok", "run", "step", "errors"]) {
      expect(created.env).toHaveProperty(key);
    }
    expect(runJson(["next"]).env.ok).toBe(true);
    expect(runJson(["status"]).env.ok).toBe(true);
    expect(runJson(["help"]).env.ok).toBe(true);
    expect(runJson(["help", "brief"]).env.ok).toBe(true);
  });

  it("exits 1 when no run exists", () => {
    const { code, env } = runJson(["status"]);
    expect(code).toBe(1);
    expect(env.errors[0]).toMatch(/^E102/);
  });

  it("help covers the pipeline and each prose step", () => {
    const { out } = run(["help"]);
    expect(out).toContain("brief");
    expect(out).toContain("finalize");
    for (const step of ["brief", "foundation", "gaps", "followup"]) {
      const { code, out: stepOut } = run(["help", step]);
      expect(code).toBe(0);
      expect(stepOut).toContain(step);
    }
  });

  it("help on an unknown step exits 1", () => {
    expect(runJson(["help", "bogus"]).code).toBe(1);
  });

  it("resumes from directory state alone", () => {
    run(["new", "Topic"]);
    run(["fulfill", "brief", write("brief.md", BRIEF)]);
    // Fresh process, no memory: state file is the truth.
    expect(runJson(["status"]).env.step).toBe("foundation");
    expect(run(["next"]).out).toContain("Takeable step: foundation");
  });
});
