const { app, BrowserWindow, WebContentsView, shell, Menu, Tray, globalShortcut, nativeImage, nativeTheme, dialog, Notification, session, ipcMain, net, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { version } = require('./package.json');

// ── Electron "Object has been destroyed" Error-Dialog abfangen ──
const _origErrorBox = dialog.showErrorBox;
dialog.showErrorBox = (title, content) => {
  if (typeof content === 'string' && content.includes('Object has been destroyed')) return;
  _origErrorBox(title, content);
};

if (app.isPackaged) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// ── Single Instance ──
if (!app.requestSingleInstanceLock()) { app.quit(); }

// ═══════════════════════════════════════════════════════════════════
//  Konstanten
// ═══════════════════════════════════════════════════════════════════

const isDev = !app.isPackaged;
const chromeUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

const TAB_BAR_HEIGHT = 40;
const POOL_SIZE = 0;
const MAX_CRASH_RELOADS = 3;
const ONLINE_CHECK_MS = 60_000;
const UPDATE_CHECK_MS = 3_600_000;
const DOMAIN_CACHE_MAX = 50;

// ═══════════════════════════════════════════════════════════════════
//  Injected Scripts (aus Dateien geladen)
// ═══════════════════════════════════════════════════════════════════

const BRAND_SCRIPT = fs.readFileSync(path.join(__dirname, 'inject', 'brand.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════════════

let mainWindow = null;
let tabs = [];
let activeTabIndex = 0;
let isOnline = true;
let isDarkMode = true;
let customDesign = true;

// Tab-Pool (vorgeladene Views)
const viewPool = [];

// ═══════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function throttle(fn, ms) {
  let last = 0, timer;
  return (...args) => {
    const now = Date.now();
    clearTimeout(timer);
    if (now - last >= ms) { last = now; fn(...args); }
    else { timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last)); }
  };
}

// Sicherer WebContents-Zugriff
function alive(viewOrWc) {
  if (!viewOrWc) return false;
  const wc = viewOrWc.webContents || viewOrWc;
  return wc && !wc.isDestroyed();
}

// ═══════════════════════════════════════════════════════════════════
//  i18n (multi-language)
// ═══════════════════════════════════════════════════════════════════

const sysLang = (() => {
  const l = (process.env.LANG || process.env.LANGUAGE || '').toLowerCase();
  if (l.startsWith('de')) return 'de';
  if (l.startsWith('fr')) return 'fr';
  if (l.startsWith('es')) return 'es';
  if (l.startsWith('pt')) return 'pt';
  if (l.startsWith('it')) return 'it';
  if (l.startsWith('nl')) return 'nl';
  if (l.startsWith('pl')) return 'pl';
  if (l.startsWith('ru')) return 'ru';
  if (l.startsWith('ja')) return 'ja';
  if (l.startsWith('ko')) return 'ko';
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('tr')) return 'tr';
  if (l.startsWith('ar')) return 'ar';
  if (l.startsWith('sv')) return 'sv';
  if (l.startsWith('da')) return 'da';
  if (l.startsWith('no') || l.startsWith('nb') || l.startsWith('nn')) return 'no';
  if (l.startsWith('fi')) return 'fi';
  if (l.startsWith('cs')) return 'cs';
  if (l.startsWith('uk')) return 'uk';
  if (l.startsWith('hu')) return 'hu';
  if (l.startsWith('ro')) return 'ro';
  if (l.startsWith('el')) return 'el';
  if (l.startsWith('hi')) return 'hi';
  if (l.startsWith('th')) return 'th';
  if (l.startsWith('vi')) return 'vi';
  if (l.startsWith('id') || l.startsWith('ms')) return 'id';
  return 'en';
})();

const isDE = sysLang === 'de';
function t(de, en) { return isDE ? de : en; }

