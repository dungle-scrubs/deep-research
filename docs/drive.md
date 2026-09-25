# Run research without an agent session

`dr drive` schedules the existing pipeline through hcn child processes. It
uses the same commands, validators, quote checks, and report gate as manual
`dr next` / `dr fulfill`. The CLI does not call a model SDK or judge research
quality. Use the agent loop when a session must make research decisions.

## Configure a new run

Install hcn on PATH, then emit the template:

```sh
dr drive --print-config > research-drive.json
```

Replace each null step with a complete choose-model result. Keep `query`,
`selection`, ordered `fallbacks`, `excluded`, `warnings`, and all returned
provenance. A route needs `route`, `harness`, `modelId`, `provider` (null
except for Pi), `effort`, and explicit `hosted`. `dr drive --help` describes
the consumed fields. The emitted template is not runnable until populated.
The template has no comments or invented routes.

The config has these fixed policies:

- `privacy`: `normal` or `secret`.
- `policy.minDistinctCitations`: positive integer; template default 2.
- `limits.maxAttemptsPerWorkItem`: positive integer; template default 3.
- `limits.maxWorkItems`: positive integer; template default 1000.
- `verdicts.lanes`: maximum concurrent workers; template default 2.
- `verdicts.claimsPerBatch`: whole claims per assignment; template default 20.
- `steps.brief`: `{ "kind": "topic" }`. The brief repeats the question and
  marks context and scope as unspecified. It invents neither.

Foundation and followup each run once. These are the two search passes.
There is no thin-search detector, quality retry, automatic corrective turn,
or model judge for sufficiency. Gates accept or stop the supplied work.
Numeric caps bound work, not evidence quality.

```sh
dr drive "Burnout in early childhood educators" --config research-drive.json --root ./runs --json
```

Without `--config`, a new run reads exactly `./dr-drive.json`. There is no
config search or global config creation. Invalid or missing config returns
E108 before a worker launches. Unknown drive config keys are rejected;
choose-model provenance fields are retained without re-ranking routes.

### Citation policy

A distinct citation is a distinct normalized document, after `sameStudyAs`
merges across the full claims input. Different locators do not add sources.
A `sameStudyAs` target does not count unless the claim actually cites it.

Manual `dr new` defaults to 1. Either creation command accepts
`--min-distinct-citations <n>`. For drive, this overrides the config value
before freezing it. The stored policy applies to both drivers and cannot
be lowered on resume.

Claims below the floor fail E205 before `steps/claims.json` is written.
Supply another distinct document or remove/narrow the unsupported claim,
then fulfill claims again at the same step. Already accepted earlier steps
cannot be re-fulfilled. Start a new run if those artifacts must change.

The count is an evidence-input floor. It does not prove reachability,
entailment, truth, or complete research. Low reachable-document counts are
saved as diagnostics in the drive journal, not a late gate that strands
accepted claims. Unreachable sources remain visible in report caveats.

## Read progress and results

With `--json`, stdout has exactly one final envelope. Stderr streams
newline-delimited records from `state/events.jsonl`, without hcn tokens or
tool output. Human mode renders those same records on stderr.

New event rows have `v: 2`, `operationId`, `scope`, `step`, and optional
parent/work/batch/attempt/route identifiers. `step` is the operation's step;
`stateAfter` is the resulting pointer. A prompt description is `described`,
a model artifact is `result`, and a successful partial verdict batch is
`partial`. None means that the whole pipeline completed. Legacy rows remain
readable without invented historical step context.

Success at `done` returns `gate: "passed"`, absolute `report` and `citations`
paths, run-relative `sources: "sources.md"`, and the engine matrix's
`coverage`. Ordinary finalize returns the same data. A resumed done run
launches no model and returns that result.

A cleanup or final progress-drain failure does not replace the result or its
exit code. It adds `data.cleanupErrors` with E401 diagnostics, also printed
in human mode. Only an engine post-commit failure sets `data.committed`;
cleanup alone makes no claim that work committed.

Both drivers produce the same canonical research artifacts and engine
command events under equal inputs and policy. Timestamps, process IDs,
correlation IDs, and run paths differ. Drive also writes work events and
`state/drive/` diagnostics. Whole directories are therefore not byte-identical.

## Fetches and verdict lanes

Drive starts with the normal plain-first fetch, then requests a guarded
scraper recovery pass before any verdict worker. Resume can continue an
interrupted or failed pass for URLs with no recorded scraper acquisition.
A scraper attempt already recorded in the ledger is not repeated, even if
it failed.
Drive uses the complete ledger, not only newly changed retry rows. SSRF and
robots refusals remain refusals through both tiers.

Each verdict assignment owns whole claims and all their unresolved citation
pairs. Workers get separate attempt directories and read-only access; the
parent stores results and fulfills batches serially in assignment order.
A worker cannot resolve another lane's pairs or repeat its conflict marker.
Every batch passes the ordinary quote gate atomically. Failed batches do
not remove previously accepted batches. Lanes are throughput slots, not
independent corroborating opinions.

## Stop and resume

