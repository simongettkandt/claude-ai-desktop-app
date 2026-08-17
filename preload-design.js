const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('designAPI', {
  setMode: (m) => { if (typeof m === 'string') ipcRenderer.send('design-set-mode', m); },
  setDesign: (s) => { if (typeof s === 'string') ipcRenderer.send('design-set-design', s); },
  close: () => ipcRenderer.send('design-close')
});
