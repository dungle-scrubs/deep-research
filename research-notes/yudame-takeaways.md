# Yudame research pipeline - takeaways for this CLI

Evidence base for the deep-research-cli design. Extracted 2026-02-24 from the sources listed at the bottom, before charting. Every design idea below traces there.

## The pipeline being borrowed from

A 12-phase podcast workflow in which research is phases 2-7: foundation search, question discovery, targeted multi-source follow-up, cross-validation, master briefing, synthesis. Production (audio, publishing) is out of scope here.

## The five mechanisms that make it work

1. **Two-pass retrieval with gap analysis between.** Perplexity runs first (academic foundation). A gap/contradiction analysis of its output then generates targeted prompts for the follow-up tools (industry, policy, real-time, synthesis lenses). One-shot deep research cannot do this by construction.
2. **Cross-validation matrix.** Claims decomposed into a table: claim x tool, status per claim. VERIFIED = 2+ independent sources. Single-source and conflicting claims are flagged, not dropped; the flag travels to the output.
3. **Opinion quarantine and source tiering.** Social/discourse output is segregated as "not evidence", used only for belief-vs-research contrast. Sources tiered: meta-analyses/systematic reviews/official stats > RCTs/large studies/gov reports > case studies/industry/news.
4. **Writer separated from validator.** A dedicated synthesis agent reads only the validated briefing and refuses to synthesize if validation sections are missing (blocking exit criteria between phases - gates).
5. **Methodology baked into prompts.** Every search prompt demands: effect sizes not just significance, sample sizes, correlation vs causation, study populations, funding/conflicts, contradictory findings, preliminary vs replicated status, full source URLs. This makes outputs machine-validatable later.

## The known weakness to fix

His standard matrix compares tool outputs, not underlying sources. Tools share indexes and training data, so hallucinated citations can pass as "verified". His high-stakes protocol (archiving primary documents with SHA-256, expert review) is the only place real source-level checking happens. **Our v1 makes source-level verification a first-class stage: the CLI fetches each cited URL; the caller's intelligence checks the claim against the fetched text.**

## Yudame's evidence standards worth encoding

- Every claim sourced with study, sample size, methodology
- Correlation never framed as causation
- Contradictions shown, both sides weighted equally
- Uncertainty stated; weak evidence labeled (Strong/Moderate/Preliminary/Limited/Insufficient)
- Specific parameters over vague advice ("90-120 min after waking", not "in the morning")
- Single-source claims labeled "not corroborated across other sources"

## Sources

- Workflow (12 phases, validation matrix): https://github.com/yudame/research/blob/main/.claude/skills/new-podcast-episode.md
- Synthesis agent evidence standards and blocking behavior: https://github.com/yudame/research/blob/main/.claude/agents/podcast-synthesis-writer.md
- High-stakes protocol (PICO/SPIDER, archived primary sources, peer review): https://github.com/yudame/research/blob/main/docs/reference/high-stakes-research-protocol.md
- Quality scorecard (10-dimension retrospective): https://github.com/yudame/research/blob/main/.claude/skills/podcast-quality-scorecard/SKILL.md
- Methodology page: https://research.yuda.me/methodology.html