// Lokalisierte Strings für den Bug-Report-Dialog
const bugReportStrings = {
  en: { title: 'Report a Bug', body: 'Found a bug or have a suggestion?\nPlease send an email to:', btn: 'Copy Email', copied: 'Copied!' },
  de: { title: 'Fehler melden', body: 'Einen Fehler gefunden oder einen Vorschlag?\nBitte sende eine E-Mail an:', btn: 'E-Mail kopieren', copied: 'Kopiert!' },
  fr: { title: 'Signaler un bug', body: 'Vous avez trouv\u00e9 un bug ou une suggestion ?\nVeuillez envoyer un e-mail \u00e0 :', btn: 'Copier l\u2019e-mail', copied: 'Copi\u00e9 !' },
  es: { title: 'Reportar un error', body: '\u00bfEncontraste un error o tienes una sugerencia?\nEnv\u00eda un correo a:', btn: 'Copiar correo', copied: '\u00a1Copiado!' },
  pt: { title: 'Reportar um bug', body: 'Encontrou um bug ou tem uma sugest\u00e3o?\nEnvie um e-mail para:', btn: 'Copiar e-mail', copied: 'Copiado!' },
  it: { title: 'Segnala un bug', body: 'Hai trovato un bug o un suggerimento?\nInvia un\u2019email a:', btn: 'Copia email', copied: 'Copiato!' },
  nl: { title: 'Bug melden', body: 'Een bug gevonden of een suggestie?\nStuur een e-mail naar:', btn: 'E-mail kopi\u00ebren', copied: 'Gekopieerd!' },
  pl: { title: 'Zg\u0142o\u015b b\u0142\u0105d', body: 'Znalaz\u0142e\u015b b\u0142\u0105d lub masz sugesti\u0119?\nWy\u015blij e-mail na:', btn: 'Kopiuj e-mail', copied: 'Skopiowano!' },
  ru: { title: '\u0421\u043e\u043e\u0431\u0449\u0438\u0442\u044c \u043e\u0431 \u043e\u0448\u0438\u0431\u043a\u0435', body: '\u041d\u0430\u0448\u043b\u0438 \u043e\u0448\u0438\u0431\u043a\u0443 \u0438\u043b\u0438 \u0435\u0441\u0442\u044c \u043f\u0440\u0435\u0434\u043b\u043e\u0436\u0435\u043d\u0438\u0435?\n\u041e\u0442\u043f\u0440\u0430\u0432\u044c\u0442\u0435 \u043f\u0438\u0441\u044c\u043c\u043e \u043d\u0430:', btn: '\u041a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c', copied: '\u0421\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d\u043e!' },
  ja: { title: '\u30d0\u30b0\u3092\u5831\u544a', body: '\u30d0\u30b0\u3084\u63d0\u6848\u304c\u3042\u308a\u307e\u3059\u304b\uff1f\n\u4ee5\u4e0b\u306b\u30e1\u30fc\u30eb\u3092\u304a\u9001\u308a\u304f\u3060\u3055\u3044\uff1a', btn: '\u30e1\u30fc\u30eb\u3092\u30b3\u30d4\u30fc', copied: '\u30b3\u30d4\u30fc\u3057\u307e\u3057\u305f\uff01' },
  ko: { title: '\ubc84\uadf8 \uc2e0\uace0', body: '\ubc84\uadf8\ub97c \ubc1c\uacac\ud588\uac70\ub098 \uc81c\uc548\uc774 \uc788\uc73c\uc2e0\uac00\uc694?\n\ub2e4\uc74c \uc8fc\uc18c\ub85c \uc774\uba54\uc77c\uc744 \ubcf4\ub0b4\uc8fc\uc138\uc694:', btn: '\uc774\uba54\uc77c \ubcf5\uc0ac', copied: '\ubcf5\uc0ac\ub428!' },
  zh: { title: '\u62a5\u544a\u9519\u8bef', body: '\u53d1\u73b0\u4e86\u9519\u8bef\u6216\u6709\u5efa\u8bae\uff1f\n\u8bf7\u53d1\u9001\u7535\u5b50\u90ae\u4ef6\u81f3\uff1a', btn: '\u590d\u5236\u90ae\u7bb1', copied: '\u5df2\u590d\u5236\uff01' },
  tr: { title: 'Hata bildir', body: 'Bir hata m\u0131 buldunuz veya bir \u00f6neriniz mi var?\nL\u00fctfen e-posta g\u00f6nderin:', btn: 'E-postay\u0131 kopyala', copied: 'Kopyaland\u0131!' },
  ar: { title: '\u0627\u0644\u0625\u0628\u0644\u0627\u063a \u0639\u0646 \u062e\u0637\u0623', body: '\u0648\u062c\u062f\u062a \u062e\u0637\u0623 \u0623\u0648 \u0644\u062f\u064a\u0643 \u0627\u0642\u062a\u0631\u0627\u062d\u061f\n\u0627\u0644\u0631\u062c\u0627\u0621 \u0625\u0631\u0633\u0627\u0644 \u0628\u0631\u064a\u062f \u0625\u0644\u0643\u062a\u0631\u043e\u0646\u0438 \u0625\u0644\u0649:', btn: '\u0646\u0633\u062e \u0627\u0644\u0628\u0631\u064a\u062f', copied: '\u062a\u0645 \u0627\u0644\u0646\u0633\u062e!' },
  sv: { title: 'Rapportera en bugg', body: 'Hittat en bugg eller har ett f\u00f6rslag?\nSkicka ett e-postmeddelande till:', btn: 'Kopiera e-post', copied: 'Kopierat!' },
  da: { title: 'Rapport\u00e9r en fejl', body: 'Fundet en fejl eller har et forslag?\nSend en e-mail til:', btn: 'Kopi\u00e9r e-mail', copied: 'Kopieret!' },
  no: { title: 'Rapporter en feil', body: 'Funnet en feil eller har et forslag?\nSend en e-post til:', btn: 'Kopier e-post', copied: 'Kopiert!' },
  fi: { title: 'Ilmoita virheest\u00e4', body: 'L\u00f6ysitkö virheen tai onko sinulla ehdotus?\nL\u00e4het\u00e4 s\u00e4hk\u00f6posti osoitteeseen:', btn: 'Kopioi s\u00e4hk\u00f6posti', copied: 'Kopioitu!' },
  cs: { title: 'Nahl\u00e1sit chybu', body: 'Na\u0161li jste chybu nebo m\u00e1te n\u00e1vrh?\nPo\u0161lete e-mail na:', btn: 'Kop\u00edrovat e-mail', copied: 'Zkop\u00edrov\u00e1no!' },
  uk: { title: '\u041f\u043e\u0432\u0456\u0434\u043e\u043c\u0438\u0442\u0438 \u043f\u0440\u043e \u043f\u043e\u043c\u0438\u043b\u043a\u0443', body: '\u0417\u043d\u0430\u0439\u0448\u043b\u0438 \u043f\u043e\u043c\u0438\u043b\u043a\u0443 \u0430\u0431\u043e \u043c\u0430\u0454\u0442\u0435 \u043f\u0440\u043e\u043f\u043e\u0437\u0438\u0446\u0456\u044e?\n\u041d\u0430\u0434\u0456\u0448\u043b\u0456\u0442\u044c \u043b\u0438\u0441\u0442\u0430 \u043d\u0430:', btn: '\u041a\u043e\u043f\u0456\u044e\u0432\u0430\u0442\u0438', copied: '\u0421\u043a\u043e\u043f\u0456\u0439\u043e\u0432\u0430\u043d\u043e!' },
  hu: { title: 'Hiba bejelent\u00e9se', body: 'Hib\u00e1t tal\u00e1lt\u00e1l vagy van egy javaslat?\nK\u00fcldj e-mailt ide:', btn: 'E-mail m\u00e1sol\u00e1sa', copied: 'M\u00e1solva!' },
  ro: { title: 'Raporteaz\u0103 o eroare', body: 'Ai g\u0103sit o eroare sau ai o sugestie?\nTrimite un e-mail la:', btn: 'Copiaz\u0103 e-mail', copied: 'Copiat!' },
  el: { title: '\u0391\u03bd\u03b1\u03c6\u03bf\u03c1\u03ac \u03c3\u03c6\u03ac\u03bb\u03bc\u03b1\u03c4\u03bf\u03c2', body: '\u0392\u03c1\u03ae\u03ba\u03b1\u03c4\u03b5 \u03c3\u03c6\u03ac\u03bb\u03bc\u03b1 \u03ae \u03ad\u03c7\u03b5\u03c4\u03b5 \u03c0\u03c1\u03cc\u03c4\u03b1\u03c3\u03b7;\n\u03a3\u03c4\u03b5\u03af\u03bb\u03c4\u03b5 email \u03c3\u03c4\u03bf:', btn: '\u0391\u03bd\u03c4\u03b9\u03b3\u03c1\u03b1\u03c6\u03ae email', copied: '\u0391\u03bd\u03c4\u03b9\u03b3\u03c1\u03ac\u03c6\u03c4\u03b7\u03ba\u03b5!' },
  hi: { title: '\u092c\u0917 \u0930\u093f\u092a\u094b\u0930\u094d\u091f \u0915\u0930\u0947\u0902', body: '\u0915\u094b\u0908 \u092c\u0917 \u092e\u093f\u0932\u093e \u092f\u093e \u0938\u0941\u091d\u093e\u0935 \u0939\u0948?\n\u0915\u0943\u092a\u092f\u093e \u0907\u0938 \u092a\u0930 \u0908\u092e\u0947\u0932 \u092d\u0947\u091c\u0947\u0902:', btn: '\u0908\u092e\u0947\u0932 \u0915\u0949\u092a\u0940 \u0915\u0930\u0947\u0902', copied: '\u0915\u0949\u092a\u0940 \u0939\u094b \u0917\u092f\u093e!' },
  th: { title: '\u0e23\u0e32\u0e22\u0e07\u0e32\u0e19\u0e02\u0e49\u0e2d\u0e1c\u0e34\u0e14\u0e1e\u0e25\u0e32\u0e14', body: '\u0e1e\u0e1a\u0e02\u0e49\u0e2d\u0e1c\u0e34\u0e14\u0e1e\u0e25\u0e32\u0e14\u0e2b\u0e23\u0e37\u0e2d\u0e21\u0e35\u0e02\u0e49\u0e2d\u0e40\u0e2a\u0e19\u0e2d\u0e41\u0e19\u0e30?\n\u0e01\u0e23\u0e38\u0e13\u0e32\u0e2a\u0e48\u0e07\u0e2d\u0e35\u0e40\u0e21\u0e25\u0e44\u0e1b\u0e17\u0e35\u0e48:', btn: '\u0e04\u0e31\u0e14\u0e25\u0e2d\u0e01\u0e2d\u0e35\u0e40\u0e21\u0e25', copied: '\u0e04\u0e31\u0e14\u0e25\u0e2d\u0e01\u0e41\u0e25\u0e49\u0e27!' },
  vi: { title: 'B\u00e1o l\u1ed7i', body: 'B\u1ea1n t\u00ecm th\u1ea5y l\u1ed7i ho\u1eb7c c\u00f3 g\u00f3p \u00fd?\nVui l\u00f2ng g\u1eedi email \u0111\u1ebfn:', btn: 'Sao ch\u00e9p email', copied: '\u0110\u00e3 sao ch\u00e9p!' },
  id: { title: 'Laporkan bug', body: 'Menemukan bug atau punya saran?\nSilakan kirim email ke:', btn: 'Salin email', copied: 'Disalin!' },
};

// ═══════════════════════════════════════════════════════════════════
//  Window-State (persistiert Größe, Position, Theme)
// ═══════════════════════════════════════════════════════════════════

const stateFile = path.join(app.getPath('userData'), 'window-state.json');
let windowState = {};
let lastSavedState = '';
let tray = null;
let isQuitting = false;
let settingsWindow = null;
let quickPromptWindow = null;
let whatsNewWindow = null;
let minimizeOnClose = false;
let currentHotkey = null;
let updateCheckInterval = null;
let onlineCheckInterval = null;
let waitForFirstTabInterval = null;

const RELEASE_NOTES = {
  '1.3.0': [
    { icon: 'tray', title: 'Systemtray & Hintergrund-Modus', text: 'Claude l\u00e4uft jetzt im Hintergrund weiter und ist \u00fcber das Tray-Symbol erreichbar.' },
    { icon: 'bolt', title: 'Globaler Quick-Prompt', text: 'Ein frei w\u00e4hlbarer Hotkey \u00f6ffnet ein Eingabefenster f\u00fcr neue Chats \u2013 direkt aus jeder App.' },
    { icon: 'check', title: 'Update-Check mit Feedback', text: 'Das Men\u00fc zeigt jetzt klar an, ob ein Update bereitsteht oder die App aktuell ist.' },
    { icon: 'settings', title: 'App-Einstellungen', text: 'Neuer Dialog f\u00fcr Tray-Verhalten und Hotkey \u2013 jederzeit \u00fcber das Men\u00fc erreichbar.' }
  ]
};

function loadWindowState() {
  try {
    if (fs.existsSync(stateFile)) windowState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  if (windowState.customDesign !== undefined) customDesign = windowState.customDesign;
  if (windowState.isDarkMode !== undefined) isDarkMode = windowState.isDarkMode;
  minimizeOnClose = windowState.minimizeOnClose === true;
  currentHotkey = typeof windowState.hotkey === 'string' && windowState.hotkey.length > 0 ? windowState.hotkey : null;

  const result = {
    width: windowState.width || 1200, height: windowState.height || 800,
    x: windowState.x, y: windowState.y, isMaximized: windowState.isMaximized || false
  };

  // Gespeicherte Position auf sichtbare Displays clampen
  if (result.x !== undefined && result.y !== undefined) {
    try {
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const wa = d.workArea;
        return result.x < wa.x + wa.width && result.x + result.width > wa.x
          && result.y < wa.y + wa.height && result.y + result.height > wa.y;
      });
      if (!onScreen) {
        delete result.x;
        delete result.y;
      }
    } catch {}
  }

  return result;
}

function buildState() {
  const base = {
    customDesign, isDarkMode,
    minimizeOnClose,
    hotkey: currentHotkey,
    lastSeenVersion: windowState.lastSeenVersion || null
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const bounds = mainWindow.getBounds();
      return { ...bounds, isMaximized: mainWindow.isMaximized(), ...base };
    } catch {}
  }
  const prev = windowState || {};
  return { width: prev.width, height: prev.height, x: prev.x, y: prev.y, isMaximized: prev.isMaximized === true, ...base };
}

const saveWindowState = debounce(() => {
  try {
    const state = buildState();
    const json = JSON.stringify(state);
    if (json === lastSavedState) return;
    lastSavedState = json;
    windowState = state;
    fs.writeFile(stateFile, json, () => {});
  } catch {}
}, 500);

