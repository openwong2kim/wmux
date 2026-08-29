### Changed

- **Password values no longer reach the agent through the browser tools.**
  When an agent works on a page with a login form, the password in that form
  used to travel back to the model in several places: `browser_snapshot` and
  `browser_smart_snapshot` reported the field's contents, and `browser_type`
  echoed the text it had just typed straight back into the tool result — which
  put the credential in the transcript, and in the logs, a second time. Chrome
  masks `<input type="password">` in the accessibility tree, but that is the
  only shape it covers: a plain-text field marked
  `autocomplete="new-password"` — what a "show password" toggle and most
  signup forms produce — came back in full, a field inside a shadow root was
  missed entirely, and the DOM-based snapshot path read every field's value
  directly regardless of type. All of those now report `[redacted:password]`
  instead.

- **Credentials are masked wherever a tool prints a URL, a body, or a log
  line.** `browser_network`, `browser_response_body` and `browser_console`
  mask `password`-family parameters in JSON and form-encoded payloads, so a
  login request that echoes what was submitted — or a page that logs its own
  payload — no longer hands the password over. The same masking covers every
  URL a tool renders: `browser_navigate`, `browser_navigate_back`, the
  `browser_tabs` listing, the browser-events block and the DOM snapshot
  listing. Both shapes a credential takes in a URL are handled — a `password=`
  query parameter, and `scheme://user:password@host` basic-auth userinfo where
  only the password half is replaced.

  Only the value is hidden. The field, its label, its name, its ref and
  whether it is currently filled are all still reported exactly as before —
  an agent can find and fill a login form just as it could — and everything
  else in a URL, a captured body or a console line stays readable, so the
  network and console tools remain useful for debugging. The username in a
  login payload, and the account in a userinfo URL, are deliberately left
  intact: which account a request used is exactly what those tools exist to
  show.
