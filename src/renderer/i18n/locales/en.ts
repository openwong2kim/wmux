export const en = {
  // Sidebar
  'sidebar.workspaces': 'Workspaces',
  'sidebar.newWorkspace': 'New workspace',

  // Pane
  'pane.empty': 'Empty pane',
  'pane.splitRight': 'Split right',
  'pane.splitDown': 'Split down',

  // Notification
  'notification.title': 'Notifications',
  'notification.markAllRead': 'Mark all read',
  'notification.clear': 'Clear',
  'notification.empty': 'No notifications',
  'notification.toggle': 'Ctrl+I to toggle',

  // Command palette
  'palette.placeholder': 'Type a command...',
  'palette.noResults': 'No results for',
  'palette.navigate': 'navigate',
  'palette.select': 'select',
  'palette.close': 'close',
  'palette.cmd.toggleSidebar': 'Toggle Sidebar',
  'palette.cmd.newWorkspace': 'New Workspace',
  'palette.cmd.newSurface': 'New Surface',
  'palette.cmd.splitRight': 'Split Right',
  'palette.cmd.splitDown': 'Split Down',
  'palette.cmd.showNotifications': 'Show Notifications',
  'palette.cmd.openSettings': 'Open Settings',

  // Terminal
  'terminal.exited': 'Process exited with code {code}',

  // Browser
  'browser.urlPlaceholder': 'Enter URL...',
  'browser.back': 'Back',
  'browser.forward': 'Forward',
  'browser.reload': 'Reload',
  'browser.close': 'Close',

  // VI copy mode
  'viCopy.mode': 'COPY MODE',

  // Settings
  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.sound': 'Notification Sound',
  'settings.soundOn': 'On',
  'settings.soundOff': 'Off',
  'settings.checkUpdate': 'Check for updates',
  'settings.checking': 'Checking...',
  'settings.upToDate': 'Up to date',
  'settings.updateAvailable': 'Update available',
  'settings.close': 'Close',
  'settings.shortcuts': 'Keyboard Shortcuts',
} as const;

export type TranslationKey = keyof typeof en;
