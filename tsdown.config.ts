import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { dr: "src/cli.ts" },
  format: ["esm"],
  dts: false,
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
});
