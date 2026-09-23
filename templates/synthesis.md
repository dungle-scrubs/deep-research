# Synthesis: {{TOPIC}}

Write `report.md` from the briefing only. The briefing's statuses are
final; the report mirrors them. The finalize gate checks the structure
below and the evidence table against the matrix.

## Status permissions (non-negotiable)

- `verified`: state as fact with citation.
- `single-source`: state only with a not-corroborated label.
- `conflict`: present both sides.
- `misrepresented`, `not-found`: excluded from the report body; listed in
  the Discarded claims appendix.
- `unreachable`: usable only with a source-not-checked caveat.

## Report structure (the finalize gate enforces these sections)

```
# <title>

## Question
## Verified findings
## Single-source findings
## Conflicts
## Gaps and uncertainty
## Practical implications

## Evidence table

| Claim | Citation | Status |
| --- | --- | --- |
| c001 | https://... | verified |

## Discarded claims
```

Every claim the report uses (verified, single-source, conflict) must have
an Evidence table row whose Status cell matches the matrix. An unreachable
claim used in the report needs a row carrying the literal label
`source-not-checked`. Misrepresented and not-found claims must appear by
id under Discarded claims. No fabricated citations: every citation in the
table comes from claims.json.
