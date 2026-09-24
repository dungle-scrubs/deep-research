---
name: Bug report
about: Something in dr behaved incorrectly
labels: bug
---

**Command line and exit code** (e.g. `dr fulfill claims c.json` -> exit 2):

**Envelope / error lines** (with --json if possible):

**What happened vs what you expected:**

**Run state**: does `state/events.jsonl` end with a start line that never
got an end line? If the failure is E4xx/E499, the auto-file protocol
already covers this - check for an existing issue before filing.
