---
number: "01"
title: "deep-research CLI: deterministic pipeline with caller-supplied intelligence"
type: feature
status: Accepted
author: kevin
date: "2026-02-24"
---

## Abstract

Deep research tools search well and validate poorly: a hosted deep-research run returns findings whose citations were never checked against the pages they claim to come from. This RFC specifies `dr`, a deterministic TypeScript CLI that orchestrates deep research as a linear pipeline of steps over a run directory. The CLI holds state, validates structure, fetches cited sources, derives claim statuses from caller verdicts, and gates progression; all intelligence - searching, judging, writing - comes from the caller, a human or an agent session using whatever model it chose for each step. The CLI MUST NOT call any model. Validation is the product: every claim in the final report carries a status traceable to fetched evidence.

## Introduction

Hosted deep research (GPT deep research and similar) does the retrieval half of research and skips the verification half. The Yudame research pipeline (see `research-notes/yudame-takeaways.md`) demonstrated the missing machinery - two-pass retrieval, a cross-validation matrix, gates between stages - but implemented it as agent-run prose workflow, and its standard matrix compares tool outputs rather than underlying sources, so hallucinated citations can pass as verified.

This RFC covers the v1 of `dr`, a CLI that makes that machinery deterministic and fixes the source-level weakness: the CLI itself fetches every cited URL, and claims are verified against the fetched text by caller-supplied verdicts, with statuses derived by rule.

