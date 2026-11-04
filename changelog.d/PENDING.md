### Fixed

- **A phone preview of a page with a very long URL still shows the page.** A
  capture now leaves out the page's URL when it is longer than 4096
  characters, together with the tap geometry that goes with it, and returns
  the image as before. Before, a page whose URL had grown that long (a
  single-page app keeping its state in the address, say) could fail to
  preview at all. (#PENDING)
