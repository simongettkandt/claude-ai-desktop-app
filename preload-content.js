// Preload für claude.ai-Tab-Views.
// Stellt eine schmale Bridge bereit, über die das injected notify.js den Main-Process
// über fertige Antworten informieren kann.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeDesktop', {
  responseDone: (payload) => {
    let preview = '';
    if (payload && typeof payload === 'object' && typeof payload.preview === 'string') {
      preview = payload.preview.slice(0, 200);
    }
    ipcRenderer.send('claude-response-done', { preview });
  }
});
