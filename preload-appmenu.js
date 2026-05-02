const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appMenuAPI', {
  action: (name) => {
    if (typeof name === 'string' && name.length > 0 && name.length < 64) {
      ipcRenderer.send('appmenu-action', name);
    }
  },
  close: () => ipcRenderer.send('appmenu-close')
});
