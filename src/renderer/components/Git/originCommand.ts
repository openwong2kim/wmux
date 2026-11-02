// The command that points a repo's origin at a hosted repository; the
// address is the viewer's to fill in. With no origin it is added; an origin
// that names no host (a local path) is changed, since `add` would fail.
export const GIT_ADD_ORIGIN_COMMAND = 'git remote add origin <address>';
export const GIT_SET_ORIGIN_COMMAND = 'git remote set-url origin <address>';

export function originCommand(originSet: boolean | undefined): string {
  return originSet ? GIT_SET_ORIGIN_COMMAND : GIT_ADD_ORIGIN_COMMAND;
}
