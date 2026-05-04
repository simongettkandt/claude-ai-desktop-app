const { contextBridge, ipcRenderer } = require('electron');

function validIndex(i) {
  return typeof i === 'number' && Number.isInteger(i) && i >= 0;
}

function validId(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 80;
}

contextBridge.exposeInMainWorld('tabAPI', {
  onTabsUpdate: (cb) => ipcRenderer.on('tabs-update', (_, data) => cb(data)),
  onThemeUpdate: (cb) => ipcRenderer.on('theme-update', (_, dark) => cb(dark)),
  onDesignUpdate: (cb) => ipcRenderer.on('design-update', (_, custom) => cb(custom)),
  onNotificationsUpdate: (cb) => ipcRenderer.on('notifications-update', (_, list) => cb(list)),
  newTab: () => ipcRenderer.send('tab-new'),
  switchTab: (i) => { if (validIndex(i)) ipcRenderer.send('tab-switch', i); },
  closeTab: (i) => { if (validIndex(i)) ipcRenderer.send('tab-close', i); },
  toggleTheme: () => ipcRenderer.send('theme-toggle'),
  toggleDesign: () => ipcRenderer.send('design-toggle'),
  bugReport: () => ipcRenderer.send('bug-report'),
  exportConversation: () => ipcRenderer.send('export-conversation'),
  openAppMenu: (x, y) => {
    const px = typeof x === 'number' && Number.isFinite(x) ? x : 0;
    const py = typeof y === 'number' && Number.isFinite(y) ? y : 0;
    ipcRenderer.send('app-menu-popup', px, py);
  },
  dismissNotification: (id) => { if (validId(id)) ipcRenderer.send('notification-dismiss', id); },
  openNotificationLink: (id, url) => {
    if (!validId(id)) return;
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return;
    ipcRenderer.send('notification-link', { id, url });
  },
  requestNotifications: () => ipcRenderer.send('notifications-request')
});
