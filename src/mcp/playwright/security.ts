// ---------------------------------------------------------------------------
// Dangerous pattern detection for browser code execution
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS = [
  { pattern: /\bfetch\s*\(/, label: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, label: 'WebSocket' },
  { pattern: /\bnavigator\.sendBeacon\b/, label: 'sendBeacon' },
  { pattern: /\brequire\s*\(/, label: 'require()' },
  { pattern: /\bimport\s*\(/, label: 'dynamic import()' },
  { pattern: /\beval\s*\(/, label: 'eval()' },
  { pattern: /\bnew\s+Function\b/, label: 'new Function()' },
  { pattern: /\bdocument\.cookie\b/, label: 'document.cookie access' },
  { pattern: /\blocalStorage\b/, label: 'localStorage access' },
  { pattern: /\bsessionStorage\b/, label: 'sessionStorage access' },
  { pattern: /\bindexedDB\b/, label: 'indexedDB access' },
];

/**
 * Detect dangerous patterns in a JavaScript code string.
 * Returns an array of human-readable labels for each matched pattern.
 */
export function detectDangerousPatterns(code: string): string[] {
  return DANGEROUS_PATTERNS
    .filter(({ pattern }) => pattern.test(code))
    .map(({ label }) => label);
}

// ---------------------------------------------------------------------------
// Sensitive-domain blocklist for browser_cookies / browser_storage
// ---------------------------------------------------------------------------

const SENSITIVE_DOMAIN_PATTERNS: RegExp[] = [
  // Email
  /(^|\.)gmail\.com$/i,
  /(^|\.)googlemail\.com$/i,
  /(^|\.)outlook\.com$/i,
  /(^|\.)outlook\.live\.com$/i,
  /(^|\.)hotmail\.com$/i,
  /(^|\.)mail\.naver\.com$/i,
  /(^|\.)mail\.daum\.net$/i,
  /(^|\.)mail\.kakao\.com$/i,
  /(^|\.)mail\.yahoo\.com$/i,
  /(^|\.)proton\.me$/i,
  /(^|\.)icloud\.com$/i,
  // Banking / payments
  /(^|\.)paypal\.com$/i,
  /(^|\.)stripe\.com$/i,
  /(^|\.)chase\.com$/i,
  /(^|\.)bankofamerica\.com$/i,
  /(^|\.)wellsfargo\.com$/i,
  /(^|\.)kbstar\.com$/i,
  /(^|\.)shinhan\.com$/i,
  /(^|\.)wooribank\.com$/i,
  /(^|\.)hanabank\.com$/i,
  /(^|\.)ibk\.co\.kr$/i,
  /(^|\.)nonghyup\.com$/i,
  /(^|\.)tossbank\.com$/i,
  /(^|\.)toss\.im$/i,
  /(^|\.)tosspayments\.com$/i,
  /(^|\.)kakaopay\.com$/i,
  /(^|\.)naverpay\.com$/i,
  // Auth / identity / secrets
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)login\.live\.com$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)gitlab\.com$/i,
  /(^|\.)bitbucket\.org$/i,
  /(^|\.)atlassian\.com$/i,
  /(^|\.)okta\.com$/i,
  /(^|\.)auth0\.com$/i,
  /(^|\.)1password\.com$/i,
  /(^|\.)lastpass\.com$/i,
  /(^|\.)bitwarden\.com$/i,
];

/** The literal host each blocklist entry names (`mail.naver.com`, …). */
const SENSITIVE_HOST_LITERALS: readonly string[] = SENSITIVE_DOMAIN_PATTERNS.map((p) =>
  p.source.replace(/^\(\^\|\\\.\)/, '').replace(/\$$/, '').replace(/\\\./g, '.').toLowerCase(),
);

/**
 * Whether a cookie for `host` (canonical, no leading dot) is readable by a
 * sensitive site. A sign-in cookie usually lives on the parent domain
 * (`.naver.com` for mail.naver.com, `.google.com` for accounts.google.com), so
 * a domain that is the host itself, below it, or a registrable parent of it
 * counts. Single-label names never do.
 */
export function matchSensitiveCookieDomain(host: string): string | null {
  if (!host || !host.includes('.')) return null;
  if (matchSensitiveDomain(host)) return host;
  const h = host.toLowerCase();
  return SENSITIVE_HOST_LITERALS.some((lit) => lit.endsWith(`.${h}`)) ? host : null;
}

/**
 * Return the matched hostname if the URL (or bare hostname) falls on the
 * sensitive-domain blocklist, else null. Used by browser_cookies /
 * browser_storage to require explicit allowSensitiveDomains:true before
 * leaking session material for email / banking / auth surfaces.
 */
export function matchSensitiveDomain(urlOrHost: string): string | null {
  if (!urlOrHost) return null;
  let host = '';
  try {
    host = new URL(urlOrHost).hostname;
  } catch {
    host = urlOrHost.trim().toLowerCase().replace(/^\.+/, '');
  }
  if (!host) return null;
  for (const pattern of SENSITIVE_DOMAIN_PATTERNS) {
    if (pattern.test(host)) return host;
  }
  return null;
}
