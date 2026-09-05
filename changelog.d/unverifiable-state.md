### Changed

- **An agent that has said nothing for 30 minutes now says so.** A pane whose
  status is still `running` but which has reported nothing — no hook, no
  activity, no output — for half an hour draws a hollow amber ring in place of
  its filled dot, and its tooltip reads "No update for 34m". Before, the same
  pane either kept a confident, breathing amber dot for as long as the window
  stayed open, or quietly slid to idle as if the work had finished. The ring
  appears on the sidebar row, the collapsed rail, the sidebar agent roster and
  the deck Fleet roster. It is a rendition, not a new status: the roll-up, the
  needs-you ordering and the "N need you" chip are unaffected, any agent that
  wants you still shows red and sorts above, and a pane whose shell is back at
  its prompt or whose agent process has exited is idle as before.
