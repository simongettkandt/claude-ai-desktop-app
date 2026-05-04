const { contextBridge, ipcRenderer } = require('electron');

// Channel-Whitelisting: nur Channels mit erlaubten Präfixen werden durchgereicht.
// Verhindert dass Renderer beliebige IPC-Channels ansprechen können.
const ALLOWED_PREFIXES = [
  'msgbox-respond-',
  'mic-consent-open-snap-',
  'mic-consent-status-',
  'mic-consent-copy-cmd-'
];
const isAllowed = (ch) => typeof ch === 'string' && ALLOWED_PREFIXES.some(p => ch.startsWith(p));

contextBridge.exposeInMainWorld('msgboxAPI', {
  respond: (channel, index) => {
    if (isAllowed(channel)) ipcRenderer.send(channel, index);
  },
  openSnapPermissions: (channel) => {
    if (isAllowed(channel)) ipcRenderer.send(channel);
  },
  copySnapCmd: (channel) => {
    if (isAllowed(channel)) ipcRenderer.send(channel);
  },
  onStatusUpdate: (channel, cb) => {
    if (!isAllowed(channel)) return () => {};
    const handler = (_, status) => { try { cb(status); } catch {} };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
