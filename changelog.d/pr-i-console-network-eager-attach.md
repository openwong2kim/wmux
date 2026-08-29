### Fixed

- **`browser_console` and `browser_network` no longer start collecting at the
  moment you ask them.** The listeners used to attach on the first call, so
  everything the page said before that — every load-time error, every uncaught
  exception, every failed request — was never recorded and could not be
  recovered. Since an agent only reaches for the console *after* something
  looked wrong, that was reliably the one window the tools could not see, and
  the empty result was indistinguishable from a clean page: an agent could
  truthfully report "no console errors" about a page that threw on load.
  Collection now begins when the page is first opened, navigated or attached,
  so `browser_navigate` followed straight by `browser_console` shows what the
  page logged while loading. The same fix covers `browser_network`: the request
  that failed is in the listing without a priming call first.

  Both buffers stay bounded — 1000 entries each, oldest dropped first, with a
  cap on the size of a single console line, a single URL, and the total
  response-body payload retained per page — so a page left open cannot grow
  them without limit.

- **An empty console or network result now says which kind of empty it is.**
  Instead of a bare "No console messages collected.", the result reports when
  collection started, and says so explicitly when the page was already open at
  that moment and messages from before then are not included — the case a late
  attach to an already-running tab cannot avoid. The tool descriptions now
  state when collection begins, which was previously undocumented.

- **A development build and a packaged build answer these tools identically.**
  Console and network reads for a built-in browser pane now come from the same
  capture in both, which is enabled when the pane's guest attaches; previously
  a development build read a separate buffer that only started at the first
  call. `clear:true`, the `filter` glob and the password masking all behave
  exactly as before, and clearing one buffer no longer resets the other's
  reported collection window.
