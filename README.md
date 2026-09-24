# deep-research

`dr` is a deterministic deep-research pipeline CLI: it turns one research
question into a verified, citation-traced report. Hosted deep-research
tools search well and validate poorly - citations nobody checked against
the pages they name. `dr` inverts that: the caller (a human or an agent
session) supplies the intelligence - searching, judging, writing - with
whatever model it chooses per step, and the CLI holds state, fetches
every cited URL itself, derives claim statuses by fixed rules, and
refuses to advance on anything it cannot check. Every claim in the final
report carries a status traceable to fetched evidence on disk.

Spec: `docs/rfc/01_deep-research-cli-deterministic-pipeline-with-caller-supplied-intelligence.rfc.md`.
Tracker: GitHub issues on `dungle-scrubs/deep-research` (private).

## Inspiration

The pipeline design borrows from Tom's Yudame research process
([workflow](https://github.com/yudame/research/blob/main/.claude/skills/new-podcast-episode.md),
[methodology](https://research.yuda.me/methodology.html)): two-pass retrieval
with gap analysis between, a cross-validation matrix, gates between stages,
and methodology baked into prompts. `dr` makes that machinery deterministic
and fixes its known weakness - matrix entries compared tool outputs instead
of underlying sources - by fetching every cited URL and deriving claim
statuses from caller verdicts against the fetched text.

## Install (dev)

Node via mise. No npm publish in v1.

```sh
pnpm install
pnpm build
node dist/dr.mjs --help
```

## Skill for agent sessions

One line, no Homebrew:

```sh
ln -s "$(pwd)/skills/deep-research" ~/.agents/skills/deep-research
```

The skill teaches an agent session to drive the CLI: the loop, the
per-step choose-model queries, and the untrusted-content warning for
fetched pages.

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

## Smoke

```sh
pnpm smoke
```

Builds, then drives a fixture run end to end (loopback citation, SSRF
refusal, unreachable derivation, report gate) to done. Exits green.

## Status

Tickets #11-#14 are implemented and closed: prose pipeline, claims schema
and fetcher, verdicts and derivation, briefing/synthesis/finalize. This
ticket (#15) adds the skill, README, and smoke recipe.

## License

MIT - see [LICENSE](LICENSE).
