// IPC channels of the global quick launch. Import-free on purpose: the
// composer's sandboxed preload bundles this file and may load nothing else.
export const QUICK_LAUNCH_IPC = {
  SETTINGS_GET: 'quick-launch:settings-get',
  SETTINGS_SET: 'quick-launch:settings-set',
  CONTEXT: 'quick-launch:context',
  SUBMIT: 'quick-launch:submit',
  DISMISS: 'quick-launch:dismiss',
  FIT: 'quick-launch:fit',
  SHOWN: 'quick-launch:shown',
} as const;
