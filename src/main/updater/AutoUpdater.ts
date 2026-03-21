/**
 * AutoUpdater
 *
 * Electron 내장 autoUpdater API 기반 자동 업데이트 시스템.
 *
 * 실제 배포 환경에서는:
 *   1. electron-forge squirrel maker로 빌드
 *   2. GitHub Releases (또는 S3)에 업데이트 파일 업로드
 *   3. FEED_URL을 업데이트 서버 주소로 변경
 *
 * 개발 환경에서는 autoUpdater가 지원되지 않으므로 모두 no-op 처리.
 */

import { autoUpdater, type BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/constants';

// GitHub Releases 또는 별도 업데이트 서버 URL
// 예: https://update.winmux.app/update/win32/${version}
const FEED_URL = '';

// 업데이트 자동 확인 간격 (30분)
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export class AutoUpdater {
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private getWindow: () => BrowserWindow | null;
  private isChecking = false;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  start(): void {
    if (!FEED_URL || process.env.NODE_ENV === 'development') {
      // 업데이트 서버가 설정되지 않았거나 개발 모드 — 초기화 스킵
      this.registerIpcHandlers();
      return;
    }

    try {
      autoUpdater.setFeedURL({ url: FEED_URL });
      this.setupAutoUpdaterEvents();
      this.registerIpcHandlers();

      // 앱 시작 후 15초 뒤 첫 번째 확인 (시작 부하 방지)
      setTimeout(() => this.check(), 15_000);

      // 이후 주기적 확인
      this.checkTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    } catch (err) {
      console.warn('[AutoUpdater] Failed to initialize:', err);
    }
  }

  stop(): void {
    if (this.checkTimer !== null) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    autoUpdater.removeAllListeners();  // prevent listener accumulation
    // IPC 핸들러 정리
    ipcMain.removeHandler(IPC.UPDATE_CHECK);
    ipcMain.removeHandler(IPC.UPDATE_INSTALL);
  }

  private check(): void {
    if (this.isChecking) return;
    try {
      this.isChecking = true;
      autoUpdater.checkForUpdates();
    } catch (err) {
      console.warn('[AutoUpdater] checkForUpdates error:', err);
      this.isChecking = false;
    }
  }

  private setupAutoUpdaterEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.sendToRenderer(IPC.UPDATE_CHECK, { status: 'checking' });
    });

    autoUpdater.on('update-available', () => {
      this.isChecking = false;
      this.sendToRenderer(IPC.UPDATE_AVAILABLE, { status: 'available' });
    });

    autoUpdater.on('update-not-available', () => {
      this.isChecking = false;
      this.sendToRenderer(IPC.UPDATE_NOT_AVAILABLE, { status: 'not-available' });
    });

    autoUpdater.on('error', (err: Error) => {
      this.isChecking = false;
      console.warn('[AutoUpdater] error:', err.message);
      this.sendToRenderer(IPC.UPDATE_ERROR, { status: 'error', message: err.message });
    });

    autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
      this.sendToRenderer(IPC.UPDATE_AVAILABLE, {
        status: 'downloaded',
        releaseName,
        releaseNotes,
      });
    });
  }

  private registerIpcHandlers(): void {
    // Renderer가 수동으로 업데이트 확인 요청
    ipcMain.handle(IPC.UPDATE_CHECK, () => {
      if (!FEED_URL || process.env.NODE_ENV === 'development') {
        return { status: 'not-available' };
      }
      this.check();
      return { status: 'checking' };
    });

    // Renderer가 "지금 설치" 요청 → 앱 재시작 후 업데이트 적용
    ipcMain.handle(IPC.UPDATE_INSTALL, async () => {
      // Trigger session save via the existing beforeunload mechanism
      const win = this.getWindow();
      if (win && !win.isDestroyed() && !win.webContents.isCrashed()) {
        try {
          await win.webContents.executeJavaScript(
            `try { window.dispatchEvent(new Event('beforeunload')); } catch(e) {}`
          );
          // Small delay to let the session:save IPC round-trip complete
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log('[AutoUpdater] Session save triggered before update install');
        } catch {
          console.warn('[AutoUpdater] Could not trigger session save before update');
        }
      }

      try {
        autoUpdater.quitAndInstall();
      } catch (err) {
        console.warn('[AutoUpdater] quitAndInstall error:', err);
      }
    });
  }

  private sendToRenderer(channel: string, data: Record<string, unknown>): void {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }
}
