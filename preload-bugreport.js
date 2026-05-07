'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bugAPI', {
  openSupport: () => ipcRenderer.send('bug-report-open-support')
});
