# Electron e2e

`npm run test:e2e` builds the app (`build:daemon`, `build:mcp`, then
`e2e/build.mjs`, which runs forge's own Vite config generator without
packaging) and runs `e2e/*.e2e.test.mjs` with node's test runner. On Linux
without a display it wraps the run in `xvfb-run`. It is not part of `npm test`
or vitest.

- **Isolated**: each run gets a fresh `HOME` under the temp dir and
  `WMUX_DATA_SUFFIX=-e2e`, so it never touches a real wmux, and it kills its
  own app, daemon and ptys afterwards (matched by `WMUX_E2E_RUN` / `HOME`).
- **No model**: `e2e/fake-bin/claude` stands in for Claude Code. As a fan-out
  worker it runs the scenario's shell script in its worktree.
- **Local remote**: the project is cloned from a bare repository in the sandbox.
- **Artifacts**: screenshots go to `e2e/artifacts/` (override with
  `WMUX_E2E_ARTIFACTS`). Set `WMUX_E2E_SKIP_BUILD=1` to reuse a build and
  `WMUX_E2E_KEEP=1` to keep the sandbox HOME.
- **macOS**: the sandbox lives under `/tmp` (the per-user temp dir is too long
  for the daemon's Unix sockets), Electron's userData is pointed into the
  sandbox with `--user-data-dir`, cleanup reads `ps -E` where there is no
  `/proc`, and the app runs with `--use-mock-keychain`: the sandbox HOME has no
  login keychain, so the first safeStorage call would block the app's main
  thread on a keychain dialog (forever on a locked screen).

## Scenarios

- `fanout-cost.e2e.test.mjs` — the fan-out cost baseline (PRD E0 R0-2). An
  ordinary agent pane fans out three tasks and follows them to
  `review_requested`. `fanout-parent.mjs` plays that parent inside the pane
  through the real MCP bundle (`mcpClient.mjs`), and `fanout-worker.mjs`
  reports for each fake worker. It prints MCP calls, characters received
  (total and worker-written) and nudges, and saves them to
  `e2e/artifacts/fanout-cost.json`. The parent does only what the product
  tells it to, so the counts are lower bounds for a real agent. After one
  build, `node --test e2e/fanout-cost.e2e.test.mjs` runs it alone.
