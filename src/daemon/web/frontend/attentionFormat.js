/* How an attention event becomes a headline + subline, in ONE place.
 *
 * Pure and dependency-free on purpose: the build script inlines this file ahead
 * of app.js (there is no bundler here) and the unit tests evaluate it directly,
 * so the rule that decides what a phone shows is testable without a DOM. Any
 * other client that renders the same events (the native app) mirrors this.
 *
 * The notify payload contract is the parser's: `{source, title|null, body}` —
 * OSC 9 carries no title at all, which is why "body only" must produce a real
 * headline instead of the literal word "Notification".
 */
/* global globalThis */
(function (root) {
  'use strict';
  function formatAttention(kind, data) {
    data = data || {};
    if (kind === 'critical') {
      return { title: 'Approval needed', sub: data.action || 'A pane is waiting on you.' };
    }
    var title = typeof data.title === 'string' && data.title ? data.title : '';
    var body = typeof data.body === 'string' && data.body ? data.body : '';
    if (title && body) return { title: title, sub: body };
    if (body) return { title: body, sub: '' };     // body-only: the body IS the headline
    if (title) return { title: title, sub: '' };
    return { title: 'Notification', sub: '' };     // genuinely empty payload only
  }
  root.wmuxAttentionFormat = { formatAttention: formatAttention };
})(typeof globalThis !== 'undefined' ? globalThis : this);
