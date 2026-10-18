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

The regular suite (everything but the runtime suites below) has two lanes,
run as two vitest projects. A test file that spawns a process (git, node,
PowerShell), opens a socket or pipe, runs such code in a real temp dir, or
mentions `win32` at all is in `integration`, which runs fewer files at once
with 30-second timeouts, on Windows in CI; every other file is in `unit`,
which CI runs on Linux (a nightly workflow, `windows.yml`, still runs both
lanes on Windows, and on every push to main). `scripts/test-lanes.mjs` decides from each
file's source and writes the integration list to `vitest.lanes.json`. After
adding or renaming such a test, run `node scripts/test-lanes.mjs --write` (a
guard test fails until you do). To override the rule for one file, put
`// @wmux-lane unit` or `// @wmux-lane integration` in it. `npm run
test:parallel` runs both lanes, `npm run test:unit` and `npm run
test:integration` one each. CI runs the unit lane in `validate (1/2)` and
`validate (2/2)` (Linux) and the integration lane in jobs of its own,
`integration (1/2)` and `integration (2/2)` (Windows).

Use `*.runtime.test.ts`, `*.runtime.test.tsx`, or `*.runtime.test.mjs` for
tests that spawn real OS resources, such as ConPTY shells or Windows process
probes. `npm test` runs these runtime tests serially after the regular parallel
suite to avoid cross-test contention.

On a pull request, CI (`.github/workflows/ci.yml`) runs parallel jobs:
`checks` (type checks, builds with the daemon bundle included, lint and the
lockfile guard, on Linux since none of it depends on the OS), `validate` (the
unit lane split into two shards, `validate (1/2)` and `validate (2/2)`, on
Linux) and `integration` (the integration lane, two shards, on Windows). A PR
needs all five green; a branch-protection rule that requires status checks
lists those five.

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
