// Wiring guard for a WSL pane's transcript binding in the daemon.
//
// A WSL Claude capture names its transcript by the Linux path inside the
// distro (`wslTranscriptPath`) and carries no host `transcriptPath`. The
// transcript search looks under the Windows Claude projects root, where that
// file can never be, so such a capture must end the search exactly as a host
// path does. Whether a capture keeps its exactness for a search (#2730) is
// decided on what survives the writer checks, not on what was sent. A
// provisional spool record must not displace a binding that names either path.
//
// Source-shape assertions, as in agentProcessExitWiring.test.ts:
// applyResumeBinding and the spool ingest live inside `startDaemon`, which
// cannot be constructed in a unit test. The predicate itself is covered in
// agentResume.test.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('WSL transcript wiring in the daemon', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8').replace(/\r\n/g, '\n');

  function applyBody(): string {
    const start = src.indexOf('const applyResumeBinding = (');
    if (start < 0) throw new Error('applyResumeBinding not found');
    const end = src.indexOf('\n  };', start);
    return src.slice(start, end > 0 ? end : src.length);
  }

  it('ends the transcript search for any authoritative transcript, host or WSL', () => {
    const body = applyBody();
    const cancel = body.indexOf('transcriptDiscovery?.cancel(id);');
    const guard = body.lastIndexOf('} else if (hasAuthoritativeTranscript(p.resumeBinding)) {', cancel);
    expect(guard).toBeGreaterThan(-1);
    // The search starts only after that branch, for a capture with neither path.
    expect(body.indexOf('transcriptDiscovery?.start(')).toBeGreaterThan(cancel);
    expect(body).not.toMatch(/else if \(p\.resumeBinding\.transcriptPath\)/);
  });

  it('keeps a WSL path only for the pane\'s own recorded target (and its bound account\'s home)', () => {
    expect(applyBody()).toMatch(/keepOwnWslTranscriptPath\(vetted, managed\.meta\.wslTarget, managed\.meta\.env\)/);
  });

  it('decides the search exactness on the vetted binding, after both writer checks', () => {
    const body = applyBody();
    const exact = body.indexOf('if (hasAuthoritativeTranscript(vetted)) discoveryPaneExact.delete(id);');
    expect(exact).toBeGreaterThan(-1);
    expect(exact).toBeGreaterThan(body.indexOf('checkNativeTranscriptPath(vetted.agent'));
    expect(exact).toBeGreaterThan(body.indexOf('keepOwnWslTranscriptPath(vetted'));
    expect(body).not.toMatch(/hasAuthoritativeTranscript\(resumeBinding\)/);
  });

  it('holds a binding naming either path against a provisional spool record', () => {
    expect(src).toMatch(/\|\| \(hasAuthoritativeTranscript\(prev\) && !hasAuthoritativeTranscript\(binding\)\)\)\) \{ drop\(\); continue; \}/);
    expect(src).not.toMatch(/prev\.transcriptPath && !binding\.transcriptPath/);
  });
});
