const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quickPromptAPI', {
  submit: (text) => {
    if (typeof text === 'string' && text.length > 0 && text.length <= 8000) {
      ipcRenderer.send('quickprompt-submit', text);
    }
  },
  cancel: () => ipcRenderer.send('quickprompt-cancel')
});
