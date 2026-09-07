# Contributing to Terminus

Thanks for your interest in Terminus. This guide covers local setup, the checks
your change must pass, and the conventions we follow.

## Setup

Terminus is an npm-workspaces monorepo with two workspaces:

- `collector/` — the server plus the Svelte UI.
- `cli/` — the `terminus` command-line client (`@terminus/cli`).

Install everything once, from the repository root:

```bash
npm ci               # installs both workspaces from the root lockfile
npm start            # build + run the collector (alias for npm start -w collector)
npm run dev -w collector   # build the UI once, then watch UI + backend
```

You need:

- **Node.js 22** (the CI baseline; Node 20+ runs the collector and the CLI).
- **OpenSSL 3** on `PATH`, used once to generate the collector's identity
  certificate. A missing or old OpenSSL is a hard, actionable error at startup.

The Playwright browser suite needs Chromium:

```bash
npx playwright install chromium -w collector   # or: cd collector && npx playwright install chromium
```

## Gates

Every change must pass the same checks CI runs. From the repository root (each
delegates to the right workspace):

```bash
npm test             # collector (server + UI) and CLI unit tests
npm run typecheck    # tsc --noEmit over the collector and the CLI
npm run check:ui     # svelte-check over the UI (collector)
npm run lint:ui      # eslint over ui/src (collector)
npm run lint         # lint:ui plus the CLI's eslint
npm run test:browser # build dist-ui, then the Playwright end-to-end suite (collector)
```

Or run a single workspace directly, e.g. `npm test -w @terminus/cli`,
`npm run build -w @terminus/cli`, `npm run typecheck -w collector`.

## The `$effect` rule

Svelte 5 `$effect`, `$effect.pre`, `$effect.root`, and the legacy `$:` are
**forbidden** anywhere in `collector/ui/src`. Derivations use `$derived`, and side
effects live in `{@attach}` lifecycles or explicit event handlers. The rule is
enforced by ESLint (`npm run lint:ui`) and by a unit test
(`ui/src/__tests__/no-effect.test.ts`) that fails if any source reintroduces them.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/): a
`type(scope): summary` subject, where `type` is one of `feat`, `fix`, `docs`,
`test`, `refactor`, `chore`, and so on. Keep one logical change per commit. For
example:

```
fix(collector): name exported captures terminus-<ts> instead of argo-<ts>
```

## Reporting security issues

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
