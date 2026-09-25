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
Tracker: GitHub issues on `dungle-scrubs/deep-research`.

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
3 nothing takeable, 4 internal. Drive also uses exit 1 for config/privacy
refusals and exit 2 for worker failures or fixed caps.

## Drive for non-agent callers

Use the agent loop above for sessions that make research decisions. A human
shell, cron job, or another tool can use the one-request driver:

```sh
dr drive --print-config > research-drive.json
# Replace every null step with its complete choose-model result.
dr drive "burnout in early childhood educators" --config research-drive.json --json
```

`dr drive --help` describes the config. The template uses fixed work/attempt
caps and a creation policy of 2 distinct documents per claim. Manual runs
default to 1. Either creation command accepts `--min-distinct-citations <n>`;
that policy cannot be lowered after creation.

Drive launches hcn child processes, never a model SDK. It keeps the same
engine gates and artifacts. Stderr streams run events; stdout returns one
final envelope with report, coverage, citations, and sources pointers.
Provider unavailability advances the frozen fallback chain. A worker or
gate failure stops at the recorded step for manual repair.

Read [the drive guide](docs/drive.md) for config fields, privacy, verdict
lanes, bounded scraper recovery, and interruption repair. Secret configs
refuse hosted candidates and require confirmed local registry identities;
tool-free secret search may be unavailable.

## Scraper fetch tier

Plain fetch is the default. HTTP 403 and pages with no extracted text fall
back to the optional scraper package. Install its CLI on PATH:

```sh
pipx install dungle-scrubs-scraper
```

The package uses local Crawl4AI/Chromium. Follow its setup instructions if
it reports a missing browser. `dr` disables its Jina fallback and makes no
model calls. Missing dependencies and scraper failures become ledger
outcomes, not run failures.

To use scraper directly for the fetch step, or retry failed sources:

```sh
DR_FETCH_TIER=scraper dr next
dr retry-fetch
```

The selection lasts for that invocation; there is no config file.
`DR_FETCH_TIER=plain` selects plain first, including on `retry-fetch`.
Retries keep `ok` entries unchanged and attempt each non-ok URL through
scraper by default. SSRF checks, robots rules, per-origin document pacing,
the 15-second attempt deadline, and the 5 MiB stored-document cap apply to
both tiers. Scraper's own SSRF checks also cover browser requests.

The ledger records `tier: plain | scraper` alongside the existing status.
Each tier attempt increments `attempts`; plain plus fallback counts as two.
Older ledger rows without a tier read as `plain`. Scraper stores its
markdown in both `.raw` and `.txt`; that content is untrusted page evidence.
Its `finalUrl` is null because the scraper CLI does not report the final
redirect URL. Citation exports include `documents[].fetch.tier` and
`unfetched[].tier` (null when no ledger row exists). These fetch tiers are
separate from the numeric evidence tiers on claims.

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
