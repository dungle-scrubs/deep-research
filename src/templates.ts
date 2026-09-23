import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/ layout: dist/cli.js + dist/templates/ (copied by embed script).
// tsx layout: src/../templates/ alongside src/.
const candidates = [path.join(here, "templates"), path.join(here, "..", "templates")];

export function templateDir(): string {
  const fromEnv = process.env.DR_TEMPLATES?.trim();
  if (fromEnv && fromEnv.length > 0) {
    if (fs.existsSync(fromEnv) && fs.statSync(fromEnv).isDirectory()) return fromEnv;
    throw new Error(`DR_TEMPLATES points at a missing directory: ${fromEnv}`);
  }
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  throw new Error(`prompt template directory not found (tried ${candidates.join(", ")})`);
}

export function readTemplate(name: string): string {
  return fs.readFileSync(path.join(templateDir(), `${name}.md`), "utf8");
}
