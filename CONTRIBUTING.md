# Contributing

`dr` is a deterministic deep-research pipeline CLI. The caller supplies the
intelligence; the CLI holds state, validates, fetches, and gates. Read
`docs/rfc/01_*.rfc.md` before changing pipeline behavior - the RFC is the
spec the tests enforce.

## Setup

```sh
pnpm install
pnpm build     # tsdown bundle + templates into dist/
pnpm test      # builds first (pretest), then runs the vitest suite
```

Node via mise. pnpm is the package manager (Corepack or standalone).

## Before you commit

- `pnpm typecheck` - tsc --noEmit, strict.
- `pnpm lint` - Biome check over src, tests, scripts.
- `pnpm test` - the full suite; the e2e tests drive the built binary.
- `pnpm smoke` - fixture run end to end; exits green or the script fails.

Lefthook runs Biome and tsc on staged files at pre-commit and TruffleHog at
pre-push once installed (`pnpm exec lefthook install`).

## Pull requests

- One concern per PR. The CLI never calls a model - keep it that way; caller
  intelligence stays outside the tool.
- New pipeline behavior needs a test that fails without it.
- Commit messages: plain imperative summary line; no agent co-author lines.
- `main` is the only branch. PRs squash-merge and the branch deletes.
