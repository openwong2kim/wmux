### Fixed

- **`browser_file_upload` no longer refuses files over 50MB.** Playwright treats
  a browser reached over CDP as "not co-located" with the client and ships the
  file's *contents* down the protocol, refusing anything past 50MB — which made
  the tool useless for the job it exists for, since a 40-second 720p clip is
  already 39MB. wmux only ever attaches to a browser on the same machine, so the
  browser can just open the file: uploads now pass the path via CDP
  `DOM.setFileInputFiles` and nothing else crosses the wire. Measured against a
  real page: 700MB uploaded in 4.3s (it was refused outright before), and the
  time no longer grows with the file. The upload sandbox is unchanged — paths
  still have to resolve under the uploads root, symlinks and all — and it now
  refuses, rather than quietly falling back to a weaker check, when a path
  exists but its real location cannot be resolved at all.
- **An upload that timed out could actually have succeeded.** Copying a 45MB
  file took longer than Playwright's 30-second default, so the tool reported
  `Timeout 30000ms exceeded` while the page had already received all 47,185,920
  bytes. On a real uploader an agent reading that retries — and a retry is a
  second upload. The by-path route removes the wait entirely; the remaining
  `ref` path now gets an explicit, generous timeout, and a timeout message says
  outright that the file may have landed anyway and that a blind retry can post
  the same file twice.
- **The upload success message named the wrong directory.** It always said
  `~/.wmux/uploads/`, even on an instance whose real root carries a suffix. It
  now names the root the file actually came from, which is what the rejection
  message already did.

### Added

- **`browser_file_upload` takes a `selector`.** Uploads used to go to whichever
  file input happened to be first in the DOM, with no way to aim at another —
  a silent wrong-target on any page with more than one. Passing a selector picks
  the input, and a selector that matches nothing says so by name instead of
  falling back to the first one.
- **A file whose name starts with dots was refused forever.** The root check
  compared the leading characters rather than the leading path segment, so a
  perfectly ordinary `..dots.mp4` sitting inside the uploads directory looked
  like an escape attempt.
- **A rejected upload could be told its file might have arrived.** The
  "this may have succeeded, do not blindly retry" note was attached by scanning
  the error text for "timeout", and rejection messages quote the path you
  passed — so a file under a directory called `.wmux-timeout` was refused and
  then advised to check whether it had uploaded. The note is now raised by the
  transfer itself, which is the only step that can be ambiguous.
- **`timeout: 0` disabled the upload backstop.** Playwright reads zero as "wait
  forever", so the value meant to bound a wedged renderer removed the bound
  instead. The parameter now has to be a positive whole number.
- **Upload results named the wrong directory, or too much of it.** The success
  message hardcoded `~/.wmux/uploads/`, which is the wrong path on any instance
  with a data suffix; naming the resolved absolute path instead would have put
  the account name into every upload result. Both messages now say
  `~/.wmux-<suffix>/uploads` — the real directory, without spelling out the
  home layout.
