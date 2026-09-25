// Kill the real CLI after its recovery start or end is durable. This hook
// changes no run state; resume must reconcile the state left by the process.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const append = fs.appendFileSync;
fs.appendFileSync = (file, data, ...rest) => {
  append(file, data, ...rest);
  if (!String(file).endsWith("/events.jsonl")) return;
  const event = JSON.parse(String(data));
  if (event.cmd === "retry-fetch" && event.event === process.env.DR_TEST_KILL_RECOVERY)
    process.kill(process.pid, "SIGKILL");
};
syncBuiltinESMExports();
