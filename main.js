const { app, BrowserWindow, shell, Menu, nativeTheme, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// Force dark mode
nativeTheme.themeSource = 'dark';

// Sprache erkennen – LANG/LANGUAGE Umgebungsvariable hat Vorrang (zuverlässiger auf Linux)
const sysLang = (process.env.LANG || process.env.LANGUAGE || app.getLocale() || 'en').substring(0, 2);
const isDe = sysLang === 'de';
const t = (de, en) => isDe ? de : en;

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 600,
    title: 'Claude Desktop',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0f0f0f',
    // Kein focusable-Lock oder always-on-top
    alwaysOnTop: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Wichtig für Google OAuth: Popups und neue Fenster erlauben
      nativeWindowOpen: true,
      allowRunningInsecureContent: false
    }
  });

  // User-Agent setzen der Google OAuth erlaubt
  // Google blockiert Electron-User-Agents, daher Chrome-UA nutzen
  const chromeVersion = process.versions.chrome;
  const chromeUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  mainWindow.webContents.setUserAgent(chromeUA);

  // Claude.ai laden
  mainWindow.loadURL('https://claude.ai');

  // Google OAuth Popups korrekt behandeln
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { action: 'deny' };
    }

    // Google Auth URLs im eigenen Fenster öffnen
    if (parsed.hostname === 'accounts.google.com' ||
        (parsed.hostname === 'google.com' && parsed.pathname.startsWith('/o/oauth'))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500,
          height: 700,
          title: t('Google Anmeldung', 'Google Sign-In'),
          parent: mainWindow,
          modal: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
          }
        }
      };
    }

    // Andere Claude-URLs im Hauptfenster
    if (parsed.hostname === 'claude.ai' && parsed.protocol === 'https:') {
      return { action: 'allow' };
    }

    // Alles andere im System-Browser – nur sichere Protokolle
    if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Auch neue WebContents (OAuth-Fenster) brauchen den Chrome User-Agent
  app.on('web-contents-created', (event, contents) => {
    contents.setUserAgent(chromeUA);
    
    // OAuth Redirects zurück zu Claude erlauben, alles andere blockieren
    contents.on('will-navigate', (event, url) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        event.preventDefault();
        return;
      }

      const allowed = ['claude.ai', 'accounts.google.com', 'www.google.com'];
      if (parsed.protocol === 'https:' && allowed.includes(parsed.hostname)) {
        return;
      }
      event.preventDefault();
    });
  });

  // Loading indicator
  mainWindow.webContents.on('did-start-loading', () => {
    mainWindow.setTitle(t('Claude Desktop – Laden…', 'Claude Desktop – Loading…'));
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.setTitle('Claude Desktop');

    // Custom CSS für bessere Desktop-Integration
    mainWindow.webContents.insertCSS(`
      /* Scrollbar styling */
      ::-webkit-scrollbar { width: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: #4a4a4a; }

      /* Smooth transitions */
      * { scroll-behavior: smooth; }
    `);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createMenu() {
  const template = [
    {
      label: 'Claude',
      submenu: [
        { label: t('Neuer Chat', 'New Chat'), accelerator: 'CmdOrCtrl+N', click: () => mainWindow.loadURL('https://claude.ai') },
        { type: 'separator' },
        { label: t('Einstellungen', 'Settings'), accelerator: 'CmdOrCtrl+,', click: () => mainWindow.loadURL('https://claude.ai/settings') },
        { type: 'separator' },
        { label: t('Nach Updates suchen…', 'Check for Updates…'), click: () => autoUpdater.checkForUpdatesAndNotify() },
        { type: 'separator' },
        { role: 'quit', label: t('Beenden', 'Quit') }
      ]
    },
    {
      label: t('Bearbeiten', 'Edit'),
      submenu: [
        { role: 'undo', label: t('Rückgängig', 'Undo') },
        { role: 'redo', label: t('Wiederholen', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: t('Ausschneiden', 'Cut') },
        { role: 'copy', label: t('Kopieren', 'Copy') },
        { role: 'paste', label: t('Einfügen', 'Paste') },
        { role: 'selectAll', label: t('Alles auswählen', 'Select All') }
      ]
    },
    {
      label: t('Ansicht', 'View'),
      submenu: [
        { role: 'reload', label: t('Neu laden', 'Reload') },
        { role: 'forceReload', label: t('Neu laden erzwingen', 'Force Reload') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('Zoom zurücksetzen', 'Reset Zoom') },
        { role: 'zoomIn', label: t('Vergrößern', 'Zoom In') },
        { role: 'zoomOut', label: t('Verkleinern', 'Zoom Out') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('Vollbild', 'Fullscreen') },
        ...(!app.isPackaged ? [
          { type: 'separator' },
          { role: 'toggleDevTools', label: t('Entwicklertools', 'Developer Tools') }
        ] : [])
      ]
    },
    {
      label: t('Fenster', 'Window'),
      submenu: [
        { role: 'minimize', label: t('Minimieren', 'Minimize') },
        { role: 'close', label: t('Schließen', 'Close') }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // CSP-Header: Nur auf eigene (lokale) Seiten anwenden, nicht auf claude.ai
  // claude.ai bringt seine eigene CSP mit – wir überschreiben sie nicht
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const url = new URL(details.url);
    if (url.protocol === 'file:' || url.hostname === 'localhost') {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self' https://claude.ai https://*.claude.ai; " +
            "script-src 'self' https://claude.ai https://*.claude.ai; " +
            "style-src 'self' 'unsafe-inline';"
          ]
        }
      });
    } else {
      callback({ responseHeaders: details.responseHeaders });
    }
  });

  createWindow();
  createMenu();

  // Auto-Updater konfigurieren
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    if (mainWindow) {
      mainWindow.setTitle(t(
        `Claude Desktop – Update ${info.version} wird heruntergeladen…`,
        `Claude Desktop – Downloading update ${info.version}…`
      ));
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) {
      mainWindow.setTitle(`Claude Desktop – Download ${Math.round(progress.percent)}%`);
    }
  });

  autoUpdater.on('update-downloaded', () => {
    if (mainWindow) {
      mainWindow.setTitle(t(
        'Claude Desktop – Update bereit (Neustart zum Installieren)',
        'Claude Desktop – Update ready (restart to install)'
      ));
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
  });

  autoUpdater.checkForUpdatesAndNotify();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
