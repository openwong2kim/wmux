// A daemon security notice: a paired phone started an agent with permission
// prompts or the sandbox off (daemon `source: 'security'` events). Main records
// each one (main/notification/securityNotices.ts) outside the renderer's
// notification policy, so focus, a muted workspace or category and the toast
// setting cannot hide it, and keeps it until the user acknowledges it. The OS
// toast is still shown where toasts exist.
//
// The renderer asks for the pending notices once with `list`, hears each new
// one on `added`, and sends `acknowledge` with a notice's id ("Got it" or
// "Go to pane"); main then forgets it.

export interface SecurityNotice {
  id: string;
  title: string;
  body: string;
  /** The pane it is about, when the daemon named one. */
  ptyId: string | null;
  /** When main recorded it (ms since the epoch). */
  timestamp: number;
}

export const SECURITY_NOTICE_IPC = {
  list: 'security-notice:list',
  added: 'security-notice:added',
  acknowledge: 'security-notice:acknowledge',
} as const;
