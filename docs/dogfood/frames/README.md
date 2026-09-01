# Frame-ref dogfood fixtures

Static pages for exercising the iframe graft and frame-aware refs by hand,
against a real browser. Open one, run `browser_snapshot`, then act on the refs
it hands back.

Run them from a static server (`npx serve docs/dogfood/frames`) rather than
`file://` — `cross-origin.html` needs a real origin to produce an
out-of-process frame, and the others behave the same either way.

Use an isolated instance so a dogfood session cannot touch real state:

    WMUX_DATA_SUFFIX=-frames

| Fixture | What it should show |
| --- | --- |
| `same-src.html` | Two iframes loading ONE document. Each `Submit` gets its own ref; clicking one lands in that frame only (the frame reports which slot it was). |
| `cross-origin.html` | The remote frame's contents are in the snapshot, reached over its own CDP session. |
| `nested.html` | Two levels of nesting, with depth continuing across the boundary rather than restarting. |
| `frame-navigates.html` | Click *Go elsewhere* in frame one, then replay a ref from it: stale, by name. A ref from frame two still resolves. The page URL never changes. |
| `dynamic.html` | Snapshot, add a frame, snapshot again: the new frame's controls appear and the pre-existing refs keep their numbers. |
