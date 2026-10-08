import { session } from 'electron';
import { PRIVATE_BROWSER_PARTITION } from '../../shared/privateBrowser';

type ClearableSession = Pick<Electron.Session, 'clearStorageData' | 'clearCache' | 'clearAuthCache'>;

/**
 * Erase everything the shared private-tab session holds: cookies, storage,
 * HTTP cache and HTTP auth. The partition is in-memory already; this is what
 * makes closing the last private tab end the private session rather than wait
 * for the app to quit.
 */
export async function clearPrivateBrowserSession(
  fromPartition: (partition: string) => ClearableSession = (p) => session.fromPartition(p),
): Promise<void> {
  const target = fromPartition(PRIVATE_BROWSER_PARTITION);
  await Promise.all([target.clearStorageData(), target.clearCache(), target.clearAuthCache()]);
}
