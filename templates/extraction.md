# Claim extraction: {{TOPIC}}

Read the foundation and follow-up outputs. Extract every atomic factual
claim into the claims.json schema. The CLI fetches every cited URL and a
second pass judges each claim against the fetched text, so the citation
must point at the exact page and location that carries the fact.

## Rules (non-negotiable)

- One claim = one atomic factual statement. Split compound statements.
- Every citation carries url, locator (table, section, or quote that holds
  the fact), and title. No fabricated locators: if the location is
  uncertain, say so in the locator.
- Do not invent URLs. Only cite URLs that appear in the search outputs.
- tier is your judgment: 1 meta-analysis/systematic review/official
  statistics, 2 RCT/large study/government report, 3 case study/industry
  report/news.
- sameStudyAs links two citations that are the same underlying study.
- No statuses: the CLI derives them. You record facts and citations only.

## Output format

Write steps/claims.json as a JSON array:

```json
[
  {
    "id": "c001",
    "statement": "one atomic factual statement",
    "citations": [
      { "url": "https://...", "locator": "Table 2", "title": "Author Year",
        "sameStudyAs": null }
    ],
    "tier": 2,
    "flags": [],
    "notes": ""
  }
]
```
