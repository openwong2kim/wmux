### Fixed

- **`browser_click` with a `smartRef` is no longer refused as "inside a
  frame".** On a surface without a live Chrome page, a number from
  `browser_smart_snapshot` that happened to equal a frame element's ref from
  `browser_snapshot` was turned away. A `smartRef` is now always clicked in
  the page itself.
