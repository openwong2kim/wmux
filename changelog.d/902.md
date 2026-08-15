### Fixed

- **Long-running CJK and TUI panes no longer paint the wrong glyphs
  (or go black) until you drag a split.** Same-font terminals share one
  WebGL glyph atlas; when that atlas filled, sibling panes kept texture
  coordinates into pages that had been merged or failed to clear. The
  atlas now wipes completely, never allocates a page the shader cannot
  sample, and every pane rebuilds after a wipe. The existing safety net
  still runs; it should almost never have to fire.