function saveWindowStateSync() {
  try {
    const state = buildState();
    windowState = state;
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════
//  Domain-Validierung
// ═══════════════════════════════════════════════════════════════════

const domainCache = new Map();

function isAllowedDomain(url) {
  let r = domainCache.get(url);
  if (r !== undefined) return r;
  try { const h = new URL(url).hostname; r = h === 'claude.ai' || h.endsWith('.claude.ai'); }
  catch { r = false; }
  if (domainCache.size >= DOMAIN_CACHE_MAX) domainCache.delete(domainCache.keys().next().value);
  domainCache.set(url, r);
  return r;
}

function isOAuthDomain(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'accounts.google.com' || h === 'oauth2.googleapis.com'
      || h === 'github.com' || h === 'www.github.com'
      || h === 'drive.google.com' || h === 'docs.google.com'
      || h === 'login.microsoftonline.com'
      || h === 'gitlab.com' || h === 'bitbucket.org'
      || h.endsWith('.auth0.com') || h.endsWith('.claude.ai');
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════
//  Theme & Design
// ═══════════════════════════════════════════════════════════════════

const THEME = {
  dark:  { bg: '#262624', bgHover: '#333330', bgActive: '#3a3a37', text: '#9a9a96', textActive: '#e8e8e4', border: '#333330' },
  light: { bg: '#f5f2ef', bgHover: '#ede9e4', bgActive: '#faf8f6', text: '#8a7e72', textActive: '#2a2420', border: '#e8e4de' }
};

const ACCENT = {
  custom:   { from: '#F26A3F', to: '#E83B6E' },
  original: { from: '#d4734c', to: '#d4734c' }
};

function theme()  { return isDarkMode ? THEME.dark : THEME.light; }
function accent() { return customDesign ? ACCENT.custom : ACCENT.original; }
function icon()   { return path.join(__dirname, customDesign ? 'icon.png' : 'icon-original.png'); }

const _iconDataUrlCache = {};
function iconDataUrl() {
  const p = icon();
  if (_iconDataUrlCache[p]) return _iconDataUrlCache[p];
  try {
    const b64 = fs.readFileSync(p).toString('base64');
    _iconDataUrlCache[p] = `data:image/png;base64,${b64}`;
  } catch { _iconDataUrlCache[p] = ''; }
  return _iconDataUrlCache[p];
}

// ═══════════════════════════════════════════════════════════════════
//  Tab-Bar HTML
// ═══════════════════════════════════════════════════════════════════

let _tabBarCache = '';
let _tabBarKey = '';

function getTabBarHTML() {
  const key = `${isDarkMode}:${customDesign}`;
  if (key === _tabBarKey && _tabBarCache) return _tabBarCache;
  _tabBarKey = key;
  const th = theme();
  const a = accent();

  _tabBarCache = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
:root{--bg:${th.bg};--bgh:${th.bgHover};--bga:${th.bgActive};--t:${th.text};--ta:${th.textActive};--bd:${th.border};
  --ac-from:${a.from};--ac-to:${a.to}}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  color:var(--t);overflow:hidden;user-select:none;-webkit-app-region:drag;
  height:${TAB_BAR_HEIGHT}px;display:flex;align-items:flex-end;border-bottom:1px solid var(--bd);contain:layout style}
#tabs{display:flex;align-items:flex-end;height:100%;flex:1;padding:0 8px;gap:2px;
  -webkit-app-region:no-drag;overflow-x:auto}
#tabs::-webkit-scrollbar{height:0}
.tab{display:flex;align-items:center;height:34px;padding:0 14px;border-radius:10px 10px 0 0;
  cursor:pointer;white-space:nowrap;max-width:220px;min-width:60px;gap:8px;
  position:relative;color:var(--t);transition:background .15s,color .15s;contain:layout style}
.tab:hover{background:linear-gradient(180deg,transparent,var(--bgh));color:var(--ta)}
.tab.active{background:var(--bga);color:var(--ta);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ac-from) 18%,transparent)}
.tab.active::after{content:'';position:absolute;bottom:0;left:10px;right:10px;height:2.5px;
  background:linear-gradient(90deg,var(--ac-from),var(--ac-to));border-radius:2px 2px 0 0;
  box-shadow:0 0 8px color-mix(in srgb,var(--ac-from) 45%,transparent)}
.tab-title{flex:1;overflow:hidden;text-overflow:ellipsis}
.tab-close{width:18px;height:18px;border-radius:6px;display:flex;align-items:center;justify-content:center;
  font-size:15px;line-height:1;opacity:0;flex-shrink:0;transition:opacity .1s,background .1s}
.tab:hover .tab-close{opacity:.5}
.tab-close:hover{opacity:1!important;background:linear-gradient(135deg,var(--ac-from),var(--ac-to));color:#fff}
.controls{display:flex;align-items:center;gap:4px;padding:0 6px 6px;-webkit-app-region:no-drag}
.ctrl-btn{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;color:var(--ta);font-size:16px;opacity:.85;transition:all .15s;border:1px solid transparent}
.ctrl-btn:hover{background:color-mix(in srgb,var(--ac-from) 12%,transparent);
  border-color:color-mix(in srgb,var(--ac-from) 35%,transparent);color:var(--ac-from);opacity:1}
.ctrl-btn svg{width:16px;height:16px}
#new-tab{background:linear-gradient(135deg,var(--ac-from),var(--ac-to));color:#fff;opacity:1;
  box-shadow:0 2px 8px color-mix(in srgb,var(--ac-from) 35%,transparent)}
#new-tab:hover{background:linear-gradient(135deg,var(--ac-from),var(--ac-to));color:#fff;
  border-color:transparent;filter:brightness(1.08)}
.design-pill{padding:2px 11px;height:22px;border-radius:11px;font-size:10px;font-weight:600;
  letter-spacing:.4px;text-transform:uppercase;display:flex;align-items:center;cursor:pointer;
  background:var(--bgh);color:var(--t);transition:all .15s;-webkit-app-region:no-drag;margin-right:4px;
  border:1px solid var(--bd)}
