/**
 * Read a pairing code out of the /pair URL.
 *
 * Split from app.js so it can be unit-tested without a browser, exactly like
 * attentionFormat.js. The parsing is the part worth testing: everything else on
 * this path is DOM wiring.
 *
 * A scanned QR arrives as `/pair?code=ABC123`, which is the whole point of the
 * QR — the phone types nothing. The code is narrow enough to ride a URL
 * (single use, ten minutes, five attempts), but it is still a credential in a
 * place credentials get written down, so the caller strips it from the address
 * bar via history.replaceState the moment it has been read.
 */
(function (root) {
  'use strict';

  /** Codes are six characters from the server's own alphabet: A-Z and 2-9. */
  var CODE_RE = /^[A-Z0-9]{6}$/;

  /**
   * Extract a usable code from a query string, or '' when there is none.
   *
   * Returns '' rather than throwing for anything malformed. A junk `?code=`
   * must land the visitor on the normal manual-entry form, not an error: the
   * most likely cause is a half-copied link, and the form is the way forward.
   *
   * Case is normalised up because the server compares against an uppercase
   * code and some keyboards autocorrect to lowercase; whitespace is trimmed
   * because a copied link often carries a trailing space.
   */
  function readPairCode(search) {
    if (typeof search !== 'string' || search === '') return '';
    var params;
    try {
      params = new URLSearchParams(search);
    } catch (e) {
      return '';
    }
    var raw = params.get('code');
    if (raw === null) return '';
    var code = String(raw).trim().toUpperCase();
    return CODE_RE.test(code) ? code : '';
  }

  /**
   * The URL to replace the current one with, once the code has been read.
   *
   * Keeps the path and every other parameter, drops only `code`. Returns null
   * when there was no `code` to remove, so the caller can skip the
   * replaceState entirely rather than push an identical entry.
   */
  function urlWithoutCode(pathname, search) {
    if (typeof search !== 'string' || search.indexOf('code=') === -1) return null;
    var params;
    try {
      params = new URLSearchParams(search);
    } catch (e) {
      return null;
    }
    if (!params.has('code')) return null;
    params.delete('code');
    var rest = params.toString();
    return (pathname || '/pair') + (rest ? '?' + rest : '');
  }

  root.pairQuery = { readPairCode: readPairCode, urlWithoutCode: urlWithoutCode };
})(typeof globalThis !== 'undefined' ? globalThis : this);
