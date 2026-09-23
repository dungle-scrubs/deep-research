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
    const { code, env } = runJson(["next"]);
    expect(code).toBe(2);
    expect(env.errors.join("\n")).toContain("ticket #12");
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
