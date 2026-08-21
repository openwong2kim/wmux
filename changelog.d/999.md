### Fixed

- **A replayed pane no longer overwrites your clipboard.** Reconnecting a pane,
  resyncing it, or restoring its scrollback writes stored output back into the
  terminal — and any OSC 52 clipboard write inside those bytes was executed
  again, silently replacing whatever you had just copied with text from
  whenever that output was produced. Since the ring buffer outlives the session
  that produced it, this could resurrect a copy from days earlier, including
  one you would not want back. The clipboard bridge is now closed while
  historical bytes are parsed and open for everything live, so a copy made
  during a resync still lands.