Out of scope for v1: the CLI calling any model API; server or daemon mode; npm publication; global config, cache, or any XDG state; gate override flags; post-run diagnostics (a quality-scorecard analog). Each was explicitly ruled out on the decision map (GitHub issues on `dungle-scrubs/deep-research`, map issue #1).

## Terminology

- **Run**: one research effort, a directory on disk created by `dr new`, named `YYYY-MM-DD-slug/`.
- **Step**: one stage of the pipeline. Either a caller step (the caller fulfills it with a file) or a CLI step (the CLI executes it automatically when it becomes takeable).
- **Caller**: the human or agent session driving the run. The caller chooses and runs the model for each caller step.
- **Claim**: one atomic factual statement extracted from search output, a JSON object in `claims.json`.
- **Citation**: a URL plus locator (quote or anchor) supporting a claim.
- **Document**: a cited URL after normalization. One normalized URL is one document.
- **Verdict**: the caller's per-(claim, citation) judgment: `supported`, `partial`, `not-found`, or `contradicts`.
- **Status**: a claim-level label. Derived statuses: `verified`, `single-source`, `misrepresented`, `not-found`, `unreachable`. Caller-set status: `conflict`.
- **Gate**: a deterministic check between stages that MUST pass before the run advances.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

## Motivation

Hosted deep research does half the job and presents the result as finished. The user of this tool has been burned by exactly that: findings whose citations were never checked. The validation half - fetching sources, checking claims against them, deriving statuses, gating on structure - is what must become software rather than agent goodwill.

## Design

## Product stance

The CLI is a deterministic shell: state, validation, fetching, derivation, gating. Intelligence comes from the caller per step. The default answer to "should the CLI do X with a model" is no.

## Commands

| Command | Behavior |
|---|---|
| `dr new <topic> [--root <dir>]` | Create a run directory under the current working directory (or `--root` / `DR_ROOT`), named `YYYY-MM-DD-slug/`. Copy prompt templates into `prompts/`. Initialize `state.json` at step `brief`. |
| `dr next [--json]` | Name exactly one takeable step. If the step is a CLI step, execute it. Print (or emit) the step's prompt, the expected output location, and the help pointer. |
| `dr fulfill <step> <file> [--json]` | Validate the file against the step's schema or structural checks; on success, advance state. CLI derivations (status computation) run at fulfill of `verdicts`. |
| `dr retry-fetch [--json]` | Re-attempt unreachable URLs. Idempotent; already-fetched pages are kept. |
| `dr status [--json]` | Run summary: current step, steps completed, coverage counts, unreachable count. |
| `dr help [<step>] [--json]` | Pipeline overview, or per-step: purpose, prompt template, what good output looks like, recommended intelligence (a choose-model query plus a plain-language line). |

Every command MUST support `--json` with a stable envelope: `{ok, run, step, errors[]}`. Exit codes: `0` ok, `1` usage error, `2` gate or validation failure, `3` nothing takeable.

## Pipeline steps (linear, exactly one takeable at a time)

| # | Step | Kind | Output | Validated by |
|---|---|---|---|---|
| 1 | `brief` | caller | `steps/brief.md` - question, context | non-empty markdown |
| 2 | `foundation` | caller | `steps/foundation.md` - first search output | non-empty markdown, URLs present |
| 3 | `gaps` | caller | `steps/gaps.md` - gap analysis prose plus a fenced JSON list of follow-up questions | non-empty markdown, question list parses |
| 4 | `followup` | caller | `steps/followup.md` - K searches, one section each | non-empty markdown, URLs present |
| 5 | `claims` | caller | `steps/claims.json` - claim objects | Zod schema |
| 6 | `fetch` | CLI | `fetched/` - page evidence, fetch ledger | deterministic (see Fetching) |
| 7 | `verdicts` | caller | `steps/verdicts.json` - verdict array | Zod schema; derivation runs |
| 8 | `briefing` | caller | `steps/briefing.md` - organized validated claims | non-empty markdown, coverage counts consistent with matrix |
| 9 | `synthesis` | caller | `report.md` draft | report structure gate |
| 10 | `finalize` | CLI | final gate pass, `sources.md`, state `done` | deterministic |

Parallelism is the caller's affair: the K follow-up searches in step 4 run on any models, concurrently, before one `fulfill`.

## Claim schema (`steps/claims.json`)

```json
{
  "id": "c001",
  "statement": "Burnout affects 45-72% of ECE professionals by setting type",
  "citations": [
    {"url": "https://...", "locator": "Table 2, 53.2% prevalence", "title": "Wang et al. 2020",
     "sameStudyAs": null}
  ],
  "tier": 2,
  "flags": [],
  "notes": ""
}
```

- `citations[].sameStudyAs`: OPTIONAL URL of another citation that is the same underlying study. Derivation treats the pair as one document.
- `tier`: 1 (meta-analysis, systematic review, official statistics), 2 (RCT, large study, government report), 3 (case study, industry report, news). Caller judgment.
- The caller does not set statuses. The CLI derives them into `state/matrix.json`; `steps/claims.json` is never rewritten.

## URL normalization and independence

Normalize: lowercase scheme and host, strip fragment, strip tracking query parameters (a built-in list), resolve trailing-slash equivalence. One normalized URL is one document; the same URL cited twice is never independence. Independence beyond URL identity is caller judgment expressed through `sameStudyAs`.

## Fetching (step 6)

The CLI fetches every unique normalized cited URL once:

- Follow redirects; record the final URL.
- Respect robots.txt and a per-domain rate limit (SHOULD be at most one request per second per domain).
- Write each result to `fetched/` keyed by hash of the normalized URL: raw content plus extracted text. Fetched pages are durable run evidence.
- Dead link or network error: `unreachable`. The claim's citations on unreachable documents never count toward support.
- PDF: store; extract text when an extraction tool is available, else flag `binary-unreadable`.
- Paywalled response: store what was returned, flag `paywalled`.
- Fetch ledger records per-URL outcome, final URL, content type, timestamp.

## Verdicts and status derivation (step 7)

`steps/verdicts.json`:

```json
[
  {"claimId": "c001", "url": "https://...", "verdict": "supported", "note": "Table 2 states 53.2%"},
  {"claimId": "c004", "conflict": true, "note": "sources give opposite directions"}
]
```

Derivation rules, applied deterministically at fulfill:

1. Count citations per claim with verdict `supported` on pairwise-distinct documents (after normalization and `sameStudyAs` merging).
2. 2+ distinct supported documents -> `verified`. Exactly 1 -> `single-source`.
3. No supported citations and at least one `contradicts` -> `misrepresented`. No supported and none `contradicts` -> `not-found`.
4. A `conflict` entry for a claim overrides the derived status.
5. `partial` counts as no support for derivation but is recorded in the matrix and evidence table.
6. Citations on unreachable documents never count toward support; the report carries the `source-not-checked` caveat for them.

The CLI renders `state/matrix.json` (claims with statuses, per-citation verdicts, coverage counts by tier and status) as the view the briefing and report draw on.

## Synthesis permissions and the report

The synthesis prompt template encodes these as non-negotiable rules; the final gate enforces structure:

- `verified`: state as fact with citation.
- `single-source`: state only with a not-corroborated label.
- `conflict`: present both sides.
- `misrepresented`, `not-found`: excluded from the report body; listed in the Discarded claims appendix.
- `unreachable`: usable only with a source-not-checked caveat.

Report structure (claim-forward, status-mirrored): Question, Verified findings, Single-source findings (labeled), Conflicts, Gaps and uncertainty, Practical implications - then Evidence table and Discarded claims as appendices. The Evidence table lists claim, citation, status. Length follows content; the gate checks structure, not word count. `sources.md` is generated deterministically from `claims.json`, one section per tier.

## Prompts

Templates ship with the CLI and are copied into the run's `prompts/` at `dr new`; the CLI reads the run's copies, so in-run edits change that run without touching the tool. Foundation and follow-up prompts carry the full methodology block (effect sizes not just significance, sample sizes, correlation vs causation, study populations, funding and conflicts, contradictory findings, preliminary vs replicated, full source URLs). Extraction, verdict, briefing, and synthesis prompts carry a light block (citation format, no fabrication, uncertainty labels, status permissions). Substitution is deterministic: the run topic fills every template's subject slot; the `gaps` question list fills the follow-up template's question slots.

## Validation and gates

One validation library: Zod. JSON steps (`claims`, `verdicts`) validate against schemas that double as the TypeScript type source. Prose steps get light structural checks: non-empty, parses as markdown, URLs present where the stage demands them. Gates are deterministic functions over the run directory; a failed gate lists specific violations and the step that can fix them, exits 2, and does not advance. There is no override flag in v1. Malformed fulfill is rejected with specific violations; nothing half-advances.

## Run directory layout

```
YYYY-MM-DD-slug/
├── steps/        # one output file per caller step
├── fetched/      # page evidence from the fetch step
├── prompts/      # templates copied at creation, editable per run
├── state/        # state.json (step pointer, records), matrix.json (derived)
├── claims.json -> steps/claims.json
├── report.md
└── sources.md
```

No global state: no config file (flags and env express everything), no shared cache, nothing outside the run directory. A run is self-contained and shareable by copying one directory. Standing rule for later versions: if config or a cross-run cache is ever added, it lands in XDG config home / cache home.

## Accompanying skill

One `SKILL.md` lives in this repository: how to drive the CLI, the per-step choose-model queries (synthesis `teach/high`, claim verdicts `judge/high`, searches `research/normal`, gap analysis `explore/normal`, extraction and briefing `data-analysis/normal`), and a plain-language expectation line per step for human callers. Recommendations inform; the caller decides. Deployment: symlink the skill directory into `~/.agents/skills/` - one line in the README. No install subcommand in v1.

## State Machine

```
brief -> foundation -> gaps -> followup -> claims -> fetch -> verdicts
      -> briefing -> synthesis -> finalize -> done

- `dr next` executes CLI steps (fetch, finalize) automatically.
- Invalid transition (fulfill for a non-takeable step): reject, exit 2.
- Any interrupted run resumes at its recorded step; state is files, so the
  directory is the truth and every command is a pure function of it.
- Terminal state: done. A closed run MAY be re-read (`status`, `help`) but
  not advanced.
```

## Error Handling

| Code | Condition | Behavior |
|---|---|---|
| E1xx usage | Bad arguments, unknown step, no run found | Message with the correct usage, exit 1 |
| E2xx validation | Malformed fulfill: schema or structural failure | List each violation with the failing field or check; run does not advance; exit 2 |
| E2xx gate | Gate failure between stages | List each violation and the step that can fix it; exit 2 |
| E3xx fetch | Network error, timeout, robots disallow, 4xx/5xx | Record outcome in the fetch ledger; URL becomes `unreachable`; run continues (unreachable is a flag, not a failure) |
| E3xx fetch | Paywall detected | Store response, flag `paywalled`, run continues |
| E4xx internal | Unexpected error | Fail with the error and the state file location; never partially mutate state |

Fetch errors are outcomes, not failures: a run with unreachable sources is valid; the caveat system carries the uncertainty into the report.

## Security Considerations

- **Trust boundary - claim URLs**: `claims.json` is caller-supplied and may arrive from shared runs. The fetcher MUST only fetch `http`/`https` and MUST refuse loopback, link-local, and private IP ranges and `.local` hosts (SSRF guard). A shared run cannot make the tool read the local network.
- **Trust boundary - fetched content**: pages are untrusted text. The CLI does not interpret content beyond text extraction; caller models that read `fetched/` SHOULD treat it as untrusted input (prompt injection surface). The skill and help text carry this warning.
- **Blast radius**: the tool writes only inside the run directory. Worst case is disk usage from fetched content; a size cap per fetched document SHOULD apply.
- **Data sensitivity**: the CLI handles no credentials or secrets. Research topics are stored in the run directory only.

## Alternatives Considered

- **Tool-level verification** (two retrieval tools agreeing counts as verified) - rejected: shared indexes let hallucinated citations pass; this is the weakness the source-fetch stage exists to fix.
- **Server or daemon mode** - rejected at the decision map: a lifecycle to own against the files-as-state grain; agents read and write files natively.
- **Integrated agent doing search and validation in one model run** - rejected: it re-creates hosted deep research's unauditable middle; determinism and auditability are the product.
- **Markdown claim matrix, hand-written** - rejected: parsing brittleness, weak validation; the matrix is rendered from JSON, not parsed into it.
- **XDG global state in v1** - rejected: nothing global to store; runs stay self-contained and shareable.

## Implementation Plan

Phases are ordered; each is demoable on its own:

1. Scaffold: package, command surface (`new/next/fulfill/status/help`), state machine, exit codes, `--json` envelope, run directory creation.
2. Prose steps end to end: brief, foundation, gaps, followup with template copy and substitution.
3. Claims schema + fetcher: Zod schema, URL normalization, SSRF guard, fetch ledger, `fetched/` storage.
4. Verdicts + derivation: verdict schema, status derivation rules, `matrix.json`, coverage views.
5. Briefing + synthesis + finalize: permission-bearing templates, report structure gate, evidence table check, `sources.md` generation.
6. Skill + README: SKILL.md with choose-model queries, symlink instruction, e2e smoke recipe (a justfile or mise task if it spans more than two steps).

## Open Questions

1. PDF text extraction tool choice. Non-blocking implementation decision at phase 3; options: bundled wasm extractor vs system `pdftotext` when present. Criterion: no heavyweight dependency in the core; degrade to `binary-unreadable` flag when absent.

## References

**Normative**

- Decision map: `dungle-scrubs/deep-research` issue #1 and closed tickets #2-#10 - the decisions this RFC renders.
- `research-notes/yudame-takeaways.md` - evidence base for the pipeline design (this repo).
- `research-notes/choose-model-survey.md` - registry vocabulary behind the skill's per-step queries (this repo).

**Informative**

- Yudame research repository workflow: https://github.com/yudame/research/blob/main/.claude/skills/new-podcast-episode.md
- Yudame methodology page: https://research.yuda.me/methodology.html
