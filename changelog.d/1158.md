### Fixed

- `browser_replay` works in a packaged build. Every one of its actions — `list` included — was refused as "plugin is unconfirmed" for Claude Code, because the eight `browser.actionCache.*` methods behind it were never added to the first-party allowlist. Dev builds do not enforce that lane, so the tool looked healthy everywhere it was tested and was dead everywhere it shipped. `browser.lifecycle.get` was missing the same way, which silently stopped navigation events from being reported on the builtin backend.

- The allowlist's source-invariant guard now sees RPCs sent through `sendScopedBrowserRpc`, not just `callRpc`/`sendRpc`. It was the guard's blind spot that let both methods above ship unlisted.
