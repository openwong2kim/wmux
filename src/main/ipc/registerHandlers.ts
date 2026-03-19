import type { BrowserWindow } from 'electron';
import { PTYManager } from '../pty/PTYManager';
import { PTYBridge } from '../pty/PTYBridge';
import { registerPTYHandlers } from './handlers/pty.handler';
import { registerSessionHandlers } from './handlers/session.handler';
import { registerShellHandlers } from './handlers/shell.handler';
import { registerMetadataHandlers } from './handlers/metadata.handler';
import { registerClipboardHandlers } from './handlers/clipboard.handler';

export function registerAllHandlers(
  ptyManager: PTYManager,
  ptyBridge: PTYBridge,
  getWindow: () => BrowserWindow | null,
): () => void {
  registerPTYHandlers(ptyManager, ptyBridge);
  registerSessionHandlers();
  registerShellHandlers();
  const cleanupMetadata = registerMetadataHandlers(ptyManager, getWindow);
  registerClipboardHandlers();

  return () => {
    cleanupMetadata();
  };
}
