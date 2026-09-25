import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { z } from "zod";
import type { DriveConfig, Route } from "./drive-config.js";
import { MODEL_STEPS, routeChain } from "./drive-config.js";

const failureSchema = z
  .object({
    class: z.enum([
      "rate-limit",
      "usage-limit",
      "quota",
      "auth",
      "transport",
      "unavailable",
      "task",
      "budget",
      "rejected",
      "native",
      "timeout",
      "trust-refused",
      "internal",
    ]),
    retryable: z.boolean(),
    message: z.string(),
  })
  .passthrough();
const questionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()),
  recommended: z.string().optional(),
});
const doneSchema = z.object({
  cause: z.enum(["clean", "limit", "crash", "stall", "killed", "failed", "awaiting-input"]),
  exitCode: z.number().nullable(),
  failure: failureSchema.optional(),
});
export type WorkOutcome =
  | { readonly kind: "result"; readonly text: string }
  | { readonly kind: "canceled" }
  | { readonly kind: "unavailable" | "stopped"; readonly failure: z.infer<typeof failureSchema> }
  | {
      readonly kind: "question";
      readonly question: z.infer<typeof questionSchema>;
      readonly sessionId: string;
    }
  | { readonly kind: "internal"; readonly reason: string };
const unavailable = new Set([
  "rate-limit",
  "usage-limit",
  "quota",
  "auth",
  "transport",
  "unavailable",
]);

/** Parse only the normalized protocol. Token deltas and tool output never
 * become the artifact. Unknown/missing/contradictory terminals fail closed. */
export class HcnStream {
  private done: z.infer<typeof doneSchema> | undefined;
  private readonly failures: z.infer<typeof failureSchema>[] = [];
  private question: z.infer<typeof questionSchema> | undefined;
  private identity: string | undefined;
  private text: string | undefined;
  private invalid = false;
  line(line: string): void {
    try {
      if (this.done) {
        this.invalid = true;
        return;
      }
      const raw: unknown = JSON.parse(line);
      const tagged = z.object({ kind: z.string() }).passthrough().parse(raw);
      switch (tagged.kind) {
        case "done":
          this.done = doneSchema.parse(raw);
          break;
        case "failure": {
          const next = failureSchema.parse(raw);
          this.failures.push(next);
          break;
        }
        case "question":
          this.question = questionSchema.parse(raw);
          break;
        case "identity":
          this.identity = z.object({ sessionId: z.string().min(1) }).parse(raw).sessionId;
          break;
        case "message": {
          const message = z.object({ role: z.string(), text: z.string() }).parse(raw);
          if (message.role === "assistant") this.text = message.text;
          break;
        }
        case "token":
        case "progress":
        case "tool":
        case "context":
        case "compaction":
        case "limit":
        case "error":
          break;
        default:
          this.invalid = true;
      }
    } catch {
      this.invalid = true;
    }
  }
  finish(exitCode: number | null): WorkOutcome {
    const done = this.done;
    const broken = (): WorkOutcome => ({
      kind: "internal",
      reason: "malformed, missing or contradictory hcn terminal result",
    });
    if (this.invalid || !done) return broken();
    // Hcn can report a native shutdown error followed by its authoritative
    // timeout. The terminal carries the reduced failure, not always the first.
    if (
      done.failure &&
      this.failures.length > 0 &&
      !this.failures.some((failure) => failure.class === done.failure?.class)
    )
      return broken();
    if (!done.failure && new Set(this.failures.map((failure) => failure.class)).size > 1)
      return broken();
    const failure = done.failure ?? this.failures[0];
    if (done.cause === "clean") {
      if (failure || this.question || exitCode !== 0 || done.exitCode !== 0 || !this.text?.trim())
        return broken();
      return { kind: "result", text: this.text };
    }
    if (done.cause === "awaiting-input") {
      if (failure || exitCode !== 0 || done.exitCode !== 0 || !this.question || !this.identity)
        return broken();
      return { kind: "question", question: this.question, sessionId: this.identity };
    }
    if (!failure || exitCode === 0 || this.question) return broken();
    if (failure.class === "internal")
      return { kind: "internal", reason: "hcn internal failure; inspect attempt diagnostics" };
    return { kind: unavailable.has(failure.class) ? "unavailable" : "stopped", failure };
  }
}

const execFileP = promisify(execFile);
const installedSchema = z.object({
  v: z.literal(1),
  source: z.literal("stores"),
  models: z.array(z.object({ provider: z.string(), model: z.string() })),
  skipped: z.array(z.unknown()),
});
/** Non-secret registry surface: establish the configured provider/model pair,
 * not an endpoint attestation. Locality is trusted choice metadata. Unknown
 * registry identity is refused; credential-bearing stores are never opened. */
