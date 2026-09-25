import * as fs from "node:fs";
import * as path from "node:path";

export function slugify(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "run";
}

export function todayPrefix(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface ResolveRootOptions {
  readonly rootFlag?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
}

/** Precedence: --root flag, then DR_ROOT env, then cwd. */
export function resolveRoot(options: ResolveRootOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const nonEmpty = (value: string | undefined): string | null => {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  };
  const flag = nonEmpty(options.rootFlag);
  if (flag !== null) return path.resolve(cwd, flag);
  const envRoot = nonEmpty(env.DR_ROOT);
  if (envRoot !== null) return path.resolve(cwd, envRoot);
  return cwd;
}

/** Create the run directory exclusively; returns its path. Retries with a
 *  numeric suffix when the name is taken (EEXIST race included). */
export function createRunDir(root: string, topic: string, now: Date = new Date()): string {
  const base = `${todayPrefix(now)}-${slugify(topic)}`;
  let suffix = 2;
  for (;;) {
    const candidate = suffix === 2 ? base : `${base}-${suffix}`;
    try {
      fs.mkdirSync(path.join(root, candidate), { recursive: false, mode: 0o700 });
      return path.join(root, candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      suffix += 1;
    }
  }
}
