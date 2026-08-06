### Added

- **Paired devices, with a revoke button.** The Web popover now has a
  **Paired devices…** entry listing every device that holds a credential for
  this machine, by the name it was given at pair time, with when it was last
  seen. Each one can be revoked on its own: two clicks, permanent, and its
  live connections are cut immediately.

  Per-device credentials and the revoke that cuts them have existed inside
  the daemon since 3.34, but nothing an operator could reach ever called it.
  The only revocation available from the UI was `wmux web --stop`, which
  cuts every device at once — so a phone or laptop you no longer wanted to
  have access could not be retired without also cutting the ones you did.
  A device credential has no expiry, which made that the difference between
  "revocable in principle" and "revocable".

  The roster reads the device store rather than the running server, so it
  opens whether or not `wmux web` is up — which is the state you are in when
  you have just stopped sharing and want to know what still holds a key.
  A revoke whose roster write fails says so, rather than reporting success
  for a credential that will return on the next daemon restart.

  A failed revoke never overstates what happened. The daemon reporting a lost
  roster write says so and names whether any live connection was actually cut;
  a daemon that does not answer at all says the outcome is unknown rather than
  claiming the device was disconnected. If the roster cannot be read, the
  screen says so instead of showing an empty list, which on a credential
  surface would read as "nobody has access".

### Changed

- **`--allow-input` is now a ceiling, not the whole answer.** Typing — along
  with spawning and closing panes, toggling the permission gate, and approving
  a tool permission, which have always been one grant — is decided per device.
  The Web popover asks when you pair one, and the grant is a checkbox on its
  row afterwards, so a phone can be made read-only without being revoked.

  A server started without `--allow-input` still lets nothing type, from any
  device, exactly as before; the flag bounds the grants rather than being
  replaced by them. Devices paired before this existed keep the access they
  had — they were typing under the server flag, and an upgrade does not mute
  them. A newly paired device is read-only unless you say otherwise, because
  that is the mistake you can fix from the roster.

  `/api/config` now answers with the calling device's own grant instead of the
  server-wide flag, so a read-only phone no longer renders a composer that
  rejects every keystroke.

  Headless hosts are unaffected: `wmux web --allow-input` in a terminal has no
  popover to tick and no roster to grant from later, so the code it prints
  carries the server's own flag and pairing from a terminal works exactly as
  it did before. The per-device choice is what the GUI adds on top.
