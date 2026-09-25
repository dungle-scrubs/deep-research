#!/usr/bin/env node
// Offline secret-mode hcn fixture: local identity plus one worker question.
// It never reads or writes canonical run files.
const args = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
if (args[0] === "inspect") {
  emit({
    v: 1,
    source: "stores",
    models: [{ provider: "fixture", model: "question" }],
    skipped: [],
  });
} else {
  emit({ kind: "identity", sessionId: "fixture-session" });
  emit({ kind: "question", question: "Which scope, Narrow or Wide?", options: ["Narrow", "Wide"] });
  emit({ kind: "done", cause: "awaiting-input", exitCode: 0 });
}
