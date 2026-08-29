### Fixed

- **`browser_extract_text` now strips the skip-navigation links it promised to
  remove.** Pages open with hidden-until-focused "skip to content" anchors for
  keyboard users, and they came through as the first thing in the extracted
  markdown — on naver.com eight of them pushed the first headline past
  character 440, so a caller that previews the opening few hundred characters
  read the page as empty. The leading run of in-page anchors is now dropped,
  while a table of contents and links inside the text are kept. (#1077)
