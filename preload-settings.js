const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('settings-get'),
  setMinimize: (v) => ipcRenderer.send('settings-minimize', v === true),
  setHotkey: (a) => ipcRenderer.invoke('settings-hotkey', typeof a === 'string' ? a : null),
  setClipboardHotkey: (a) => ipcRenderer.invoke('settings-clipboard-hotkey', typeof a === 'string' ? a : null),
  setAutostart: (v) => ipcRenderer.invoke('settings-autostart', v === true),
  setBgNotifications: (v) => ipcRenderer.send('settings-bg-notifications', v === true),
  addTemplate: (tpl) => ipcRenderer.invoke('settings-add-template', tpl),
  deleteTemplate: (id) => ipcRenderer.invoke('settings-delete-template', typeof id === 'string' ? id : null),
  close: () => ipcRenderer.send('settings-close')
});
