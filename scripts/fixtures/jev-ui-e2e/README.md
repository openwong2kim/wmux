# Jev scoped browser harness

This uses the production Jev settings component, style tokens, JevFleetFastPath
and CommanderSessionManager. The bridge is localhost HTTP instead of Electron
IPC; the ordinary brain, Fleet board and provider fetch are synthetic. It is
component/browser integration QA, not native Electron or live-provider E2E.
Only the hardcoded dummy key is accepted. No existing key is read or saved.

From the repository root:

- `node scripts/jev-ui-e2e.mjs --build-only`: bundle the actual component and
  backend fixtures, then remove temporary outputs.
- `node scripts/jev-ui-e2e.mjs --server-check`: exercise the loopback bridge,
  default-off, key-only still-off, explicit opt-in, local answer, transport
  error, timeout, malformed response, mixed question, stale board and clear.
- `node scripts/jev-ui-e2e.mjs --serve`: serve the real settings and synthetic
  send controls on the printed loopback URL. Stop with Ctrl+C. Intended for a
  separately authorized browser; no tunnel or public host is created.
- `node scripts/jev-ui-e2e.mjs`: additionally run headless Chromium assertions
  for the real UI, cancel and repeat-submit, then save `/tmp/jev-ui-e2e.png`.
  Requires Playwright Core and `/usr/bin/chromium`. The Chromium sandbox stays
  enabled. Do not bypass a launch permission denial.

Temporary bundles, fonts and session data are removed on normal exit or when
the serving process receives SIGINT/SIGTERM. The browser mode keeps only its
final screenshot, after the dummy key has been cleared.

Initial Chromium feasibility on this cloud executor was blocked with:
`chrome/browser/process_singleton_posix.cc:297: socket() failed: Operation not
permitted (1)`, followed by SIGABRT. No retry with weakened security was made.
That failed launch is not browser test evidence and produced no screenshot.
