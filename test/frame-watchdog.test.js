// Beweist die Annahmen, auf denen der Surface-Watchdog in main.js steht:
// 1. Der Renderer antwortet zweimal (sofort + aus requestAnimationFrame). Nur die rAF-Antwort
//    haengt an laufenden Frames, und genau diese Kombination unterscheidet eine haengende
//    Surface von einem bloss beschaeftigten Renderer.
// 2. setVisible(false) allein drosselt korrekt - ohne setBackgroundThrottling-Aufrufe.
// 3. setBackgroundThrottling(false) pinnt das Widget auf "nie versteckt". Das ist der Grund,
//    warum die App das Flag zur Laufzeit nicht mehr anfasst. Schlaegt dieser Test irgendwann
//    fehl, hat Electron das Verhalten geaendert und die Begruendung gehoert geprueft.
// 4. Beide Reparaturwege (Sichtbarkeits-Toggle, View neu anhaengen) bringen Frames zurueck,
//    und das Neuanhaengen laedt die Seite nicht neu.
//
// Laufen mit: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron test/frame-watchdog.test.js --no-sandbox
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const assert = require('assert');
const path = require('path');

let alive = false, raf = false;
ipcMain.on('cd-frame-pong', (_e, kind) => { if (kind === 'raf') raf = true; else alive = true; });

function ping(view, ms) {
  alive = false; raf = false;
  view.webContents.send('cd-frame-ping');
  return new Promise((r) => setTimeout(() => r({ alive, raf }), ms));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 300, show: true });
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: true, preload: path.join(__dirname, '..', 'preload-content.js') }
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 400, height: 300 });
  // Farbe als rgb(): ein '#' in der data:-URL wuerde als Fragment gelesen, der Rest des
  // Dokuments (und damit die Marke) landete nie im Renderer.
  await view.webContents.loadURL('data:text/html,<body style="background:rgb(204,51,51)">hi<script>window.__mark = 1</script>');
  await sleep(1500);

  assert.deepStrictEqual(await ping(view, 1000), { alive: true, raf: true }, 'sichtbare View muss beide Antworten liefern');

  // Ohne Frames muss die rAF-Antwort ausbleiben, die Sofort-Antwort aber kommen.
  view.setVisible(false);
  await sleep(500);
  assert.deepStrictEqual(await ping(view, 1000), { alive: true, raf: false }, 'versteckte View: lebendig, aber keine Frames');

  // Reparatur 1: Sichtbarkeits-Toggle wie in repaintActiveView.
  view.setVisible(true);
  await sleep(500);
  assert.strictEqual((await ping(view, 1000)).raf, true, 'nach dem Repaint muss die View wieder Frames liefern');

  // Reparatur 2: abhaengen und neu anhaengen, ohne die Seite zu verlieren.
  win.contentView.removeChildView(view);
  win.contentView.addChildView(view);
  view.setVisible(true);
  view.setBounds({ x: 0, y: 0, width: 400, height: 300 });
  await sleep(800);
  assert.strictEqual((await ping(view, 1000)).raf, true, 'nach dem Neuanhaengen muss die View Frames liefern');
  assert.strictEqual(await view.webContents.executeJavaScript('window.__mark'), 1, 'Neuanhaengen darf die Seite nicht neu laden');

  // Der Grund fuer den Verzicht auf setBackgroundThrottling zur Laufzeit.
  view.webContents.setBackgroundThrottling(false);
  await sleep(200);
  view.setVisible(false);
  await sleep(600);
  assert.strictEqual((await ping(view, 1000)).raf, true, 'gepinntes Flag laesst die versteckte View weiterrendern (Visibility-Desync)');

  console.log('ok: Heartbeat, Drosselung ohne Flag, beide Reparaturwege, Desync-Nachweis');
  app.exit(0);
}).catch((e) => { console.error('FAIL', e); app.exit(1); });