.design-pill:hover{background:linear-gradient(135deg,var(--ac-from),var(--ac-to));color:#fff;border-color:transparent}
</style></head><body>
<div id="tabs"></div>
<div class="controls">
  <div class="design-pill" id="design-toggle" title="${t('Design wechseln', 'Toggle design')}">${customDesign ? 'Modern' : 'Classic'}</div>
  <div class="ctrl-btn" id="bug-report" title="${(bugReportStrings[sysLang] || bugReportStrings.en).title}">
    <svg viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </div>
  <div class="ctrl-btn" id="theme-toggle" title="${t('Theme wechseln', 'Toggle theme')}">
    <svg id="theme-icon-dark" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    <svg id="theme-icon-light" viewBox="0 0 24 24" style="display:none"><circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
  </div>
  <div class="ctrl-btn" id="new-tab" title="${t('Neuer Tab', 'New Tab')} (Ctrl+T)">
    <svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>
  </div>
</div>
<script>
const tabsEl=document.getElementById('tabs');
let tabEls=[];
document.getElementById('new-tab').addEventListener('click',()=>window.tabAPI.newTab());
document.getElementById('theme-toggle').addEventListener('click',()=>window.tabAPI.toggleTheme());
document.getElementById('design-toggle').addEventListener('click',()=>window.tabAPI.toggleDesign());
document.getElementById('bug-report').addEventListener('click',()=>window.tabAPI.bugReport());

window.tabAPI.onDesignUpdate(custom=>{
  document.getElementById('design-toggle').textContent=custom?'Modern':'Classic';
});

window.tabAPI.onTabsUpdate(data=>{
  const c=data.tabs.length;
  while(tabEls.length>c)tabsEl.removeChild(tabEls.pop());
  for(let i=0;i<c;i++){
    let el=tabEls[i];
    if(!el){
      el=document.createElement('div');el.className='tab';
      el.innerHTML='<span class="tab-title"></span><span class="tab-close">&times;</span>';
      el.addEventListener('click',e=>{
        const idx=tabEls.indexOf(el);
        if(e.target.classList.contains('tab-close'))window.tabAPI.closeTab(idx);
        else window.tabAPI.switchTab(idx);
      });
      tabsEl.appendChild(el);tabEls.push(el);
    }
    const ts=el.firstChild,title=data.tabs[i].title;
    if(ts.textContent!==title)ts.textContent=title;
    const a=i===data.activeIndex;
    if(el.classList.contains('active')!==a)el.classList.toggle('active',a);
    el.lastChild.style.display=c>1?'':'none';
  }
});

window.tabAPI.onThemeUpdate(dark=>{
  const r=document.documentElement.style;
  if(dark){
    r.setProperty('--bg','#262624');r.setProperty('--bgh','#333330');r.setProperty('--bga','#3a3a37');
    r.setProperty('--t','#9a9a96');r.setProperty('--ta','#e8e8e4');r.setProperty('--bd','#333330');
  }else{
    r.setProperty('--bg','#f5f2ef');r.setProperty('--bgh','#ede9e4');r.setProperty('--bga','#faf8f6');
    r.setProperty('--t','#8a7e72');r.setProperty('--ta','#2a2420');r.setProperty('--bd','#e8e4de');
  }
  document.body.style.background=dark?'#262624':'#f5f2ef';
  document.getElementById('theme-icon-dark').style.display=dark?'':'none';
  document.getElementById('theme-icon-light').style.display=dark?'none':'';
});
</script></body></html>`;
  return _tabBarCache;
}

// ═══════════════════════════════════════════════════════════════════
//  Tab-Bar Sync (IPC → Renderer)
// ═══════════════════════════════════════════════════════════════════

const sendTabsUpdate = throttle(() => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tabs-update', {
    tabs: tabs.map((tab, i) => ({ title: tab.title || `Tab ${i + 1}` })),
    activeIndex: activeTabIndex
  });
}, 100);

function sendThemeUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('theme-update', isDarkMode);
}

function sendDesignUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('design-update', customDesign);
}

// ═══════════════════════════════════════════════════════════════════
//  Script-Injection
// ═══════════════════════════════════════════════════════════════════

function injectScripts(wc) {
  if (!alive(wc)) return;
  if (customDesign) wc.executeJavaScript(BRAND_SCRIPT).catch(() => {});
}

function reinjectScripts(wc) {
  if (!alive(wc)) return;
  if (!customDesign) return;
  // Nur re-injizieren wenn Brand-Script nicht mehr aktiv ist (z.B. nach Full-Navigation)
  wc.executeJavaScript('!!window._cdBrand').then(active => {
    if (!active) injectScripts(wc);
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
//  View Setup (Security + Events)
// ═══════════════════════════════════════════════════════════════════

function setupView(view) {
  const wc = view.webContents;

  // ── Window-Open: OAuth in-app, claude.ai erlaubt, Rest extern ──
  wc.setWindowOpenHandler(({ url }) => {
    if (isOAuthDomain(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 600, height: 750, title: t('Anmeldung', 'Sign In'),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:claude' }
      }};
    }
    if (isAllowedDomain(url)) return { action: 'allow' };
    try {
      const p = new URL(url).protocol;
      if (p === 'https:' || p === 'http:' || p === 'mailto:') shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });

  // ── OAuth-Popup Lifecycle ──
  wc.on('did-create-window', (childWindow) => {
    let closed = false;
    const cleanup = () => {
      if (closed || childWindow.isDestroyed()) return;
      closed = true;
      childWindow.webContents.off('will-navigate', onNav);
      childWindow.webContents.off('will-redirect', onRedirect);
      childWindow.webContents.off('did-navigate', onDidNav);
      childWindow.close();
    };
    const onNav = (event, navUrl) => {
      if (closed) return;
      if (!isOAuthDomain(navUrl) && !isAllowedDomain(navUrl)) {
        try { const p = new URL(navUrl).protocol; if (p !== 'https:' && p !== 'http:') event.preventDefault(); }
        catch { event.preventDefault(); }
      }
    };
    const onRedirect = (_event, navUrl) => { if (isAllowedDomain(navUrl)) cleanup(); };
    const onDidNav = (_event, navUrl) => { if (isAllowedDomain(navUrl)) cleanup(); };

    childWindow.webContents.on('will-navigate', onNav);
    childWindow.webContents.on('will-redirect', onRedirect);
    childWindow.webContents.on('did-navigate', onDidNav);
  });

  // ── Navigation Guards ──
  wc.on('will-navigate', (event, navUrl) => {
    if (!isAllowedDomain(navUrl) && !isOAuthDomain(navUrl)) event.preventDefault();
  });

  wc.on('will-frame-navigate', (event) => {
    const navUrl = event.url;
    if (!isAllowedDomain(navUrl) && !isOAuthDomain(navUrl)) event.preventDefault();
  });

  // ── Tab-Titel ──
  wc.on('page-title-updated', (e, title) => {
    e.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`Claude v${version}`);
    const idx = tabs.findIndex(tab => tab.view === view);
    if (idx >= 0) {
      const clean = title.replace(/\s*[-\u2013]\s*Claude.*$/, '') || t('Neuer Chat', 'New Chat');
      if (tabs[idx].title !== clean) { tabs[idx].title = clean; sendTabsUpdate(); }
    }
  });

  // ── Script-Injection bei Page-Load ──
  wc.on('did-finish-load', () => {
    updateTitle();
    injectScripts(wc);
  });

  // ── SPA-Navigation (Chat-Wechsel): Scripts re-injizieren ──
  wc.on('did-navigate-in-page', () => reinjectScripts(wc));

  // ── Crash-Recovery ──
  wc.on('render-process-gone', (_, details) => {
    if (details.reason === 'clean-exit' || wc.isDestroyed()) return;
    const tab = tabs.find(tb => tb.view === view);
    if (!tab) return;
    tab.crashCount = (tab.crashCount || 0) + 1;
    if (tab.crashCount > MAX_CRASH_RELOADS) {
      console.error(`Tab crashed ${tab.crashCount}x (${details.reason}), giving up.`);
      return;
    }
    console.error(`Tab crashed (${details.reason}), reload ${tab.crashCount}/${MAX_CRASH_RELOADS}...`);
    setTimeout(() => { if (alive(wc)) wc.reload(); }, 300);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  View-Erstellung + Pool
// ═══════════════════════════════════════════════════════════════════

function createContentView() {
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      partition: 'persist:claude',
      backgroundThrottling: true,
      spellcheck: false,
    }
  });
  view.setBackgroundColor(theme().bg);
  view.setVisible(false);
  view.webContents.setUserAgent(chromeUA);
  return view;
}

function drainPool() {
  while (viewPool.length > 0) {
    const v = viewPool.pop();
    if (alive(v)) v.webContents.close();
  }
}

function fillPool() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  while (viewPool.length < POOL_SIZE) {
    const view = createContentView();
    setupView(view);
    view.webContents.loadURL('https://claude.ai');
    viewPool.push(view);
  }
}

function getPooledView() {
  if (viewPool.length > 0) {
    const view = viewPool.shift();
    setTimeout(fillPool, 3000);
    return view;
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════════
//  Tab-Operationen
// ═══════════════════════════════════════════════════════════════════

function createTab(url = 'https://claude.ai') {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  let view = (url === 'https://claude.ai') ? getPooledView() : null;
  if (!view) {
    view = createContentView();
    setupView(view);
    view.webContents.loadURL(url);
  }

  mainWindow.contentView.addChildView(view);
  tabs.push({ view, title: t('Neuer Chat', 'New Chat'), url, crashCount: 0 });
  switchToTab(tabs.length - 1);
  updateMenu();
  return tabs[tabs.length - 1];
}

let lastViewBounds = '';

function throttleActiveView(throttleOn) {
  const active = tabs[activeTabIndex];
  if (!active || !alive(active.view)) return;
  try {
    active.view.webContents.setBackgroundThrottling(throttleOn);
    if (typeof active.view.webContents.setFrameRate === 'function') {
      active.view.webContents.setFrameRate(throttleOn ? 10 : 60);
    }
  } catch {}
}

const resizeActiveView = throttle(() => {
  if (!mainWindow || mainWindow.isDestroyed() || !tabs[activeTabIndex]) return;
  const b = mainWindow.getContentBounds();
  const key = `${b.width}:${b.height}`;
  if (key === lastViewBounds) return;
  lastViewBounds = key;
  tabs[activeTabIndex].view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width: b.width, height: b.height - TAB_BAR_HEIGHT });
}, 16);

function switchToTab(index) {
  if (index < 0 || index >= tabs.length || !mainWindow || mainWindow.isDestroyed()) return;
  const target = tabs[index];
  if (!alive(target.view)) return;

  if (index === activeTabIndex && target.view.getVisible()) {
    sendTabsUpdate();
    return;
  }

  // Alten Tab verstecken
  const prev = tabs[activeTabIndex];
  if (prev && alive(prev.view)) {
    prev.view.setVisible(false);
    prev.view.webContents.setBackgroundThrottling(true);
  }

  activeTabIndex = index;

  target.view.setVisible(true);
  target.view.webContents.setBackgroundThrottling(false);
  if (target.needsReload) { target.needsReload = false; target.view.webContents.reload(); }

  lastViewBounds = '';
  resizeActiveView();
  updateTitle();
  updateMenu();
  sendTabsUpdate();
}

function closeTab(index) {
  if (tabs.length <= 1 || index < 0 || index >= tabs.length) return;
  const tab = tabs[index];
  mainWindow.contentView.removeChildView(tab.view);

  if (activeTabIndex === index) {
    const newIdx = index > 0 ? index - 1 : 0;
    tabs.splice(index, 1);
    activeTabIndex = Math.min(newIdx, tabs.length - 1);
    switchToTab(activeTabIndex);
  } else {
    tabs.splice(index, 1);
    if (activeTabIndex > index) activeTabIndex--;
    if (activeTabIndex >= tabs.length) activeTabIndex = tabs.length - 1;
  }

  setImmediate(() => {
    if (alive(tab.view)) {
      tab.view.webContents.removeAllListeners();
      tab.view.webContents.close();
    }
  });
  updateMenu();
  sendTabsUpdate();
}

function updateTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const title = `Claude v${version}`;
  if (mainWindow.getTitle() !== title) mainWindow.setTitle(title);
}

// ═══════════════════════════════════════════════════════════════════
//  Design-Toggle
// ═══════════════════════════════════════════════════════════════════

function toggleDesign() {
  customDesign = !customDesign;

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(icon());
  if (tray) {
    try {
      const img = nativeImage.createFromPath(icon());
      tray.setImage(img.isEmpty() ? icon() : img);
    } catch {}
  }
  try { fs.copyFileSync(icon(), path.join(app.getPath('home'), 'Apps', 'claude-desktop-icon.png')); } catch {}

  drainPool();

  // Tab-Bar mit neuem Design neu laden
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getTabBarHTML()));
    mainWindow.webContents.once('did-finish-load', () => {
      sendTabsUpdate();
      sendThemeUpdate();
      sendDesignUpdate();
    });
  }

  // Aktiven Tab neu laden, Rest lazy
  if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view)) {
    tabs[activeTabIndex].view.webContents.reload();
  }
  tabs.forEach((tab, i) => { if (i !== activeTabIndex) tab.needsReload = true; });

  setTimeout(fillPool, 3000);
  saveWindowState();
  updateMenu(true);
}

// ═══════════════════════════════════════════════════════════════════
//  Bug-Report-Dialog
// ═══════════════════════════════════════════════════════════════════

const BUG_EMAIL = 'claudeai.desktop.linux@gmail.com';

function showBugReportDialog() {
  const s = bugReportStrings[sysLang] || bugReportStrings.en;
  const dark = isDarkMode;
  const bg = dark ? '#1a1a18' : '#faf8f6';
  const fg = dark ? '#e8e0d8' : '#2a2420';
  const sub = dark ? '#9a9a96' : '#8a7e72';
  const btnBg = '#E8524F';

  const brSize = { width: 420, height: 260 };
  const brPos = centerOnMainDisplay(brSize.width, brSize.height);
  const win = new BrowserWindow({
    ...brSize, ...brPos, resizable: false,
    parent: mainWindow, modal: true,
    title: s.title, icon: icon(),
    backgroundColor: bg,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  win.setMenuBarVisibility(false);

  const html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:${bg};color:${fg};font-family:system-ui,sans-serif;display:flex;flex-direction:column;
  align-items:center;justify-content:center;height:100vh;padding:24px;text-align:center}
h2{font-size:18px;font-weight:600;margin-bottom:12px}
p{color:${sub};font-size:13px;line-height:1.6;white-space:pre-line;margin-bottom:16px}
.email{font-size:15px;font-weight:600;color:${fg};margin-bottom:20px;word-break:break-all}
button{background:${btnBg};color:#fff;border:none;padding:10px 28px;border-radius:10px;
  font-size:14px;cursor:pointer;font-weight:500;transition:background .15s}
button:hover{background:#F0635C}
</style></head><body>
<h2>${s.title}</h2>
<p>${s.body}</p>
<div class="email">${BUG_EMAIL}</div>
<button onclick="navigator.clipboard.writeText('${BUG_EMAIL}').then(()=>{this.textContent='${s.copied}';setTimeout(()=>this.textContent='${s.btn}',1500)})">${s.btn}</button>
</body></html>`;

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

// ═══════════════════════════════════════════════════════════════════
//  Tray, Hintergrund-Modus, globaler Hotkey
// ═══════════════════════════════════════════════════════════════════

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()) mainWindow.hide();
  else showMainWindow();
}

