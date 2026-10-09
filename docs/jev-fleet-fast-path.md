# Experimental Jev Fleet fast path

This optional desktop-composer route classifies a small allowlist of read-only
Fleet questions and renders the answer from the existing local Fleet selector.
It is off on every app start. Phone messages keep their existing Moa route.

## Enablement and privacy

Settings → Moa → Experimental Jev Fleet answers exposes a session-only password
field and a separate opt-in switch. Entering a key does not enable queries.
Clearing it disables the feature. Neither the key nor consent is persisted.
There is no environment-variable, configuration-file, or credential discovery.
Only the operator-facing Electron preload exposes configuration; no MCP or
worker RPC is added. The configuration channel never logs its arguments.

Only a recognized short question is transmitted to TypeSafe. Fleet rows,
workspace names, terminal output, source code, history and the renderer's
fleetContext are never included in the request. The fixed endpoint rejects
redirects and pins jev-1.13.0. A production account's provider terms and data
handling still apply; this feature does not claim zero retention.

## Routing and lifecycle

- The whole-message deterministic allowlist accepts needs-you, finished-turn
  and general-status questions in a bounded set of English/Korean forms.
- Mixed actions, names, dates, quoted instructions and unfamiliar phrasing use
  the original Moa route without sending anything to Jev.
- Jev can veto a deterministic candidate. It cannot expand it or authorize an
  action. Strict schema, model and probability validation also fail closed.
- A 1.2-second total deadline includes provider and local board lookup. There
  are no retries. Errors, timeout, malformed/uncertain output, disagreement or
  stale/invalid local state fall back to the original Moa path.
- The manager reserves the turn before any await. Stop/dispose discards late
  results. Foreign terminal input blocks local completion/fallback. Local-only
  turns preserve provider turnOrigin and do not alter handoff authority.
- Local success does not start a provider session, change tracked work, consume
  a decision or add a prompt to Claude's transcript-rewrite history. Local
  exchanges remain in session UI state and merge into Moa chat without sorting
  or rewriting its authoritative transcript.
- Answers report Fleet state. A finished turn is not proof that the task,
  tests, PR or deployment succeeded. Omitted rows remain disclosed.

The telemetry test seam reports only schema/model, input hash, candidate,
route/fallback reason, latency and optional provider token count. It does not
persist logs or include raw questions, board content, responses, errors or keys.

## Evaluation status

Mock fixtures compare the existing always-Moa route, the deterministic
candidate baseline and the Jev-plus-fallback path. Since Jev only confirms the
same allowlisted candidates here, this slice demonstrates bounded integration,
not superior classification, measured Moa savings or calibrated accuracy.
No live provider call is required to run the tests or the harness.

See scripts/fixtures/jev-ui-e2e/README.md for the dummy-only loopback harness.
Its server-check is integration testing, not browser or native Electron E2E.
Use a sandbox-capable graphical environment for actual rendered/native checks.
Do not disable security controls to make a failing browser launch pass.

Official API contract: https://docs.typesafe.ai/api
Model pin: https://docs.typesafe.ai/models
Confidence limitations: https://docs.typesafe.ai/confidence
