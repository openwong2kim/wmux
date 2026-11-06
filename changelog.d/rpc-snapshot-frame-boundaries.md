### Changed

- **A browser snapshot without a Playwright page lists the page's frames.**
  Each frame becomes one line with its role, name and location (scheme, host
  and path only), marked as a separate document whose contents are not in the
  snapshot. Before, the listing gave no sign that a frame was there. At most
  50 frames are listed, and a final line counts the rest.
