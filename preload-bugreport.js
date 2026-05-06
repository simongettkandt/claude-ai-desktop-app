'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bugAPI', {
  submit: (payload) => ipcRenderer.invoke('bug-report-submit', payload)
});
