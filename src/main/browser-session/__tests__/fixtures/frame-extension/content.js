/* global chrome */
// Adds the extension's own page to the document as an iframe (a frame on a
// chrome-extension:// URL inside an http(s) page).
const frame = document.createElement('iframe');
frame.id = 'extension-frame';
frame.src = chrome.runtime.getURL('frame.html');
document.documentElement.appendChild(frame);