export async function validateLocalRoutes(routes: readonly Route[]): Promise<string | null> {
  if (routes.some((route) => route.hosted !== false || route.harness !== "pi" || !route.provider))
    return "secret routes need explicit local pi provider identities";
  try {
    // The choice registry is public model metadata, never a credential store.
    // Checking both sources rejects relabeling an installed hosted provider as
    // local. A maliciously reconfigured proxy remains outside this trust model.
    const registrySchema = z.object({
      models: z.record(
        z.string(),
        z.object({
          routes: z.array(
            z.object({
              harness: z.string(),
              provider: z.string().optional(),
              model: z.string(),
              hosted: z.boolean(),
              privacyEligible: z.boolean(),
            }),
          ),
        }),
      ),
    });
    const registry = registrySchema.parse(
      JSON.parse(
        readFileSync(
          join(homedir(), ".agents/skills/choose-model/references/registry.json"),
          "utf8",
        ),
      ),
    );
    for (const route of routes) {
      const known = Object.entries(registry.models).some(([model, facts]) =>
        facts.routes.some(
          (candidate) =>
            candidate.harness === route.harness &&
            candidate.provider === route.provider &&
            candidate.model === route.modelId &&
            candidate.hosted === false &&
            candidate.privacyEligible &&
            route.route === `${model}@${candidate.harness}/${candidate.provider}`,
        ),
      );
      if (!known) return "route identity is not local in the public choose-model registry";
    }
    const { stdout } = await execFileP("hcn", ["inspect", "pi", "--models", "--json"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const result = installedSchema.safeParse(JSON.parse(stdout));
    if (!result.success) return "local provider registry is unavailable";
    for (const route of routes) {
      if (
        !result.data.models.some(
          (model) => model.provider === route.provider && model.model === route.modelId,
        )
      )
        return "local provider/model identity is not installed";
    }
    return null;
  } catch {
    return "cannot establish local provider identity via hcn inspect pi --models --json";
  }
}
export async function validateLaunchConfig(config: DriveConfig): Promise<string | null> {
  if (config.privacy !== "secret") return null;
  return validateLocalRoutes(MODEL_STEPS.flatMap((step) => routeChain(config.steps[step])));
}
export function hcnArguments(route: Route, directory: string, secret: boolean): string[] {
  return [
    "run",
    route.harness,
    "--json",
    "--model",
    route.modelId,
    "--effort",
    route.effort,
    ...(route.provider ? ["--provider", route.provider] : []),
    "--cwd",
    directory,
    "--prompt-file",
    `${directory}/prompt.txt`,
    "--questions",
    "ask",
    "--no-instruction-files",
    "--no-skills",
    // Normal Pi research can need its configured web-search extension. The
    // read preset limits its tools; only secret launches disable discovery.
    ...(secret ? ["--no-tools", "--no-extensions"] : ["--access", "read"]),
  ];
}

/** Parent owns files, launch admission and cancellation. The scheduler checks
 * local identity before recording an attempt, then calls this spawn boundary.
 * No shell, native passthrough or retry with weaker containment. */
export async function runHcn(
  route: Route,
  directory: string,
  secret: boolean,
  signal: AbortSignal,
): Promise<WorkOutcome> {
  if (signal.aborted) return { kind: "canceled" };
  const stdout = openSync(`${directory}/hcn.jsonl`, "wx", 0o600);
  const stderr = openSync(`${directory}/hcn.stderr`, "wx", 0o600);
  return new Promise((resolve) => {
    const parser = new HcnStream();
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let total = 0;
    let storageFailed = false;
    let overflow = false;
    const child = spawn("hcn", hcnArguments(route, directory, secret), {
      cwd: directory,
      stdio: ["ignore", "pipe", stderr],
      detached: process.platform !== "win32",
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* Owned process already exited. */
      }
    };
    const cancel = (): void => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 2000);
    };
    signal.addEventListener("abort", cancel, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        writeSync(stdout, chunk);
      } catch {
        storageFailed = true;
        cancel();
      }
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        overflow = true;
        cancel();
        return;
      }
      pending += decoder.write(chunk);
      let end = pending.indexOf("\n");
      while (end >= 0) {
        parser.line(pending.slice(0, end));
        pending = pending.slice(end + 1);
        end = pending.indexOf("\n");
      }
    });
    let spawnFailed = false;
    child.on("error", () => {
      spawnFailed = true;
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", cancel);
      closeSync(stdout);
      closeSync(stderr);
      if (storageFailed) resolve({ kind: "internal", reason: "cannot persist hcn diagnostics" });
      else if (overflow)
        resolve({
          kind: "stopped",
          failure: {
            class: "task",
            retryable: false,
            message: "hcn output exceeds 64 MiB limit",
          },
        });
      else if (signal.aborted) resolve({ kind: "canceled" });
      else if (spawnFailed)
        resolve({
          kind: "internal",
          reason: "cannot spawn hcn; install hcn and retry after repair",
        });
      else if ((pending + decoder.end()).trim())
        resolve({ kind: "internal", reason: "incomplete hcn NDJSON line" });
      else resolve(parser.finish(code));
    });
  });
}