function openNewChatFromHotkey() {
  showMainWindow();
  createTab('https://claude.ai/new');
}

function getQuickPromptHTML() {
  const th = theme();
  const ac = accent();
  const i18n = {
    placeholder: t('Frage an Claude\u2026', 'Ask Claude\u2026'),
    hint: t('Enter zum Senden \u00b7 Shift+Enter neue Zeile \u00b7 Esc abbrechen', 'Enter to send \u00b7 Shift+Enter new line \u00b7 Esc to cancel')
  };
  const logoUrl = iconDataUrl();
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:transparent;color:${th.textActive};font-family:system-ui,-apple-system,sans-serif;font-size:14px;overflow:hidden}
body{padding:10px}
@keyframes gradShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
.frame{height:100%;border-radius:12px;padding:2px;
  background:linear-gradient(135deg,${ac.from},${ac.to},${ac.from},${ac.to});
  background-size:300% 300%;
  animation:gradShift 6s ease-in-out infinite}
.inner{height:100%;background:${th.bg};border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.wrap{flex:1;display:flex;align-items:flex-start;gap:12px}
.logo{width:28px;height:28px;flex-shrink:0;border-radius:7px;margin-top:4px;object-fit:contain;
  box-shadow:0 2px 8px color-mix(in srgb,${ac.from} 40%,transparent)}
textarea{flex:1;background:transparent;border:none;outline:none;resize:none;color:${th.textActive};font-family:inherit;font-size:15px;line-height:1.5;min-height:60px;padding:4px 0}
textarea::placeholder{color:${th.text}}
.hint{color:${th.text};font-size:11px;text-align:right}
</style></head><body>
<div class="frame"><div class="inner">
<div class="wrap">
  <img class="logo" src="${logoUrl}" alt="Claude"/>
  <textarea id="q" placeholder="${i18n.placeholder}" autofocus></textarea>
</div>
<div class="hint">${i18n.hint}</div>
</div></div>
<script>
const api = window.quickPromptAPI;
const q = document.getElementById('q');
q.focus();
q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); api.cancel(); return; }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const v = q.value.trim();
    if (v.length === 0) { api.cancel(); return; }
    api.submit(v);
  }
});
</script>
</body></html>`;
}

function openQuickPrompt() {
  if (quickPromptWindow && !quickPromptWindow.isDestroyed()) {
    quickPromptWindow.show();
    quickPromptWindow.focus();
    return;
  }
  const qpSize = { width: 600, height: 160 };
  const qpPos = centerOnMainDisplay(qpSize.width, qpSize.height);
  quickPromptWindow = new BrowserWindow({
    ...qpSize, ...qpPos,
    frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    transparent: true, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-quickprompt.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      spellcheck: false
    }
  });
  quickPromptWindow.setMenu(null);
  quickPromptWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getQuickPromptHTML()));
  quickPromptWindow.once('ready-to-show', () => {
    if (!quickPromptWindow || quickPromptWindow.isDestroyed()) return;
    quickPromptWindow.show();
    quickPromptWindow.focus();
  });
  quickPromptWindow.on('blur', () => {
    if (quickPromptWindow && !quickPromptWindow.isDestroyed()) quickPromptWindow.close();
  });
  quickPromptWindow.on('closed', () => { quickPromptWindow = null; });
}

function submitQuickPrompt(text) {
  if (typeof text !== 'string') return;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 8000) return;
  showMainWindow();
  const tab = createTab('https://claude.ai/new');
  if (!tab || !alive(tab.view)) return;
  const wc = tab.view.webContents;
  const escaped = JSON.stringify(trimmed);
  const inject = () => {
    wc.executeJavaScript(`(function(){
      const prompt = ${escaped};
      let attempts = 0;
      const tryFill = () => {
        attempts++;
        if (attempts > 80) return;
        const el = document.querySelector('div[contenteditable="true"].ProseMirror') || document.querySelector('div[contenteditable="true"]') || document.querySelector('.ProseMirror');
        if (!el) { setTimeout(tryFill, 150); return; }
        try {
          el.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, prompt);
        } catch(e) {}
        setTimeout(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const btn = btns.find(b => {
            const a = (b.getAttribute('aria-label') || '').toLowerCase();
            return a.includes('send') || a.includes('senden') || a.includes('abschicken');
          });
          if (btn && !btn.disabled) { btn.click(); return; }
          const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
          (el || document.activeElement).dispatchEvent(enter);
        }, 250);
      };
      tryFill();
    })();`).catch(() => {});
  };
  wc.once('did-finish-load', inject);
}

function centerOnMainDisplay(width, height) {
  try {
    let display;
    if (mainWindow && !mainWindow.isDestroyed()) {
      display = screen.getDisplayMatching(mainWindow.getBounds());
    } else {
      display = screen.getPrimaryDisplay();
    }
    const wa = display.workArea;
    return {
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: Math.round(wa.y + (wa.height - height) / 2)
    };
  } catch {
    return {};
  }
}

function setupTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(icon());
    tray = new Tray(img.isEmpty() ? icon() : img);
    if (!img.isEmpty()) tray.setImage(img);
    tray.setToolTip('Claude');
    tray.on('click', toggleMainWindow);
    updateTrayMenu();
  } catch (e) {
    tray = null;
  }
}

function updateTrayMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: t('\u00d6ffnen', 'Open'), click: showMainWindow },
      { label: t('Neuer Chat', 'New Chat'), click: openNewChatFromHotkey },
      { type: 'separator' },
      { label: t('App-Einstellungen\u2026', 'App Settings\u2026'), click: () => openSettingsWindow() },
      { type: 'separator' },
      { label: t('Beenden', 'Quit'), click: () => { isQuitting = true; app.quit(); } }
    ]));
  } catch {}
}

function registerHotkey(accel) {
  if (currentHotkey) {
    try { globalShortcut.unregister(currentHotkey); } catch {}
  }
  currentHotkey = null;
  if (!accel || typeof accel !== 'string') return true;
  try {
    const ok = globalShortcut.register(accel, openQuickPrompt);
    if (ok) { currentHotkey = accel; return true; }
  } catch {}
  return false;
}

function getSettingsHTML() {
  const th = theme();
  const ac = accent();
  const i18n = {
    title: t('Einstellungen', 'Settings'),
    subtitle: t('Hintergrund-Modus und globaler Hotkey', 'Background mode and global hotkey'),
    minimizeLabel: t('Beim Schlie\u00dfen in den Hintergrund minimieren', 'Minimize to tray on close'),
    minimizeHint: t('Claude bleibt im Hintergrund erreichbar \u2013 \u00fcber das Tray-Symbol oder den Hotkey unten.', 'Claude stays reachable in the background \u2013 via the tray icon or the hotkey below.'),
    hotkeyLabel: t('Globaler Hotkey (neuer Chat)', 'Global hotkey (new chat)'),
    press: t('Klick hier und dr\u00fccke eine Tastenkombination', 'Click here and press a key combination'),
    pressing: t('Dr\u00fccke die gew\u00fcnschte Tastenkombination\u2026', 'Press your key combination\u2026'),
    clear: t('L\u00f6schen', 'Clear'),
    close: t('Schlie\u00dfen', 'Close'),
    registered: t('Hotkey registriert.', 'Hotkey registered.'),
    failed: t('Diese Kombination konnte nicht registriert werden (evtl. systemweit belegt).', 'Could not register this combination (may already be in use).'),
    removed: t('Hotkey entfernt.', 'Hotkey removed.'),
    needMod: t('Bitte mindestens eine Modifikator-Taste (Strg/Alt/Shift) verwenden.', 'Please use at least one modifier key (Ctrl/Alt/Shift).')
  };
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*{box-sizing:border-box}
body{margin:0;padding:22px;background:${th.bg};color:${th.textActive};font-family:system-ui,-apple-system,sans-serif;font-size:14px;user-select:none}
h1{font-size:17px;margin:0 0 4px;font-weight:600}
.sub{color:${th.text};font-size:12px;margin-bottom:18px}
.row{margin:14px 0}
label{display:block;margin-bottom:6px;font-weight:500}
.chk{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-weight:500}
.chk input{margin-top:2px;accent-color:${ac.from}}
.hint{color:${th.text};font-size:12px;margin-top:4px;margin-left:24px;line-height:1.5}
.hotkey{display:flex;gap:8px;align-items:center}
.capture{flex:1;padding:10px 12px;background:${th.bgHover};border:1px solid ${th.border};border-radius:6px;font-family:monospace;cursor:pointer;color:${th.textActive};outline:none;min-height:38px;display:flex;align-items:center}
.capture.listening{border-color:${ac.from};background:${th.bgActive}}
button{background:linear-gradient(135deg,${ac.from},${ac.to});color:#fff;border:none;padding:9px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500}
button.secondary{background:${th.bgHover};color:${th.textActive};border:1px solid ${th.border}}
button:hover{filter:brightness(1.05)}
.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:22px}
.status{color:${th.text};font-size:12px;margin-top:6px;min-height:16px}
</style></head><body>
<h1>${i18n.title}</h1>
<div class="sub">${i18n.subtitle}</div>

<div class="row">
  <label class="chk"><input type="checkbox" id="mc"><span>${i18n.minimizeLabel}</span></label>
  <div class="hint">${i18n.minimizeHint}</div>
</div>

<div class="row">
  <label>${i18n.hotkeyLabel}</label>
  <div class="hotkey">
    <div class="capture" id="cap" tabindex="0">${i18n.press}</div>
    <button class="secondary" id="clear">${i18n.clear}</button>
  </div>
  <div class="status" id="status"></div>
</div>

<div class="actions">
  <button id="close">${i18n.close}</button>
</div>

<script>
const I = ${JSON.stringify(i18n)};
const api = window.settingsAPI;
const mc = document.getElementById('mc');
const cap = document.getElementById('cap');
const clearBtn = document.getElementById('clear');
const closeBtn = document.getElementById('close');
const status = document.getElementById('status');
let listening = false;
let currentDisplay = I.press;

function resetCapture() {
  listening = false;
  cap.classList.remove('listening');
  cap.textContent = currentDisplay;
}

api.get().then(s => {
  mc.checked = !!s.minimizeOnClose;
  if (s.hotkey) { currentDisplay = s.hotkey; cap.textContent = s.hotkey; }
});

mc.addEventListener('change', () => api.setMinimize(mc.checked));

cap.addEventListener('click', () => {
  listening = true;
  cap.classList.add('listening');
  cap.textContent = I.pressing;
  status.textContent = '';
  cap.focus();
});

cap.addEventListener('blur', () => { if (listening) resetCapture(); });

cap.addEventListener('keydown', (e) => {
  if (!listening) return;
  e.preventDefault();
  const k = e.key;
  if (k === 'Escape') { resetCapture(); return; }
  if (['Control','Shift','Alt','Meta','Dead','Unidentified'].includes(k)) return;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (parts.length === 0) { status.textContent = I.needMod; return; }
  let key = k;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  const accel = parts.join('+');
  api.setHotkey(accel).then(ok => {
    if (ok) { currentDisplay = accel; status.textContent = I.registered; }
    else { status.textContent = I.failed; }
    resetCapture();
  });
});

clearBtn.addEventListener('click', () => {
  api.setHotkey(null).then(() => {
    currentDisplay = I.press;
    cap.textContent = I.press;
    status.textContent = I.removed;
  });
});

closeBtn.addEventListener('click', () => api.close());
</script>
</body></html>`;
}

