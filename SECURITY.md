# Security Policy

## Supported versions

The `main` branch. No backport releases yet.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository, or email
the owner listed on the repository profile. Include the command line and
the run directory if a crash is involved - `state/events.jsonl` carries
the durable evidence.

## Trust model worth knowing

- The CLI fetches every cited URL. Fetched content is untrusted input:
  the CLI never interprets it beyond text extraction, and callers are
  warned to treat `fetched/` pages as prompt-injection surfaces.
- `claims.json` comes from callers and may arrive from shared runs. The
  fetcher refuses non-HTTP(S) schemes, loopback, private, and link-local
  addresses before any request (SSRF guard), and writes only inside the
  run directory.
- The CLI handles no credentials or secrets. Runs are self-contained
  directories; sharing a run shares its research content, nothing else.
