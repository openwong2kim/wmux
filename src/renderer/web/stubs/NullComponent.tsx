/**
 * Browser-build stand-in (vite.web.config.ts) for a desktop-only component:
 * account and Chrome-profile menus, the preset picker, company and plugin
 * panels, the add-remote-pane modal, and surface panels (browser webview,
 * editor, diff, remote pane) the browser never mounts because hydration turns
 * those tabs into placeholders. Renders nothing and reaches nothing.
 */
export default function NullComponent(): null {
  return null;
}
