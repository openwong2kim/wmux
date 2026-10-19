import { it, expect, vi } from 'vitest';
import net from 'node:net';
import crypto from 'node:crypto';
import { SessionPipe } from '../SessionPipe';
import { RingBuffer } from '../RingBuffer';
import { waitFor } from '../../test-utils/waitFor';

it('retains a rejected input chunk and resumes the socket after a successful retry', async () => {
  const pipe = new SessionPipe(`input-${crypto.randomUUID().slice(0, 8)}`, new RingBuffer(1024), 'token');
  if (process.platform !== 'win32') vi.spyOn(pipe, 'getPipeName').mockReturnValue(`/tmp/wmux-in-${crypto.randomUUID().slice(0, 8)}.sock`);
  let full = true, attempts = 0; const accepted: Buffer[] = [];
  pipe.onInput(data => { attempts++; if (full) return false; accepted.push(Buffer.from(data)); });
  await pipe.start();
  const socket = net.connect(pipe.getPipeName()); socket.on('error', () => { /* Teardown may close the peer first. */ }); socket.resume();
  try {
    socket.write('token\n한글-first');
    await waitFor(() => attempts === 1, 3000);
    socket.write('-second');
    pipe.setInputPaused(false);
    expect(accepted).toHaveLength(0);
    full = false; pipe.setInputPaused(false);
    await waitFor(() => Buffer.concat(accepted).toString() === '한글-first-second', 3000);
    expect(Buffer.concat(accepted).toString()).toBe('한글-first-second');
  } finally { socket.destroy(); await pipe.stop(); }
});
