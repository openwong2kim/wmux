// #910 verification probe: does the mouse-mode DECSET round trip survive?
// The root cause of #910 is that the pre-22000 in-box ConPTY swallows the
// mouse DECSETs a TUI writes, so the terminal never sees mouse tracking turn
// on. A pty echo round trip measures the relay directly — no physical mouse
// needed. Run on the windows-2022 runner (build 20348, gate-firing build).
// Scratch-branch only; delete with the verify workflow after #910 verifies.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require('node-pty');

// What vim/tmux write when enabling mouse tracking (set mouse=a, ttymouse=sgr)
const DECSETS = ['1000h', '1002h', '1006h'];

function probe(label, opts) {
  return new Promise((resolve) => {
    const p = pty.spawn('powershell.exe', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      ...opts,
    });
    let out = '';
    p.onData((d) => {
      out += d;
    });
    const finish = () => {
      const relayed = DECSETS.every((s) => out.includes(`\x1b[?${s}`));
      console.log(`${label} relayed=${relayed}`);
      resolve(relayed);
    };
    p.onExit(finish);
    // Ask PowerShell to emit the DECSETs through the pty input pipe.
    setTimeout(() => {
      p.write('Write-Host -NoNewline ("e[?1000he[?1002he[?1006h" -replace "e", [char]27)\r');
    }, 1500);
    // Safety net: kill and let onExit report what we saw.
    setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* already gone; onExit fired */
      }
    }, 8000);
  });
}

(async () => {
  const dllOk = await probe('dll:', { useConpty: true, useConptyDll: true });
  const inboxOk = await probe('inbox:', { useConpty: true });
  console.log(`RESULT dll=${dllOk} inbox=${inboxOk}`);
  // Pass requires the bundled path to relay. The in-box result is
  // informational: 20348 (Server 2022 LTSC) may carry its own relay fix.
  process.exit(dllOk ? 0 : 1);
})();
