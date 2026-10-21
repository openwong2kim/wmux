// "Star on GitHub" — starPrompt:checkStarred / starPrompt:star and the
// starPrompt:agentSession push. Renderer-only IPC. The renderer owns the
// prompt's persisted state (SessionData); main runs gh and counts new agent
// sessions from the hook path (notification/starPromptSessions.ts).
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import type { StarActionResult, StarredCheck } from '../../../shared/starPrompt';
import { wrapHandler } from '../wrapHandler';
import { checkStarred, starRepo } from '../../github/starRepo';
import { starPromptSessions, type StarPromptSessionCounter } from '../../notification/starPromptSessions';

export function registerStarPromptHandlers(
  getWindow: () => BrowserWindow | null,
  sessions: StarPromptSessionCounter = starPromptSessions,
): () => void {
  const off = sessions.onSession(() => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.STAR_PROMPT_AGENT_SESSION);
  });

  ipcMain.removeHandler(IPC.STAR_PROMPT_CHECK_STARRED);
  ipcMain.handle(
    IPC.STAR_PROMPT_CHECK_STARRED,
    wrapHandler(IPC.STAR_PROMPT_CHECK_STARRED, (): Promise<StarredCheck> => checkStarred()),
  );

  ipcMain.removeHandler(IPC.STAR_PROMPT_STAR);
  ipcMain.handle(
    IPC.STAR_PROMPT_STAR,
    wrapHandler(IPC.STAR_PROMPT_STAR, (): Promise<StarActionResult> => starRepo()),
  );

  // The push above only pokes; the count itself is pulled here, so a session
  // counted before the renderer subscribed is still taken on mount.
  ipcMain.removeHandler(IPC.STAR_PROMPT_DRAIN_SESSIONS);
  ipcMain.handle(
    IPC.STAR_PROMPT_DRAIN_SESSIONS,
    wrapHandler(IPC.STAR_PROMPT_DRAIN_SESSIONS, (): number => sessions.drain()),
  );

  return () => {
    off();
    ipcMain.removeHandler(IPC.STAR_PROMPT_CHECK_STARRED);
    ipcMain.removeHandler(IPC.STAR_PROMPT_STAR);
    ipcMain.removeHandler(IPC.STAR_PROMPT_DRAIN_SESSIONS);
  };
}
