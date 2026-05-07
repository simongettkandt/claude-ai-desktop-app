const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('settings-get'),
  setMinimize: (v) => ipcRenderer.send('settings-minimize', v === true),
  setHotkey: (a) => ipcRenderer.invoke('settings-hotkey', typeof a === 'string' ? a : null),
  setClipboardHotkey: (a) => ipcRenderer.invoke('settings-clipboard-hotkey', typeof a === 'string' ? a : null),
  setAutostart: (v) => ipcRenderer.invoke('settings-autostart', v === true),
  setBgNotifications: (v) => ipcRenderer.send('settings-bg-notifications', v === true),
  setMicrophone: (v) => ipcRenderer.send('settings-microphone', v === true),
  // Auf Snap erst Plug-Status pruefen + ggf. Consent-Dialog zeigen.
  // Returnt { applied: boolean, status: 'connected'|'disconnected'|'unknown' }.
  setMicrophoneWithConsent: (v) => ipcRenderer.invoke('settings-microphone-with-consent', v === true),
  getSnapMicStatus: () => ipcRenderer.invoke('settings-mic-snap-status'),
  resetMicrophoneConsent: () => ipcRenderer.send('settings-microphone-reset'),
  openSnapPermissions: () => ipcRenderer.send('settings-open-snap-permissions'),
  copySnapCmd: () => ipcRenderer.send('settings-copy-snap-cmd'),
  addTemplate: (tpl) => ipcRenderer.invoke('settings-add-template', tpl),
  deleteTemplate: (id) => ipcRenderer.invoke('settings-delete-template', typeof id === 'string' ? id : null),
  close: () => ipcRenderer.send('settings-close')
});
