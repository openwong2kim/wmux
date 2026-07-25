/**
 * APNs provider-token (JWT) signing with WebCrypto only — no `node:crypto`, so
 * the same code runs on Cloudflare Workers, Deno, Bun, and Node 18+.
 *
 * Apple's provider tokens are ES256 JWTs signed with the .p8 key downloaded
 * from the developer portal. Apple accepts a token for one hour and rate-limits
 * issuing new ones, so we cache the signed string and the imported CryptoKey in
 * module memory. That cache is the relay's ONLY state — it holds no device
 * tokens and no payloads, and losing it (isolate recycling) costs one re-sign.
 */

/** Apple accepts a provider token for 60 minutes; refresh early to stay clear of the edge. */
export const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;

/** Apple rejects tokens issued less than ~20 minutes apart as a rate-limit signal. */
export const TOKEN_MIN_REFRESH_MS = 20 * 60 * 1000;

export interface ApnsSigningConfig {
  /** Contents of the .p8 file, PEM with the PKCS#8 header/footer. */
  keyP8: string;
  /** The 10-character Key ID from the developer portal. */
  keyId: string;
  /** The 10-character Team ID. */
  teamId: string;
}

export interface ApnsTokenProvider {
  /** Returns a cached token when one is fresh, otherwise signs a new one. */
  getToken(now?: number): Promise<string>;
  /** Drops the cached token so the next call re-signs (used after a 403 from APNs). */
  invalidate(): void;
}

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Strip the PEM armour and decode the DER body. Tolerant of CRLF, of the
 * literal "\n" sequences that survive a copy-paste into a secret store, and of
 * a bare base64 body with no header at all.
 */
export function decodeP8ToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (body.length === 0) throw new Error('APNS_KEY_P8 is empty');
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new Error('APNS_KEY_P8 is not valid base64');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Build the JWT string. Exported separately from the cache so tests can assert
 * header/claims/signature without reasoning about time.
 *
 * Header is `{alg, kid}` and claims are `{iss, iat}` — exactly the shape in
 * Apple's "Establishing a token-based connection to APNs" documentation.
 */
export async function signApnsJwt(
  key: CryptoKey,
  config: Pick<ApnsSigningConfig, 'keyId' | 'teamId'>,
  issuedAtMs: number,
): Promise<string> {
  const header = base64UrlEncodeJson({ alg: 'ES256', kid: config.keyId });
  const claims = base64UrlEncodeJson({
    iss: config.teamId,
    iat: Math.floor(issuedAtMs / 1000),
  });
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    key,
    new TextEncoder().encode(signingInput),
  );
  // WebCrypto emits IEEE P1363 (raw r||s), which is exactly what JWS ES256
  // wants — no DER unwrapping, unlike node:crypto's ECDSA output.
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function importApnsKey(keyP8: string): Promise<CryptoKey> {
  const pkcs8 = decodeP8ToPkcs8(keyP8);
  return crypto.subtle.importKey(
    'pkcs8',
    // Copy into a standalone ArrayBuffer so a SharedArrayBuffer-backed view can
    // never be handed to WebCrypto.
    pkcs8.slice().buffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * Create the cached signer. One instance per worker isolate; see the module
 * header for why in-memory caching is safe.
 */
export function createApnsTokenProvider(config: ApnsSigningConfig): ApnsTokenProvider {
  let keyPromise: Promise<CryptoKey> | null = null;
  let cached: { token: string; issuedAtMs: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function sign(now: number): Promise<string> {
    if (keyPromise === null) {
      keyPromise = importApnsKey(config.keyP8);
      // A bad .p8 must not poison the isolate forever — let the next request retry.
      keyPromise.catch(() => {
        keyPromise = null;
      });
    }
    const key = await keyPromise;
    const token = await signApnsJwt(key, config, now);
    cached = { token, issuedAtMs: now };
    return token;
  }

  return {
    async getToken(now = Date.now()): Promise<string> {
      if (cached !== null && now - cached.issuedAtMs < TOKEN_MAX_AGE_MS && now >= cached.issuedAtMs) {
        return cached.token;
      }
      // Collapse a thundering herd of concurrent requests onto one signature.
      if (inFlight === null) {
        inFlight = sign(now).finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
