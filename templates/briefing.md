# Briefing: {{TOPIC}}

Assemble the validated claims from `state/matrix.json` into the briefing
the synthesis step reads. You organize; you do not re-judge. The matrix
statuses are final for this run.

## Rules (non-negotiable)

- Cite every claim by its claim id and source URL. No fabricated citations.
- Label uncertainty: single-source claims carry "not corroborated";
  unreachable sources carry "source-not-checked". Carry skipped citations
  forward as "skipped; source-not-checked", even when another citation
  supports the claim.
- Status permissions: verified = state as fact; single-source = state with
  the not-corroborated label; conflict = present both sides;
  misrepresented and not-found are excluded here and listed under
  Discarded; unreachable and skipped = include only with the
  source-not-checked label. Skipped citations never count toward support.
  Copy the matrix caveats so skipped pairs remain visible in the report.

## Coverage

End the briefing with a coverage block that echoes the matrix counts
exactly. One line per status with a non-zero count, in this format:

```
verified: 3
single-source: 2
```

The CLI checks these lines against state/matrix.json; a mismatch fails
fulfill.