Only provider-unavailable classes advance the saved route chain:
`rate-limit`, `usage-limit`, `quota`, `auth`, `transport`, `unavailable`.
Each unavailable route is exhausted once per work item. Parent cancellation
(SIGINT, SIGTERM, or another lane's failure) records `canceled` separately
from a worker failure. Resume retries that route at the next attempt number,
within the same fixed cap; cancellation does not select a fallback. Work failures
(`task`, `budget`, `rejected`, `native`, `timeout`, `trust-refused`) stop.
Malformed or contradictory hcn terminals and hcn internal failures return
E401. A question stops with its confirmed session ID and question in the
failure data. Drive does not answer it or grant more permissions.

| Error | Exit | Repair |
| --- | --- | --- |
| E108 | 1 | Fix config before creation. Changed resume config is refused. |
| E109 | 1 | Use a complete local-only secret config with verified registry identities. |
| E202 | 2 | Fulfill only the current takeable step. Unknown flags such as `--skip` are E106, not state transitions. |
| E205 | 2 | Fix the rejected candidate and fulfill the named step. |
| E207 | 2 | Edit `report.md` in place and run `dr next`. Re-fulfilling synthesis is not allowed at finalize. |
| E208 | 2 | Inspect the attempt, repair manually, and resume at the recorded step. |
| E209 | 2 | The fixed cap is reached. Use manual work or a new run; resume does not reset it. |
| E401 | 4 | Inspect state and diagnostics. If `data.committed` is true, inspect accepted state before retrying. |

```sh
dr status --root ./runs/<run> --json
dr fulfill verdicts ./fixed-batch.json --root ./runs/<run> --json
dr drive --resume ./runs/<run> --json
```

Resume names an exact directory, without a topic or `--root`. The run-local
config is frozen. An explicitly supplied resume config must match it,
including any effective creation-policy override.

`state/state.json` is authoritative. The drive journal records stable work
identities, input/evidence/config hashes, and attempts before launch. A
clean stored candidate can be reused after interruption only when its full
assignment remains unresolved and its hashes match. Already accepted pairs
are not replayed; mixed assignments are rebuilt for only unresolved pairs.
A launch without a conclusive result stops for manual repair. It does not
receive a fresh attempt allowance. A recorded parent cancellation can use
the next slot, but it cannot reset the cap. Older `stopped` records do not
establish parent cancellation and still require manual repair.

No fetch retry runs alongside verdict workers or after accepted drive
batches. Changed evidence after accepted batches stops for reconciliation.
After an interrupted or failed scraper recovery, resume retries only URLs
that are not ok and have no recorded scraper acquisition. If none remain,
it clears the started flag and records `fetch recovery skipped: no untried
scraper acquisitions remain` in the journal's `recoveryNote`. If verdict
batches were accepted manually, it skips recovery with `fetch recovery
skipped: verdict batches already accepted`. Verdict work can then proceed;
the evidence-change check still applies.

`state/mutation.json` admits one writer. A second drive or manual mutation
fails while the owner holds it; read-only status/help still work. A stale
PID is not permission to steal a lease. Establish that the named owner has
stopped and verify its identity before an operator removes the stale lease.
Cancellation stops owned workers, waits for termination, and keeps the
engine's recorded step. A hard kill can leave the lease for operator repair.

## Secret privacy

Every choice query must say `privacy: secret`; every selected and fallback
route must explicitly say `hosted: false`. Mixed or unknown locality is
refused before the first model launch. Drive checks local identities against
the public choose-model registry at
`~/.agents/skills/choose-model/references/registry.json` and the non-secret
`hcn inspect pi --models --json` provider/model list. Both must agree. It
rechecks the selected route before counting an attempt or writing its start
event. A refusal returns E109 on both the initial invocation and resume,
without consuming a slot. It never reads
credential-bearing provider configuration to establish identity.

Locality metadata is a trusted administrative assertion, not proof against
a malicious administrator or a provider proxy reconfigured to send data
elsewhere. Missing registry metadata refuses the route.

Secret workers receive `--no-tools --no-instruction-files --no-extensions
--no-skills`. Prompts use `--prompt-file`, not secret argv text. Required
accepted inputs are compiled locally. Run directories and driver prompt,
result, and diagnostic files have owner-only access. Progress exposes
identifiers and sanitized error codes, not prompts or source text.

Secret final stdout carries only the outcome: ok, step, exit code, and
the run path. New secret runs are named without the topic slug
(`YYYY-MM-DD-run`, numbered on collision), so the logged path proves
nothing about content. Worker question text, engine error strings, and
all result data move to `state/drive/diagnostics.json` (mode 0600),
which the caller reads deliberately: `dr status --root <run>`, the run
`report.md`, or the diagnostics file itself. The programmatic `drive()`
result is unsealed; only CLI stdout is redacted, so library callers and
existing tests keep the complete envelope. Non-secret output is
unchanged. The crash channel follows the same rule: E499 code on
stdout in secret mode, full trace in the run events.

The trade: every secret run is two reads instead of one. Cron keeps a
clean log; the operator loses single-stream triage.

Tool-free local steps cannot perform fresh web searches. If inputs cannot
support the task, the worker must stop or ask. Use an authorized local
research path through the agent driver instead. Hosted fallback or weaker
containment is never a remedy. Tests establish refusal and offline protocol
behavior, not live local research quality.
