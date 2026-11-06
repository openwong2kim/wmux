### Added

- **Browser snapshots on the RPC lane read in-process frames.** After the
  page's own listing, `browser_snapshot` lists the contents of each frame
  that runs in the page's process (up to 20 per snapshot), each under a line
  naming the frame and its origin. The page's own listing always comes first
  and is never shortened; frames share 40% of the snapshot budget and say
  where they were cut. Refs inside a frame work with `browser_click`,
  `browser_type` and `browser_fill`, which check that the click lands on the
  element before pressing; other tools say the ref is inside a frame. A frame
  in another process is still listed as a boundary line.
