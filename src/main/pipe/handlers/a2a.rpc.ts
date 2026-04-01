import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';

type GetWindow = () => BrowserWindow | null;

export function registerA2aRpc(router: RpcRouter, getWindow: GetWindow): void {
  // A2A protocol
  router.register('a2a.whoami', (params) => sendToRenderer(getWindow, 'a2a.whoami', params));
  router.register('a2a.discover', (params) => sendToRenderer(getWindow, 'a2a.discover', params));
  router.register('a2a.task.send', (params) => sendToRenderer(getWindow, 'a2a.task.send', params));
  router.register('a2a.task.query', (params) => sendToRenderer(getWindow, 'a2a.task.query', params));
  router.register('a2a.task.update', (params) => sendToRenderer(getWindow, 'a2a.task.update', params));
  router.register('a2a.task.cancel', (params) => sendToRenderer(getWindow, 'a2a.task.cancel', params));
  router.register('a2a.broadcast', (params) => sendToRenderer(getWindow, 'a2a.broadcast', params));

  // Agent skills registration
  router.register('meta.setSkills', (params) => sendToRenderer(getWindow, 'meta.setSkills', params));
}
