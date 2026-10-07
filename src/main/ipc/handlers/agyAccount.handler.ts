// ─── agy accounts — renderer → main IPC ──────────────────────────────────────
//
// Renderer-only trust boundary (ipcMain.handle). Main owns agy-accounts.json and
// the credential vault; the renderer gets snapshots (emails, labels, quota
// fractions — never a credential) and asks for mutations by account id.

import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { AgyAccountError, getAgyAccountService } from '../../account/AgyAccountService';
import type { AgyAccountsSnapshot } from '../../../shared/agyAccounts';
import os from 'node:os';
import { refreshInstalledAgyQuotaSink } from '../../quota/installAgyQuotaSensor';

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function assertId(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 64 || UNSAFE_KEYS.has(v)) throw new AgyAccountError('invalid', 'invalid id');
  return v;
}

function optionalLabel(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function registerAgyAccountHandlers(getWindow: () => BrowserWindow | null): () => void {
  const channels = [
    IPC.AGY_ACCOUNT_LIST,
    IPC.AGY_ACCOUNT_ADD_CURRENT,
    IPC.AGY_ACCOUNT_LOGIN_BEGIN,
    IPC.AGY_ACCOUNT_LOGIN_CANCEL,
    IPC.AGY_ACCOUNT_ACTIVATE,
    IPC.AGY_ACCOUNT_RENAME,
    IPC.AGY_ACCOUNT_REMOVE,
    IPC.AGY_ACCOUNT_SET_AUTO_ROTATE,
  ];
  for (const c of channels) ipcMain.removeHandler(c);
  const service = getAgyAccountService();
  // Per-account quota needs the current sink; refresh an installed copy.
  try {
    if (refreshInstalledAgyQuotaSink(os.homedir()) === 'updated') console.log('[agy-accounts] refreshed the installed agy quota sink');
  } catch { /* best-effort */ }

  const unsubscribe = service.onChange(() => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.AGY_ACCOUNT_CHANGED);
  });

  const list = (): AgyAccountsSnapshot & { login: ReturnType<typeof service.loginState> } => ({
    ...service.snapshot(),
    login: service.loginState(),
  });

  ipcMain.handle(IPC.AGY_ACCOUNT_LIST, wrapHandler(IPC.AGY_ACCOUNT_LIST, async () => list()));
  ipcMain.handle(IPC.AGY_ACCOUNT_ADD_CURRENT, wrapHandler(IPC.AGY_ACCOUNT_ADD_CURRENT,
    async (_e, args: { label?: unknown }) => service.addCurrent(optionalLabel(args?.label))));
  ipcMain.handle(IPC.AGY_ACCOUNT_LOGIN_BEGIN, wrapHandler(IPC.AGY_ACCOUNT_LOGIN_BEGIN,
    async () => service.beginLogin()));
  ipcMain.handle(IPC.AGY_ACCOUNT_LOGIN_CANCEL, wrapHandler(IPC.AGY_ACCOUNT_LOGIN_CANCEL, async () => {
    await service.cancelLogin();
    return { ok: true };
  }));
  ipcMain.handle(IPC.AGY_ACCOUNT_ACTIVATE, wrapHandler(IPC.AGY_ACCOUNT_ACTIVATE, async (_e, args: { id?: unknown }) => {
    await service.activate(assertId(args?.id));
    return { ok: true };
  }));
  ipcMain.handle(IPC.AGY_ACCOUNT_RENAME, wrapHandler(IPC.AGY_ACCOUNT_RENAME,
    async (_e, args: { id?: unknown; label?: unknown }) => {
      await service.rename(assertId(args?.id), optionalLabel(args?.label));
      return { ok: true };
    }));
  ipcMain.handle(IPC.AGY_ACCOUNT_REMOVE, wrapHandler(IPC.AGY_ACCOUNT_REMOVE, async (_e, args: { id?: unknown }) => {
    await service.remove(assertId(args?.id));
    return { ok: true };
  }));
  ipcMain.handle(IPC.AGY_ACCOUNT_SET_AUTO_ROTATE, wrapHandler(IPC.AGY_ACCOUNT_SET_AUTO_ROTATE,
    async (_e, args: { on?: unknown }) => {
      await service.setAutoRotate(args?.on === true);
      return { ok: true };
    }));

  return () => {
    unsubscribe();
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
