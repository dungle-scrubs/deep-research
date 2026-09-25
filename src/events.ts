import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, openSync, readSync, statSync, watch } from "node:fs";
import { z } from "zod";
import { runLayout } from "./rundir.js";
import { STEP_ORDER } from "./steps.js";

const eventSchema = z.object({
  ts: z.string(),
  event: z.enum(["start", "end", "crash"]),
  cmd: z.string(),
  pid: z.number(),
  exitCode: z.number().optional(),
  ok: z.boolean().optional(),
  errors: z.array(z.string()).optional(),
  v: z.literal(2).optional(),
  operationId: z.string().optional(),
  scope: z.enum(["command", "work"]).optional(),
  step: z
    .enum([...STEP_ORDER, "done"])
    .nullable()
    .optional(),
  parentId: z.string().optional(),
  workId: z.string().optional(),
  batch: z.number().optional(),
  attempt: z.number().optional(),
  route: z.string().optional(),
  stateAfter: z.string().nullable().optional(),
  outcome: z.string().optional(),
});
export type RunEvent = Readonly<z.infer<typeof eventSchema>>;
export type EventContext = Pick<
  RunEvent,
  "cmd" | "step" | "parentId" | "workId" | "batch" | "attempt" | "route"
> & { readonly operationId: string; readonly scope: "command" | "work" };

const active = new Map<string, { readonly run: string; readonly event: RunEvent }>();
export function activeRunOperations(): readonly {
  readonly run: string;
  readonly event: RunEvent;
}[] {
  return [...active.values()];
}

/** Strict for mutations/work: no work begins without its durable start. */
export function appendRunEvent(runDir: string, event: RunEvent): void {
  appendFileSync(runLayout(runDir).eventsFile, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flush: true,
  });
  if (event.operationId) {
    if (event.event === "start") active.set(event.operationId, { run: runDir, event });
    else active.delete(event.operationId);
  }
}
export function eventContext(
  cmd: string,
  step: RunEvent["step"],
  extra: Partial<EventContext> = {},
): EventContext {
  return { cmd, step, operationId: randomUUID(), scope: "command", ...extra };
}
export function startEvent(context: EventContext | string): RunEvent {
  const current = typeof context === "string" ? eventContext(context, null) : context;
  return { ...current, v: 2, event: "start", pid: process.pid, ts: new Date().toISOString() };
}
export function endEvent(
  context: EventContext | string,
  exitCode: number,
  ok: boolean,
  errors: readonly string[],
  stateAfter: string | null = null,
  outcome = "failed",
): RunEvent {
  return {
    ...startEvent(context),
    errors: [...errors],
    event: "end",
    exitCode,
    ok,
    stateAfter,
    outcome,
  };
}

/** Byte cursor, not line counts. A partial UTF-8 sequence remains in the buffer
 * until its newline arrives. Replacement/truncation requires operator repair. */
export class EventCursor {
  private offset: number;
  private pending = Buffer.alloc(0);
  private identity: string | undefined;
  constructor(
    private readonly file: string,
    fromEnd = false,
  ) {
    this.offset = 0;
    if (fromEnd) {
      try {
        const stat = statSync(file);
        this.offset = stat.size;
        this.identity = `${stat.dev}:${stat.ino}`;
        if (stat.size > 0) {
          const fd = openSync(file, "r");
          try {
            const last = Buffer.alloc(1);
            readSync(fd, last, 0, 1, stat.size - 1);
            if (last[0] !== 10)
              throw new Error(
                "E401: existing event stream ends in an incomplete record; reconcile cursor",
              );
          } finally {
            closeSync(fd);
          }
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  read(): RunEvent[] {
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch (error) {
      if (
        this.identity === undefined &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return [];
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if ((this.identity !== undefined && identity !== this.identity) || stat.size < this.offset)
        throw new Error("E401: event stream replaced or truncated; reconcile cursor");
      this.identity = identity;
      const events: RunEvent[] = [];
      while (this.offset < stat.size) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - this.offset));
        const bytes = readSync(fd, chunk, 0, chunk.length, this.offset);
        if (bytes === 0) break;
        this.offset += bytes;
        this.pending = Buffer.concat([this.pending, chunk.subarray(0, bytes)]);
        let end = this.pending.indexOf(10);
        while (end >= 0) {
          const line = this.pending.subarray(0, end).toString("utf8");
          this.pending = this.pending.subarray(end + 1);
          events.push(eventSchema.parse(JSON.parse(line)));
          end = this.pending.indexOf(10);
        }
      }
      return events;
    } finally {
      closeSync(fd);
    }
  }
}

export function followEvents(
  run: string,
  onEvent: (event: RunEvent) => void,
  fromEnd = false,
): { drain(): void; close(): void } {
  const layout = runLayout(run);
  const cursor = new EventCursor(layout.eventsFile, fromEnd);
  let failure: unknown;
  const drain = (): void => {
    if (failure) throw failure;
    for (const event of cursor.read()) onEvent(event);
  };
  const wake = (): void => {
    try {
      drain();
    } catch (error) {
      failure = error;
    }
  };
  const timer = setInterval(wake, 50);
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(layout.stateDir, wake);
    watcher.on("error", () => {
      watcher?.close();
    });
  } catch {
    /* Polling remains active where filesystem notifications are unavailable. */
  }
  return {
    drain,
    close() {
      clearInterval(timer);
      watcher?.close();
      drain();
    },
  };
}
