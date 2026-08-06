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
