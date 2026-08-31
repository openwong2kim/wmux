### Added

- `browser_click` accepts `x`/`y` for the cases a ref cannot reach (a canvas, a
  map, a custom-drawn control). Coordinates are viewport CSS pixels; passing
  both a ref and coordinates is refused, and the RPC lane — which resolves
  elements by ref only — says a chrome-backend page is required.

### Changed

- `browser_screenshot` now returns a short text part alongside the image
  stating the coordinate basis of that shot: a viewport capture names its
  devicePixelRatio so image pixels can be converted to the CSS pixels
  `browser_click` expects, while fullPage and element captures are explicitly
  marked as NOT usable for coordinate clicks. Callers that assumed an
  image-only result now see one extra text part.
