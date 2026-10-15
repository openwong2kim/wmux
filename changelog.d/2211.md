### Added

- **A protected pane shows the sites it recently blocked, with an Allow for each.**
  In "Only these sites" mode a page that needs a host you did not list (sign-in,
  a CDN, an API) used to fail with Chrome's generic connection error and no hint
  why. Browser protection now lists the hosts the pane's Chrome was refused since
  it started or the protection last changed, and Allow adds one to that pane's
  allowed sites at once. The list is the operator's alone: agents still get
  `policy_denied` and cannot read it or allow hosts. (#2063)
