/**
 * A command the browser answered with a CDP error: the connection was up and
 * Chrome said no. A closed connection, a timeout or an ended pipe rejects
 * with a plain Error instead.
 */
export class CdpReplyError extends Error {}
