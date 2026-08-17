const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('designAPI', {
  setMode: (m) => { if (typeof m === 'string') ipcRenderer.send('design-set-mode', m); },
  setDesign: (v) => ipcRenderer.send('design-set-design', v === true),
  close: () => ipcRenderer.send('design-close')
});
