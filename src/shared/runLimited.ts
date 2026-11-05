/**
 * Run `fn` over `items`, at most `limit` calls at a time. Resolves once every
 * call has settled; a call that throws or rejects does not stop the others.
 */
export async function runLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch {
        /* the caller's fn reports its own failures */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}
