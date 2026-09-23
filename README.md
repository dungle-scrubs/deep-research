# deep-research

`dr` - a deterministic deep-research pipeline CLI. The caller (a human or
agent session) supplies the intelligence - searching, judging, writing -
with whatever model it chooses per step. The CLI holds state, validates
structure, fetches cited sources, derives claim statuses, and gates
progression. The CLI never calls a model.

Spec: `docs/rfc/01_deep-research-cli-deterministic-pipeline-with-caller-supplied-intelligence.rfc.md`.
Tracker: GitHub issues on `dungle-scrubs/deep-research` (private).

## Install (dev)

Node via mise. No npm publish in v1.

```sh
pnpm install
pnpm build
node dist/dr.mjs --help
```

## Use

```sh
node dist/dr.mjs new "burnout in early childhood educators"
node dist/dr.mjs next
node dist/dr.mjs fulfill brief ./brief.md
node dist/dr.mjs status
node dist/dr.mjs help gaps
```

Runs live in `YYYY-MM-DD-slug/` under the cwd, `--root <dir>`, or
`DR_ROOT`. Every command takes `--json` (envelope
`{ok, run, step, errors[]}`). Exits: 0 ok, 1 usage, 2 gate/validation,
3 nothing takeable, 4 internal.

## Status

Ticket #11 (scaffold + prose pipeline: brief, foundation, gaps, followup)
is the implemented slice. Tickets #12-#15 own claims/fetch, verdicts,
briefing/synthesis/finalize, and skill/README/smoke.
