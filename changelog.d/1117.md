### Removed

- **Dropped an unwired `applyAntiDetection()` that would have forged
  `navigator.webdriver`.** Nothing had ever called it — not once in the repo's
  history — but leaving it in place implied wmux had an answer to bot detection
  that it does not have, and pointed the next reader away from the one it does.
  The rule it violated is now the design constraint: a person logs in, and
  automation only ever runs after that. wmux does not type credentials into a
  page and does not forge automation signals to get past a site's login
  protections. Where a service has an API, the agent authenticates through OAuth
  — the user consents once in their real browser, so the password never reaches
  the automation; where it does not, the agent drives a session the user has
  already signed into, through the `live` Chrome backend's per-connection
  consent flow. The file it lived in is now named `user-gesture.ts`, after the
  helper that is actually used.
