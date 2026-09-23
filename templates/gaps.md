# Gap analysis: {{TOPIC}}

Read the foundation output against the brief. Find what is missing,
thin, or contradictory, then turn each gap into a targeted follow-up
question below. The follow-up step answers exactly these questions.

## Gaps

For each gap: what is missing, why it matters to the brief's question,
and what kind of source would close it (academic, industry, policy,
real-time).

## Contradictions

Where foundation sources disagree: the two sides, their evidence, and
what would settle it.

## Follow-up questions

A fenced JSON list of follow-up questions, one string per question,
ordered most important first. The CLI reads this block deterministically:
it MUST be a single fenced `json` code block containing a JSON array of
strings. Example:

```json
[
  "What is the prevalence of X in population Y since 2020?",
  "Do sources A and B disagree on Z, and what explains the difference?"
]
```
