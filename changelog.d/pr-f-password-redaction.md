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
  signup forms produce — came back in full, and the DOM-based snapshot path
  read every field's value directly regardless of type. All of those now
  report `[redacted:password]` instead. `browser_network` and
  `browser_response_body` mask the same way for `password`-family parameters,
  in both JSON and form-encoded bodies as well as in a URL's query string, so
  a login request that echoes what was submitted no longer hands the password
  over either.

  Only the value is hidden. The field, its label, its name, its ref and
  whether it is currently filled are all still reported exactly as before —
  an agent can find and fill a login form just as it could, and everything
  else in a captured request or response body stays readable so the network
  tools remain useful for debugging.
