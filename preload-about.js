const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aboutAPI', {
  close: () => ipcRenderer.send('about-close'),
  openWhatsNew: () => ipcRenderer.send('about-open-whatsnew'),
  openExternal: (url) => ipcRenderer.send('about-open-external', typeof url === 'string' ? url : '')
});