function getWhatsNewHTML() {
  const th = theme();
  const ac = accent();
  const notes = RELEASE_NOTES[version] || [];
  const icons = {
    tray: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="3"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 2 4 14 12 14 11 22 20 10 12 10 13 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
  };
  const i18n = {
    header: t('Neu in Claude v' + version, 'New in Claude v' + version),
    sub: t('Ein kurzer \u00dcberblick \u00fcber die wichtigsten \u00c4nderungen', 'A quick look at the highlights'),
    close: t('Los geht\u2019s', 'Let\u2019s go'),
    openSettings: t('App-Einstellungen \u00f6ffnen', 'Open app settings')
  };
  const items = notes.map(n => `
    <div class="item">
      <div class="ic">${icons[n.icon] || icons.check}</div>
      <div>
        <div class="it">${n.title}</div>
        <div class="ix">${n.text}</div>
      </div>
    </div>`).join('');
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:${th.bg};color:${th.textActive};font-family:system-ui,-apple-system,sans-serif;font-size:14px;user-select:none}
body{display:flex;flex-direction:column;overflow:hidden}
.hero{position:relative;padding:28px 28px 24px;background:linear-gradient(135deg,${ac.from},${ac.to});color:#fff;overflow:hidden}
.hero::before{content:'';position:absolute;right:-60px;top:-60px;width:200px;height:200px;border-radius:50%;background:rgba(255,255,255,.12)}
.hero::after{content:'';position:absolute;right:30px;bottom:-40px;width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,.08)}
.badge{display:inline-block;background:rgba(255,255,255,.2);padding:4px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;margin-bottom:10px;position:relative;z-index:1}
h1{font-size:22px;font-weight:700;position:relative;z-index:1;margin-bottom:6px}
.hs{font-size:13px;opacity:.9;position:relative;z-index:1}
.body{flex:1;padding:22px 28px;overflow-y:auto;display:flex;flex-direction:column;gap:16px}
.body::-webkit-scrollbar{width:8px}
.body::-webkit-scrollbar-thumb{background:${th.border};border-radius:4px}
.item{display:flex;gap:14px;align-items:flex-start}
.ic{width:36px;height:36px;flex-shrink:0;border-radius:9px;background:${th.bgHover};border:1px solid ${th.border};display:flex;align-items:center;justify-content:center;color:${ac.from}}
.ic svg{width:18px;height:18px}
.it{font-weight:600;font-size:14px;margin-bottom:2px}
.ix{color:${th.text};font-size:12px;line-height:1.5}
.footer{padding:16px 28px 20px;display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid ${th.border}}
button{background:linear-gradient(135deg,${ac.from},${ac.to});color:#fff;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600}
button.secondary{background:${th.bgHover};color:${th.textActive};border:1px solid ${th.border}}
button:hover{filter:brightness(1.05)}
</style></head><body>
<div class="hero">
  <div class="badge">v${version}</div>
  <h1>${i18n.header}</h1>
  <div class="hs">${i18n.sub}</div>
</div>
<div class="body">${items}</div>
<div class="footer">
  <button class="secondary" id="opts">${i18n.openSettings}</button>
  <button id="close">${i18n.close}</button>
</div>
<script>
document.getElementById('close').addEventListener('click', () => window.whatsNewAPI.close());
document.getElementById('opts').addEventListener('click', () => window.whatsNewAPI.openSettings());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') window.whatsNewAPI.close(); });
</script>
</body></html>`;
}

function openWhatsNewWindow() {
  if (whatsNewWindow && !whatsNewWindow.isDestroyed()) {
    whatsNewWindow.focus();
    return;
  }
  const size = { width: 520, height: 560 };
  const pos = centerOnMainDisplay(size.width, size.height);
  whatsNewWindow = new BrowserWindow({
    ...size, ...pos,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false, resizable: false, minimizable: false, maximizable: false,
    title: t('Neu in Claude', 'What\u2019s new in Claude'),
    backgroundColor: theme().bg,
    icon: icon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-whatsnew.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      spellcheck: false
    }
  });
  whatsNewWindow.setMenu(null);
  whatsNewWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getWhatsNewHTML()));
  whatsNewWindow.on('closed', () => { whatsNewWindow = null; });
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  const swSize = { width: 540, height: 440 };
  const swPos = centerOnMainDisplay(swSize.width, swSize.height);
  settingsWindow = new BrowserWindow({
    ...swSize, ...swPos,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false, resizable: false, minimizable: false, maximizable: false,
    title: t('Claude \u2013 Einstellungen', 'Claude \u2013 Settings'),
    backgroundColor: theme().bg,
    icon: icon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      spellcheck: false
    }
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getSettingsHTML()));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ═══════════════════════════════════════════════════════════════════
//  Menü
// ═══════════════════════════════════════════════════════════════════

let lastMenuHash = '';
let menuPending = false;

function updateMenu(force = false) {
  const hash = `${tabs.length}:${activeTabIndex}`;
  if (!force && hash === lastMenuHash) return;
  lastMenuHash = hash;
  if (menuPending) return;
  menuPending = true;

  setImmediate(() => {
    menuPending = false;

    const tabItems = tabs.map((_, i) => ({
      label: `Tab ${i + 1}${i === activeTabIndex ? ' \u25cf' : ''}`,
      accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
      click: () => switchToTab(i)
    }));

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Claude', submenu: [
        { label: t('Neuer Tab', 'New Tab'), accelerator: 'CmdOrCtrl+T', click: () => createTab() },
        { label: t('Tab schlie\u00dfen', 'Close Tab'), accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabIndex) },
        { type: 'separator' }, ...tabItems, { type: 'separator' },
        { label: t('Einstellungen', 'Settings'), accelerator: 'CmdOrCtrl+,', click: () => {
          if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view))
            tabs[activeTabIndex].view.webContents.loadURL('https://claude.ai/settings');
        }},
        { label: t('App-Einstellungen\u2026', 'App Settings\u2026'), click: () => openSettingsWindow() },
        { type: 'separator' },
        { label: `Design: ${customDesign ? 'Modern' : 'Classic'}`, click: toggleDesign },
        { label: t('Nach Updates suchen\u2026', 'Check for Updates\u2026'), click: () => {
          if (isDev) {
            dialog.showMessageBox(mainWindow, { type: 'info', title: 'Claude', message: t('Updates sind im Entwicklungsmodus deaktiviert.', 'Updates are disabled in development mode.') });
            return;
          }
          manualUpdateCheck = true;
          autoUpdater.checkForUpdates().catch(() => {});
        }},
        { label: (bugReportStrings[sysLang] || bugReportStrings.en).title, click: showBugReportDialog },
        { type: 'separator' },
        { role: 'quit', label: t('Beenden', 'Quit') }
      ]},
      { label: t('Bearbeiten', 'Edit'), submenu: [
        { role: 'undo', label: t('R\u00fcckg\u00e4ngig', 'Undo') },
        { role: 'redo', label: t('Wiederholen', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: t('Ausschneiden', 'Cut') },
        { role: 'copy', label: t('Kopieren', 'Copy') },
        { role: 'paste', label: t('Einf\u00fcgen', 'Paste') },
        { role: 'selectAll', label: t('Alles ausw\u00e4hlen', 'Select All') }
      ]},
      { label: t('Ansicht', 'View'), submenu: [
        { label: t('Neu laden', 'Reload'), accelerator: 'CmdOrCtrl+R', click: () => { if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view)) tabs[activeTabIndex].view.webContents.reload(); } },
        { label: t('Erzwungen neu laden', 'Force Reload'), accelerator: 'CmdOrCtrl+Shift+R', click: () => { if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view)) tabs[activeTabIndex].view.webContents.reloadIgnoringCache(); } },
        { type: 'separator' },
        { role: 'resetZoom', label: t('Zoom zur\u00fccksetzen', 'Reset Zoom') },
        { role: 'zoomIn', label: t('Vergr\u00f6\u00dfern', 'Zoom In') },
        { role: 'zoomOut', label: t('Verkleinern', 'Zoom Out') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('Vollbild', 'Fullscreen') },
        ...(isDev ? [{ type: 'separator' }, { label: 'DevTools', accelerator: 'F12', click: () => { if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view)) tabs[activeTabIndex].view.webContents.toggleDevTools(); } }] : [])
      ]},
      { label: 'Tabs', submenu: [
        { label: t('Neuer Tab', 'New Tab'), accelerator: 'CmdOrCtrl+T', click: () => createTab() },
        { label: t('Tab schlie\u00dfen', 'Close Tab'), accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabIndex) },
        { type: 'separator' },
        { label: t('N\u00e4chster Tab', 'Next Tab'), accelerator: 'CmdOrCtrl+Tab', click: () => switchToTab((activeTabIndex + 1) % tabs.length) },
        { label: t('Vorheriger Tab', 'Previous Tab'), accelerator: 'CmdOrCtrl+Shift+Tab', click: () => switchToTab((activeTabIndex - 1 + tabs.length) % tabs.length) },
        { type: 'separator' }, ...tabItems
      ]},
      { label: t('Fenster', 'Window'), submenu: [
        { role: 'minimize', label: t('Minimieren', 'Minimize') },
        { role: 'close', label: t('Schlie\u00dfen', 'Close') }
      ]}
    ]));
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Offline-Handling
// ═══════════════════════════════════════════════════════════════════

function handleOnlineChange(online) {
  if (online === isOnline) return;
  isOnline = online;
  updateTitle();
  if (!online) {
    showOfflinePage();
    new Notification({ title: 'Claude', body: t('Keine Internetverbindung.', 'No internet connection.') }).show();
  } else {
    if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view))
      tabs[activeTabIndex].view.webContents.reload();
    new Notification({ title: 'Claude', body: t('Verbindung wiederhergestellt!', 'Connection restored!') }).show();
  }
}

function showOfflinePage() {
  const tab = tabs[activeTabIndex];
  if (!tab || !alive(tab.view)) return;
  const th = theme();
  tab.view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<!DOCTYPE html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
    body{background:${th.bg};color:${th.textActive};font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}
    h1{font-size:22px;font-weight:600;margin-bottom:8px}
    p{color:${th.text};font-size:14px;max-width:360px;text-align:center;line-height:1.6}
    button{margin-top:20px;background:#E8524F;color:#fff;border:none;padding:10px 28px;border-radius:10px;font-size:14px;cursor:pointer;font-weight:500}
    button:hover{background:#F0635C}
    .pulse{animation:p 2s ease-in-out infinite}@keyframes p{0%,100%{opacity:.3}50%{opacity:1}}
    </style></head><body>
    <h1>${t('Keine Verbindung', 'No Connection')}</h1>
    <p>${t('Prüfe deine Netzwerkverbindung.', 'Check your network connection.')}</p>
    <p class="pulse" style="font-size:12px">${t('Automatische Wiederverbindung\u2026', 'Reconnecting automatically\u2026')}</p>
    <button onclick="location.href='https://claude.ai'">${t('Erneut versuchen', 'Try Again')}</button>
    </body></html>`
  ));
}

