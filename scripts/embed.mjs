import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const templatesSrc = path.join(root, "templates");
const templatesDist = path.join(root, "dist", "templates");

// Ship prompt templates next to the bundle so src/templates.ts finds them.
fs.mkdirSync(templatesDist, { recursive: true });
for (const file of fs.readdirSync(templatesSrc)) {
  if (file.endsWith(".md")) {
    fs.copyFileSync(path.join(templatesSrc, file), path.join(templatesDist, file));
  }
}
fs.chmodSync(path.join(root, "dist", "dr.mjs"), 0o755);
console.log("embed: dist/templates/ ready");
