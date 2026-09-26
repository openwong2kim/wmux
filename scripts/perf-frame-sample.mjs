// Frame-budget p95 needs a longer window: three slow frames out of 59
// determine its tail, while 239 deltas distinguish that hiccup from sustained
// missed frames. Other scenarios pass their own sample sizes explicitly.
// Sample `frames` rAF deltas (ms) inside the renderer — the same cadence probe
// measureInputLatency uses, but WITHOUT any keystroke: it measures the compositor
// cadence while whatever workload is currently running streams. Returns raw
// deltas so the caller can summarize + detect throttling.
export async function sampleRafDeltas(page, frames = 240) {
  return page.evaluate((n) => new Promise((resolve) => {
    const deltas = []; let last = null; let i = 0;
    const tick = (ts) => {
      if (last !== null) deltas.push(ts - last);
      last = ts;
      if (++i < n) requestAnimationFrame(tick); else resolve(deltas);
    };
    requestAnimationFrame(tick);
  }), frames);
}

