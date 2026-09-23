# Findings: choose-model registry survey (ticket 05)

Date: 2026-02-24. Produced inline by the charting session (no delegation). Primary sources: `~/.agents/skills/choose-model/SKILL.md`, `~/.agents/skills/choose-model/references/REGISTRY.md`, `~/.agents/skills/choose-model/references/registry.json`, and live command runs noted as observed.

## The finding that reframes the question

The registry has no "intelligence level" vocabulary. Its two levers are **task type** (a closed vocabulary of 11) and **stakes** (`low` / `normal` / `high`). So the deep-research skill's per-step recommendations should not name levels or models - they should carry a **ready-to-run choose-model query per pipeline step** (task + stakes + privacy), and let the registry resolve it to routes. Naming concrete models goes stale and replaces the deterministic lookup with judgment, which the skill explicitly forbids. Documented: SKILL.md, the `--matrix` note ("Never pick a model by reading the matrix"); REGISTRY.md, "the one closed task vocabulary the delegation stack shares".

## Findings

1. **Task vocabulary (closed, 11 types)**: code-review, computer-use, data-analysis, design, explore, implement, judge, plan, research, security-audit, teach. Unknown values are hard errors (`UNKNOWN_TASK`). Documented in SKILL.md and REGISTRY.md; observed: `choose.ts --tasks` run 2026-02-24, keys cross-checked in registry.json.

2. **Stakes semantics**: `low` = throwaway, `normal` = default, `high` = architecture-level or user-facing hot path. Stakes select the minimums row, not a model class. Documented: SKILL.md, Query section.

3. **Query contract**: JSON in - `task` (required), `stakes`, `privacy` (`normal`/`secret`), `needs` (extra capabilities), `prefer` (`cost`/`speed`), `excludeFamilies`. JSON out: `selection` (first route), `fallbacks` (ordered), `excluded` (with reasons), `warnings`. Each route carries `route` (`<model>@<harness>`), `modelId` (what `hcn run --model` takes), `effort`, `responseSeconds`, scores, `notes`. Documented: SKILL.md, Output section.

4. **Pipeline-step mapping** (recommendation by this survey, not documented anywhere - the registry has never heard of this pipeline):

   | Pipeline step | choose-model query | Reasoning |
   |---|---|---|
   | Foundation search | `{task: "research", stakes: "normal"}` | Closed questions, cite what settles it |
   | Gap analysis | `{task: "explore", stakes: "normal"}` | Open-ended sweep returning a list (gaps, contradictions) |
   | Follow-up searches | `{task: "research", stakes: "normal"}` | Targeted closed questions |
   | Claim extraction | `{task: "data-analysis", stakes: "normal"}` | Structured extraction from documents into the claim schema |
   | Claim-vs-source verdicts | `{task: "judge", stakes: "high"}` | Score claim against fetched text; no repo access; wrong verdicts corrupt the matrix |
   | Briefing assembly | `{task: "data-analysis", stakes: "normal"}` | Organize validated claims into the briefing structure |
   | Synthesis report | `{task: "teach", stakes: "high"}` | User-facing narrative, taste-gated per registry |

5. **Privacy for research runs**: research over public web content is `privacy: "normal"`. A run whose question or sources carry secret material is `secret`, which excludes hosted routes outright. Documented: SKILL.md, Query section (privacy semantics).

6. **The skill composes with our caller-decides principle**: choose-model never runs anything - it is a lookup. A recommendation formatted as a query informs the caller without executing anything, exactly the contract this CLI wants. Documented: SKILL.md, "What it does not do".

## Silence (sources did not answer)

- **Context-window capacity**: routes carry no field for context size. The synthesis step ingests a full briefing; the registry cannot rank routes for that. The skill's recommendation for synthesis should carry a plain-language caveat ("needs a large context"), and the caller judges.
- **No facet for web-search quality**: facets are coding, truth, guardrails; `research` checks the truth facet (AA-Omniscience). Retrieval breadth per route is unmeasured. Nothing in the registry distinguishes "good at finding sources" from "good at judging them".

## What ticket 06 should take from this

Format recommendations as: one choose-model query per step (the table above as the starting point), plus a one-line plain-language expectation per step for human callers who will not run the registry at all.
