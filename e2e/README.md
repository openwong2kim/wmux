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
  worker it runs the scenario's shell script in its worktree. Moa's brain is
  played by the test over the pipe RPC with a real commander token, which the
  dev-only hook in `src/main/e2eHooks.ts` mints (unpackaged build +
  `WMUX_E2E_HOOKS=1` only).
- **Local remote**: the project is cloned from a bare repository in the sandbox.
- **Artifacts**: screenshots go to `e2e/artifacts/` (override with
  `WMUX_E2E_ARTIFACTS`). Set `WMUX_E2E_SKIP_BUILD=1` to reuse a build and
  `WMUX_E2E_KEEP=1` to keep the sandbox HOME.
