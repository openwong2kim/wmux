### Changed

- **`docs/browser-backends.md` now documents what each backend looks like to a
  page.** The "sites that detect automation" note said attaching CDP is what
  sets `navigator.webdriver`; measurement says otherwise — the flag comes from
  launching Chrome with `--remote-debugging-port`, and is already set before any
  client connects, so a backend that enables debugging at runtime does not carry
  it. The page now has the measured signal-by-backend table, the one-time setup
  and the real costs of Live Chrome (a banner while attached, a fixed port,
  connections after the first one left unanswered), and an explicit list of what
  was *not* measured — chiefly that nothing here says whether a sign-in would
  succeed, since every measurement stopped before credentials were entered.
