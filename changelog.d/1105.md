### Fixed

- `browser_session_status` on the **live** profile now reports whether your
  Chrome's remote-debugging endpoint is actually reachable, instead of a
  meaningless "did wmux create an attach object yet" flag. `running:false`
  there means "enable remote debugging at chrome://inspect" (surfaced as
  `liveAttach:true`), not "call `browser_session_start`" — so diagnosing a
  live-bound workspace no longer gets a value that tells you nothing.
- `browser_session_start` no longer returns a success-looking Electron session
  on the `chrome`, `live`, and `external` backends, where nothing consumes it.
  It now answers honestly with `started:false` and a one-line reason for how
  the browser actually attaches (dedicated Chrome launches on demand; live
  attaches on first drive once remote debugging is on; external hands URLs to
  the OS browser) — instead of misleading an agent into thinking a session had
  started.
