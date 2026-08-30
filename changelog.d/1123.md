### Fixed

- **Live Chrome could not be attached to at all, and would not say why.** Chrome
  asks permission for every connection to its remote-debugging endpoint and
  holds the WebSocket handshake open until you answer — but the handshake shared
  the 10-second CDP request timeout, so wmux hung up while the prompt was still
  on screen. No amount of clicking was fast enough. The first handshake now gets
  its own budget (3 minutes), separate from the per-request timeout, and logs
  that it is waiting once it passes 5 seconds.
- **Every way of failing to reach Live Chrome produced the same message.** A
  pending permission prompt, a Chrome that is not running, and an endpoint that
  refused the connection were reported identically, so the one failure you can
  fix in two seconds read like a broken setup. The three now say what actually
  happened and what to do: click Allow, enable remote debugging at
  `chrome://inspect`, or retry because the endpoint moved.
- **`browser.session.start` overstated what "remote debugging is reachable"
  means.** The probe behind it is a bare TCP connect — deliberately, so a status
  call never raises Chrome's consent prompt — which proves something is
  listening and nothing more. It claimed the browser would attach on the first
  drive; it now says the attach will be *attempted* and that Chrome will ask
  permission first.
