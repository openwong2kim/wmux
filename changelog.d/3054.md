### Fixed

- **Phone browser previews hold page URLs to 4096 characters.** A capture
  leaves out the page's URL when it is longer than that, together with the
  tap geometry that goes with it, and returns the image as before. The page
  list leaves out a page whose URL is longer than that, as it already leaves
  out pages that are not http(s). Before, a page whose URL had grown that
  long (a single-page app keeping its state in the address, say) could make
  the preview fail, the list included. (#PENDING)
