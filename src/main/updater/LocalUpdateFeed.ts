/**
 * LocalUpdateFeed — loopback Squirrel.Mac JSON feed for an already-verified ZIP.
 *
 * Squirrel.Mac (the installer behind Electron's built-in autoUpdater on macOS)
 * only accepts an http(s) feed URL — it does not trust `file://`. So the darwin
 * install path serves the local, SHA-256-verified update ZIP from 127.0.0.1 on
 * an ephemeral port under a random token path, exactly like electron-updater
 * does, and hands Squirrel that URL. The server lives only for the duration of
 * one install, is bound to loopback, and every route is token-scoped, so the
 * exposure window and attack surface are both minimal.
 *
 * Deliberately electron-free (pure node:http) so it is unit-testable.
 */

import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export class LocalUpdateFeed {
  private server: Server | null = null;
  private token = '';

  /**
   * Start serving `zipPath` and resolve the feed URL to hand to
   * `autoUpdater.setFeedURL({ url, serverType: 'json' })`.
   */
  async start(zipPath: string): Promise<{ feedUrl: string }> {
    if (this.server) throw new Error('LocalUpdateFeed already started');
    const size = (await stat(zipPath)).size;
    const token = randomBytes(16).toString('hex');
    this.token = token;

    const server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      const address = server.address() as AddressInfo | null;
      const port = address ? address.port : 0;

      if (path === `/${token}/feed.json`) {
        const body = JSON.stringify({ url: `http://127.0.0.1:${port}/${token}/update.zip` });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      if (path === `/${token}/update.zip`) {
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': size,
        });
        createReadStream(zipPath)
          .on('error', () => res.destroy())
          .pipe(res);
        return;
      }

      res.writeHead(404).end();
    });

    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const { port } = server.address() as AddressInfo;
    return { feedUrl: `http://127.0.0.1:${port}/${token}/feed.json` };
  }

  /** Close the server (idempotent). Safe to call from an error path. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.token = '';
    await new Promise<void>((resolve) => {
      // closeAllConnections so a Squirrel keep-alive socket can't hold the
      // process open after the install handoff.
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
}
