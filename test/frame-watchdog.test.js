// Beweist die Annahme, auf der der Surface-Watchdog in main.js steht: requestAnimationFrame
// im Renderer antwortet nur, solange die View Frames bekommt. Bleibt die Antwort aus, waehrend
// IPC weiterlaeuft, ist genau das der Zustand, den der Watchdog reparieren soll.
//
// Laufen mit: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron test/frame-watchdog.test.js --no-sandbox
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const assert = require('assert');
const path = require('path');

let seen = false;
ipcMain.on('cd-frame-pong', () => { seen = true; });

function ping(view, ms) {
  seen = false;
  view.webContents.send('cd-frame-ping');
  return new Promise((r) => setTimeout(() => r(seen), ms));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 300, show: true });
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(__dirname, '..', 'preload-content.js') }
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 400, height: 300 });
  await view.webContents.loadURL('data:text/html,<body style="background:#c33">hi');
  await new Promise((r) => setTimeout(r, 1500));

  const visible = await ping(view, 1000);
  assert.strictEqual(visible, true, 'sichtbare View muss auf cd-frame-ping antworten');

  // Ohne Frames (hier per setVisible nachgestellt) muss die Antwort ausbleiben, sonst kann
  // der Watchdog den haengenden Zustand nicht von einem gesunden unterscheiden.
  view.webContents.setBackgroundThrottling(true);
  view.setVisible(false);
  await new Promise((r) => setTimeout(r, 500));
  const hidden = await ping(view, 1000);
  assert.strictEqual(hidden, false, 'View ohne Frames darf nicht antworten');

  // Und der Repaint-Weg muss sie wieder zum Antworten bringen.
  view.setVisible(true);
  view.webContents.setBackgroundThrottling(false);
  await new Promise((r) => setTimeout(r, 500));
  const restored = await ping(view, 1000);
  assert.strictEqual(restored, true, 'nach dem Repaint muss die View wieder antworten');

  console.log('ok: sichtbar=antwortet, ohne Frames=stumm, nach Repaint=antwortet');
  app.exit(0);
}).catch((e) => { console.error('FAIL', e); app.exit(1); });
