# Contributing to wmux

Thanks for your interest in contributing to wmux! Here's how to get started.

## Getting Started

```bash
git clone https://github.com/openwong2kim/wmux.git
cd wmux
npm install
npm run start   # dev mode
npm test        # run tests
```

Requires Node.js 22+ (on Windows, avoid 24.16–24.20 and 26.0–26.7, whose libuv mishandles `fs.watch` on 8.3 short paths such as the CI runner's `%TEMP%`; 24.21.0+ and 26.8.0+ carry the fix, #984) with **npm 11** (`npm install -g npm@11` if your Node bundles npm 10 — npm 11 owns the lockfile lineage, and `npm ci` under npm 10 rejects the lock) and Windows 10/11 (ConPTY).

## Pull Requests

### One PR, One Purpose

Keep PRs focused on a single concern. Don't mix unrelated changes.

- **Security fix** → security PR only
- **New feature** → feature PR only
- **Bug fix** → bug fix PR only

If your work touches multiple areas, split it into separate PRs.

### PR Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] New code has tests
- [ ] Commit messages are clear and descriptive

### Test layout

Use `*.runtime.test.ts`, `*.runtime.test.tsx`, or `*.runtime.test.mjs` for
tests that spawn real OS resources, such as ConPTY shells or Windows process
probes. `npm test` runs these runtime tests serially after the regular parallel
suite to avoid cross-test contention.

On a pull request, CI (`.github/workflows/ci.yml`) runs `validate`: type
checks, builds (the daemon bundle included) and `npm run test:parallel`, split
into two shards, `validate (1/2)` and `validate (2/2)`. A PR needs both green;
a branch-protection rule that requires status checks lists those two.

The runtime suite (`npm run test:runtime` against a freshly built daemon
bundle) is not on the PR path: its real-Chrome and ConPTY tests are timing
sensitive and failed unrelated PRs. `.github/workflows/runtime.yml` runs it
nightly and on every push to main, and on demand for a branch
(`gh workflow run runtime.yml --ref <branch>`). Run it that way, or locally
with `npm run test:runtime`, when your change touches what it covers: the
daemon, PTY and shell integration, the browser session, the Playwright MCP.

Draft PRs do not run CI: every job skips while the PR is a draft. Mark it
ready (`gh pr ready`, or "Ready for review") to start CI, and push to a draft
freely in the meantime. On CI a failing test is retried once; a test that
passed only on retry is listed in the job summary.

### Running tests as an agent

Coding agents pay for every line of test output they read. While working,
run only the files you touched and keep the output short:

```
npm run test:agent -- src/shared/__tests__/foo.test.ts   # dots + summary
npm run test:changed                                      # files changed vs git HEAD
npm run typecheck:quiet                                   # errors + one line
```

Run the full `npm test` and `npm run typecheck` once before opening the PR.

### Commit Style

```
<type>: <short description>

fix: resolve zombie pipe cleanup on daemon restart
feat: add split pane keyboard shortcuts
security: harden filesystem bridge path resolution
refactor: extract token writer to shared module
test: add SSRF validation coverage for IPv6-mapped IPv4
docs: update CLI reference for org commands
```

## Reporting Security Issues

If you find a security vulnerability, please **do not open a public issue**. Instead, email [open.wong2kim@gmail.com] or open a draft security advisory on GitHub. We'll respond within 48 hours.

## Code Style

- TypeScript strict mode
- Vitest for testing
- No `any` unless absolutely necessary — explain why in a comment

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
