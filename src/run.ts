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
  const flag = options.rootFlag?.trim();
  if (flag && flag.length > 0) return path.resolve(cwd, flag);
  const envRoot = env.DR_ROOT?.trim();
  if (envRoot && envRoot.length > 0) return path.resolve(cwd, envRoot);
  return cwd;
}

/** Pick a non-colliding run directory name under root. */
export function uniqueRunDir(root: string, topic: string, now: Date = new Date()): string {
  const base = `${todayPrefix(now)}-${slugify(topic)}`;
  let candidate = path.join(root, base);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${base}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}
