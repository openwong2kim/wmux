// A periodic memory line on stderr, so a process that grows over days shows
// where (heap, or Buffers counted in `external`) before anyone takes a heap
// snapshot. The 4.16.0 browser-body leak grew `external` for 53 hours with
// nothing in the logs.

export const MEMORY_LOG_INTERVAL_MS = 5 * 60_000;
/** Above this, one warning line; another only after it has dropped back under. */
export const EXTERNAL_WARN_BYTES = 300 * 1024 * 1024;

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))}MB`;

/** The line for one sample, and whether `external` is over the warning mark. */
export function memoryLine(prefix: string, usage: NodeJS.MemoryUsage): { line: string; over: boolean } {
  return {
    line:
      `${prefix} memory rss=${mb(usage.rss)} heapUsed=${mb(usage.heapUsed)}` +
      ` external=${mb(usage.external)} arrayBuffers=${mb(usage.arrayBuffers)}`,
    over: usage.external > EXTERNAL_WARN_BYTES,
  };
}

/** Start logging every MEMORY_LOG_INTERVAL_MS; the timer never keeps the process alive. */
export function startMemoryLog(prefix: string, sample: () => NodeJS.MemoryUsage = () => process.memoryUsage()): () => void {
  let warned = false;
  const timer = setInterval(() => {
    const { line, over } = memoryLine(prefix, sample());
    console.error(line);
    if (over && !warned) {
      console.error(`${prefix} warning: external memory is over ${mb(EXTERNAL_WARN_BYTES)} (${line.slice(prefix.length + 1)})`);
    }
    warned = over;
  }, MEMORY_LOG_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