// ═══════════════════════════════════════════════════════════════════
//  Download-Manager
// ═══════════════════════════════════════════════════════════════════

function setupDownloadManager() {
  session.fromPartition('persist:claude').on('will-download', (_, item) => {
    const fileName = item.getFilename();
    const savePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: [{ name: t('Alle Dateien', 'All Files'), extensions: ['*'] }]
    });
    if (!savePath) { item.cancel(); return; }
    item.setSavePath(savePath);

    item.on('updated', (_, state) => {
      if (state === 'progressing' && !item.isPaused() && mainWindow && !mainWindow.isDestroyed()) {
        const total = item.getTotalBytes();
        if (total > 0) {
          const pct = Math.round((item.getReceivedBytes() / total) * 100);
          mainWindow.setTitle(`Claude \u2013 Download ${pct}%`);
          mainWindow.setProgressBar(pct / 100);
        }
      }
    });

    item.once('done', (_, state) => {
      if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.setProgressBar(-1); updateTitle(); }
      if (state === 'completed') new Notification({ title: t('Download fertig', 'Download complete'), body: fileName }).show();
      else if (state !== 'cancelled') new Notification({ title: t('Download fehlgeschlagen', 'Download failed'), body: fileName }).show();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Auto-Updater
// ═══════════════════════════════════════════════════════════════════

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
let manualUpdateCheck = false;

function setupAutoUpdater() {
  if (isDev) return;
  let failures = 0;

  const dialogParent = () => (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;

  autoUpdater.on('update-available', (info) => {
    failures = 0;
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      dialog.showMessageBox(dialogParent(), { type: 'info', title: t('Update verf\u00fcgbar', 'Update available'), message: `v${info.version} ${t('wird heruntergeladen\u2026', 'is downloading\u2026')}` });
    } else {
      new Notification({ title: t('Update verf\u00fcgbar', 'Update available'), body: `v${info.version} ${t('wird geladen\u2026', 'downloading\u2026')}` }).show();
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    failures = 0;
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      dialog.showMessageBox(dialogParent(), { type: 'info', title: t('Kein Update', 'No Update'), message: t('Du verwendest bereits die neueste Version.', 'You are already on the latest version.'), detail: `v${app.getVersion()}` });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(`Claude \u2013 Update ${Math.round(p.percent)}%`);
      mainWindow.setProgressBar(p.percent / 100);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.setTitle('Claude'); mainWindow.setProgressBar(-1); }
    if (dialog.showMessageBoxSync(dialogParent(), {
      type: 'info', title: t('Update bereit', 'Update ready'),
      message: `v${info.version} ${t('heruntergeladen. Jetzt neu starten?', 'downloaded. Restart now?')}`,
      buttons: [t('Neu starten', 'Restart'), t('Sp\u00e4ter', 'Later')], defaultId: 0
    }) === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    failures++;
    if (isDev) console.error(`Update-Fehler (${failures}x):`, err.message);
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      const short = (err.message || '').split('\n')[0].slice(0, 200);
      dialog.showMessageBox(dialogParent(), { type: 'error', title: t('Update-Fehler', 'Update Error'), message: t('Update-Pr\u00fcfung fehlgeschlagen.', 'Update check failed.'), detail: short });
    }
  });

  autoUpdater.checkForUpdates().catch(() => {});
  updateCheckInterval = setInterval(() => {
    if (failures > 0) {
      const skip = (1 << Math.min(failures, 5)) - 1;
      if (Math.random() < skip / (skip + 1)) return;
    }
    autoUpdater.checkForUpdates().catch(() => {});
  }, UPDATE_CHECK_MS);
}

// ═══════════════════════════════════════════════════════════════════
//  Session Security
// ═══════════════════════════════════════════════════════════════════

function setupSession() {
  const ses = session.fromPartition('persist:claude');
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']);

  ses.setPermissionRequestHandler((_, perm, cb) => cb(allowed.has(perm)));
  ses.setPermissionCheckHandler((_, perm) => allowed.has(perm));

  ses.setUserAgent(chromeUA);

  const chromeMajor = process.versions.chrome.split('.')[0];
  const secChUa = `"Chromium";v="${chromeMajor}", "Not(A:Brand";v="24", "Google Chrome";v="${chromeMajor}"`;

  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.claude.ai/*'] }, (details, cb) => {
    const h = details.requestHeaders;
    h['DNT'] = '1';
    h['Sec-Ch-Ua'] = secChUa;
    h['Sec-Ch-Ua-Mobile'] = '?0';
    h['Sec-Ch-Ua-Platform'] = '"Linux"';
    cb({ requestHeaders: h });
  });

  // Preconnect (mehr Sockets für schnellere erste Requests)
  ses.preconnect({ url: 'https://claude.ai', numSockets: 6 });
  ses.preconnect({ url: 'https://cdn.claude.ai', numSockets: 2 });
  ses.preconnect({ url: 'https://api.claude.ai', numSockets: 2 });
}

// ═══════════════════════════════════════════════════════════════════
//  IPC-Handler
// ═══════════════════════════════════════════════════════════════════

ipcMain.handle('settings-get', () => ({ minimizeOnClose, hotkey: currentHotkey }));
ipcMain.on('settings-minimize', (_, v) => {
  minimizeOnClose = v === true;
  saveWindowState();
});
const HOTKEY_RE = /^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\+)*[A-Za-z0-9]+$|^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\+)*(?:F1[0-9]?|F20|F[1-9]|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaPlayPause|PrintScreen|numdec|numadd|numsub|nummult|numdiv|num[0-9])$/;

ipcMain.handle('settings-hotkey', (_, accel) => {
  let value = null;
  if (typeof accel === 'string' && accel.length > 0 && accel.length < 64 && HOTKEY_RE.test(accel)) {
    value = accel;
  }
  const ok = registerHotkey(value);
  saveWindowState();
  return ok;
});
ipcMain.on('settings-close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

ipcMain.on('quickprompt-submit', (event, text) => {
  if (!quickPromptWindow || quickPromptWindow.isDestroyed() || event.sender !== quickPromptWindow.webContents) return;
  quickPromptWindow.close();
  if (typeof text !== 'string' || text.length > 8000) return;
  submitQuickPrompt(text);
});
ipcMain.on('quickprompt-cancel', (event) => {
  if (!quickPromptWindow || quickPromptWindow.isDestroyed() || event.sender !== quickPromptWindow.webContents) return;
  quickPromptWindow.close();
});

ipcMain.on('whatsnew-close', () => {
  if (whatsNewWindow && !whatsNewWindow.isDestroyed()) whatsNewWindow.close();
});
ipcMain.on('whatsnew-open-settings', () => {
  if (whatsNewWindow && !whatsNewWindow.isDestroyed()) whatsNewWindow.close();
  openSettingsWindow();
});

ipcMain.on('tab-new', () => createTab());
ipcMain.on('tab-switch', (_, i) => {
  if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < tabs.length) switchToTab(i);
});
ipcMain.on('tab-close', (_, i) => {
  if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < tabs.length) closeTab(i);
});
ipcMain.on('design-toggle', toggleDesign);
ipcMain.on('bug-report', showBugReportDialog);
ipcMain.on('theme-toggle', () => {
  isDarkMode = !isDarkMode;
  drainPool();

  const bg = theme().bg;
  const active = tabs[activeTabIndex]?.view;
  if (active && alive(active)) active.setBackgroundColor(bg);

  nativeTheme.themeSource = isDarkMode ? 'dark' : 'light';
  sendThemeUpdate();

  for (const tab of tabs) {
    if (tab.view !== active && alive(tab.view)) tab.view.setBackgroundColor(bg);
  }

  setTimeout(fillPool, 3000);
  saveWindowState();
});

// ═══════════════════════════════════════════════════════════════════
//  Fenster erstellen
// ═══════════════════════════════════════════════════════════════════

function createWindow() {
  const state = loadWindowState();
  nativeTheme.themeSource = isDarkMode ? 'dark' : 'light';

  mainWindow = new BrowserWindow({
    width: state.width, height: state.height, x: state.x, y: state.y,
    minWidth: 480, minHeight: 600, title: `Claude v${version}`,
    icon: icon(),
    backgroundColor: theme().bg,
    show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, 'preload-tabbar.js'),
      backgroundThrottling: false,
      spellcheck: false,
    }
  });

  if (state.isMaximized) mainWindow.maximize();

  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getTabBarHTML()));
  mainWindow.setTitle(`Claude v${version}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 3000);

  mainWindow.on('resize', () => { saveWindowState(); resizeActiveView(); });
  mainWindow.on('move', saveWindowState);
  mainWindow.on('maximize', () => { saveWindowState(); lastViewBounds = ''; resizeActiveView(); });
  mainWindow.on('unmaximize', () => { saveWindowState(); lastViewBounds = ''; resizeActiveView(); });
  mainWindow.on('enter-full-screen', () => { lastViewBounds = ''; resizeActiveView(); });
  mainWindow.on('leave-full-screen', () => { lastViewBounds = ''; resizeActiveView(); });
  mainWindow.on('show', () => { lastViewBounds = ''; resizeActiveView(); throttleActiveView(false); });
  mainWindow.on('restore', () => throttleActiveView(false));
  mainWindow.on('focus', () => throttleActiveView(false));
  mainWindow.on('minimize', () => throttleActiveView(true));
  mainWindow.on('hide', () => throttleActiveView(true));

  mainWindow.on('close', (e) => {
    if (!isQuitting && minimizeOnClose && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    tabs.forEach(tab => {
      if (alive(tab.view)) tab.view.webContents.close();
    });
    tabs = [];
    drainPool();
  });

  // Erster Tab + Pool verzögert füllen
  mainWindow.webContents.once('did-finish-load', () => {
    const tab = createTab('https://claude.ai');
    if (tab) {
      tab.view.webContents.once('did-finish-load', () => {
        lastViewBounds = '';
        resizeActiveView();
        setTimeout(fillPool, 2000);
      });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  App Lifecycle
// ═══════════════════════════════════════════════════════════════════

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) showMainWindow();
  else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

// Webview-Tags blockieren (Security)
app.on('web-contents-created', (_, wc) => {
  wc.on('will-attach-webview', (event) => event.preventDefault());
});

app.whenReady().then(() => {
  setupSession();
  createWindow();
  updateMenu(true);
  setupDownloadManager();
  setupAutoUpdater();
  setupTray();
  if (currentHotkey) registerHotkey(currentHotkey);
  handleOnlineChange(net.isOnline());
  onlineCheckInterval = setInterval(() => handleOnlineChange(net.isOnline()), ONLINE_CHECK_MS);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  if (mainWindow && windowState.lastSeenVersion !== version && RELEASE_NOTES[version]) {
    const showWhatsNew = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      openWhatsNewWindow();
      windowState.lastSeenVersion = version;
      saveWindowStateSync();
    };
    waitForFirstTabInterval = setInterval(() => {
      const firstTab = tabs[0];
      if (firstTab && alive(firstTab.view)) {
        clearInterval(waitForFirstTabInterval);
        waitForFirstTabInterval = null;
        firstTab.view.webContents.once('did-finish-load', () => setTimeout(showWhatsNew, 600));
      }
    }, 100);
    setTimeout(() => {
      if (waitForFirstTabInterval) { clearInterval(waitForFirstTabInterval); waitForFirstTabInterval = null; }
    }, 15000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (updateCheckInterval) { clearInterval(updateCheckInterval); updateCheckInterval = null; }
  if (onlineCheckInterval) { clearInterval(onlineCheckInterval); onlineCheckInterval = null; }
  if (waitForFirstTabInterval) { clearInterval(waitForFirstTabInterval); waitForFirstTabInterval = null; }
  saveWindowStateSync();
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
});
