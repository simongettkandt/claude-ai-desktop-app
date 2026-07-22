const { app, BrowserWindow, WebContentsView, shell, Menu, Tray, globalShortcut, nativeImage, nativeTheme, dialog, Notification, session, ipcMain, net, screen, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { version } = require('./package.json');
const { compareVersions, safeJson, isClaudeAiOrigin, validateAccelerator } = require('./utils/pure');

// Electron "Object has been destroyed" Error-Dialog abfangen
const _origErrorBox = dialog.showErrorBox;
dialog.showErrorBox = (title, content) => {
  if (typeof content === 'string' && content.includes('Object has been destroyed')) return;
  _origErrorBox(title, content);
};

// stdout/stderr EPIPE schlucken. Im Snap ist die stdio-Pipe oft geschlossen; ein
// console.* (z.B. aus electron-updater) wirft dann "write EPIPE" als Uncaught
// Exception und Electron zeigt den Crash-Dialog. Logging darf nie crashen.
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') return; });
process.stderr.on('error', (e) => { if (e && e.code === 'EPIPE') return; });

// Auffanglinie fuer verwaiste Promise-Rejections (z.B. ein openExternal das doch
// durchrutscht), damit sie nicht als Crash-Dialog hochkommen. Nur loggen.
process.on('unhandledRejection', (e) => { try { console.error('unhandledRejection:', (e && e.message) || e); } catch {} });

if (app.isPackaged) process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// Wayland-Bypass: BrowserWindow-Positionierung ist unter nativem Wayland
// no-op (Issue #40886, Maintainer-Statement Okt 2025). Loesung: ueber
// XWayland rendern. Der Switch wird zur Build-Zeit im AppImage-Wrapper
// (scripts/after-pack.js) und im Snap (snap/local/electron-launch) immer
// fix gesetzt. Im Dev-Modus muss er manuell beim Start mitgegeben werden:
// `npx electron . --no-sandbox --ozone-platform=x11`. Das `npm run dev`-
// Script in package.json macht das automatisch.

// Sandbox-Fallback
// Belt-and-suspenders zum --no-sandbox-Flag im .desktop-File: greift wenn die App
// ohne Argumente gestartet wird (z.B. nach Auto-Update durch quitAndInstall, oder
// per Doppelklick aus dem Dateimanager). chrome-sandbox-Helper ist auf üblichen
// Linux-Distributionen nicht setuid-konfiguriert, ohne diesen Switch crasht der
// Renderer beim Start. Idempotent zum Wrapper-Flag; muss vor app.whenReady() stehen.
app.commandLine.appendSwitch('no-sandbox');

// Single Instance
if (!app.requestSingleInstanceLock()) { app.quit(); }

// Konstanten

const isDev = !app.isPackaged;
// Chrome reduziert seit v107 die UA-Version auf <major>.0.0.0 (UA Reduction). Die volle
// Build-Version (z.B. 146.0.7680.216) im UA sendet KEIN echter Chrome mehr; nacktes Chromium
// kommt durch die CF-Verifizierung, die App mit voller Version blieb haengen. Volle Version
// gehoert nur in Sec-Ch-Ua-Full-Version-List, nicht in den UA-String.
const chromeUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;

// Wayland erkennen: clientseitige Toplevel-Positionierung wird vom Compositor
// ignoriert (kein xdg_positioner fuer toplevel). Alle x/y-Constructor-Params und
// setPosition()-Aufrufe sind unter Wayland No-ops; statt absoluter Koordinaten
// nutzen wir parent+center:true und ueberlassen die Platzierung dem Compositor.
const isWayland = process.platform === 'linux'
  && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

const TAB_BAR_HEIGHT = 40;
const WINDOW_BORDER = 1; // dezenter Fensterrahmen: 1px der Tab-Bar-Border scheint im View-Inset durch
const POOL_SIZE = 2;
const MAX_CRASH_RELOADS = 3;
const ONLINE_CHECK_MS = 60_000;
const UPDATE_CHECK_MS = 3_600_000;
const DOMAIN_CACHE_MAX = 50;

// Live-Notification-System (GitHub-hosted JSON)
const NOTIFICATIONS_URL = 'https://raw.githubusercontent.com/simonlinuxcraft/claude-ai-desktop-app/main/notifications.json';
const NOTIFICATIONS_FETCH_MS = 6 * 60 * 60 * 1000;        // alle 6h
const NOTIFICATIONS_FIRST_FETCH_DELAY_MS = 8 * 1000;       // nach App-Start 8s warten
const NOTIFICATION_BANNER_HEIGHT = 64;
const MAX_NOTIFICATIONS_VISIBLE = 1;                        // ein Banner gleichzeitig

// Injected Scripts (aus Dateien geladen)

const NOTIFY_SCRIPT = fs.readFileSync(path.join(__dirname, 'inject', 'notify.js'), 'utf8');
const VERIFY_SCRIPT = fs.readFileSync(path.join(__dirname, 'inject', 'verify-banner.js'), 'utf8');
// theme-static.js zuerst: definiert window.cdThemeStatic, das theme.js nutzt. Dieselbe
// Quelle liefert das statische Sheet auch fuer den document-start-Preload (buildStaticCSS unten).
const THEME_STATIC_SRC = fs.readFileSync(path.join(__dirname, 'inject', 'theme-static.js'), 'utf8');
const THEME_SCRIPT = THEME_STATIC_SRC + '\n' + fs.readFileSync(path.join(__dirname, 'inject', 'theme.js'), 'utf8');
const { buildStaticCSS: cdBuildStaticCSS } = require(path.join(__dirname, 'inject', 'theme-static.js'));

// State

let mainWindow = null;
let tabs = [];
let activeTabIndex = 0;
let isOnline = true;
let isDarkMode = true;
let oledMode = false;
let oledIntroSeen = false;
let customDesign = true;

// Tab-Pool (vorgeladene Views)
const viewPool = [];

// Helpers

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

// shell.openExternal liefert ein Promise, das unter Snap rejecten kann (Portal/
// xdg-open nicht erreichbar). Ohne .catch wuerde daraus eine unhandled rejection.
function openExternalSafe(url) {
  try { const p = shell.openExternal(url); if (p && p.catch) p.catch(() => {}); } catch {}
}

// Notification kann unter striktem Confinement werfen; ein Throw aus einem async
// Callback oder Event-Handler waere sonst ein Uncaught-Exception-Crash.
function notify(opts) {
  try { new Notification(opts).show(); } catch {}
}

// Sicherer WebContents-Zugriff
function alive(viewOrWc) {
  if (!viewOrWc) return false;
  const wc = viewOrWc.webContents || viewOrWc;
  return wc && !wc.isDestroyed();
}

// i18n (multi-language)

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
// Sprachwahl nach Systemsprache: de/fr/it wenn vorhanden, sonst Englisch-Fallback.
// fr/it sind optional - fehlt die Uebersetzung an einem Aufruf, greift en statt undefined.
function t(de, en, fr, it) {
  if (sysLang === 'de') return de;
  if (sysLang === 'fr') return fr != null ? fr : en;
  if (sysLang === 'it') return it != null ? it : en;
  return en;
}
// Release-Notes-Strings dürfen ein String (legacy: nur Deutsch) oder ein
// { de, en, fr?, it? } Objekt sein. localize() wählt nach Systemsprache und
// fällt auf en (sonst de) zurück, wenn die passende Übersetzung fehlt.
function localize(field) {
  if (field == null) return '';
  if (typeof field === 'string') return field;
  if (sysLang === 'de') return field.de || field.en || '';
  if (sysLang === 'fr') return field.fr || field.en || field.de || '';
  if (sysLang === 'it') return field.it || field.en || field.de || '';
  return field.en || field.de || '';
}

// Lokalisierte Strings für den Bug-Report-Dialog
const bugReportStrings = {
  en: {
    title: 'Report a Bug',
    intro: 'Found a bug or have a suggestion? Send us a message — your feedback helps improve the app.',
    disclaimerTitle: 'Unofficial community app',
    disclaimerBody: 'This is an unofficial community wrapper for claude.ai, built by one volunteer in their spare time. It has no connection to Anthropic, and your message goes to that developer, not to Anthropic support. Anything about your account, login, subscription, billing or payment, or any problem that also happens on claude.ai in a normal browser, can only be handled by Anthropic:',
    disclaimerLink: 'support.anthropic.com',
    disclaimerLinkUrl: 'https://support.anthropic.com',
    serverSideHint: 'Quick check: does the same error also happen on claude.ai in a regular browser (Firefox/Chrome)? If yes, it is a server-side issue at Anthropic and not a wrapper bug.',
    confirmLabel: 'This is a problem with the Linux desktop app itself',
    confirmHint: 'Not about my account, login, subscription or billing, and it does not happen the same way on claude.ai in a normal browser.',
    nudgeText: 'This sounds like an account, login or billing question. Only Anthropic can solve those, not this app:',
    descLabel: 'Description',
    descPlaceholder: 'What happened? What did you expect?',
    errorLabel: 'Error codes / messages (optional)',
    errorPlaceholder: 'e.g. console output, error numbers, stack traces',
    emailLabel: 'Your email (optional)',
    emailPlaceholder: 'so we can reply to you',
    autoInfoLabel: 'Include app version, OS and language',
    autoInfoHint: 'Helps us reproduce the issue — recommended.',
    sendBtn: 'Send report',
    sendingBtn: 'Sending…',
    successTitle: 'Report sent — thank you!',
    successMsg: 'We’ll get back to you if you provided your email.',
    errorTitle: 'Could not send report',
    errorHint: 'Please check your internet connection or send an email manually:',
    copyBtn: 'Copy Email',
    copied: 'Copied!',
    closeBtn: 'Close',
    cancelBtn: 'Cancel',
    body: 'Found a bug or have a suggestion?\nPlease send an email to:',
    btn: 'Copy Email'
  },
  de: {
    title: 'Fehler melden',
    intro: 'Einen Fehler gefunden oder einen Vorschlag? Schick uns eine Nachricht – dein Feedback hilft, die App zu verbessern.',
    disclaimerTitle: 'Inoffizielle Community-App',
    disclaimerBody: 'Das hier ist ein inoffizieller Community-Wrapper für claude.ai, gebaut von einer Einzelperson in der Freizeit. Er hat nichts mit Anthropic zu tun, und deine Nachricht geht an diesen Entwickler, nicht an den Anthropic-Support. Alles zu Account, Login, Abo, Rechnung oder Bezahlung, sowie jedes Problem das auch auf claude.ai im normalen Browser auftritt, kann nur Anthropic bearbeiten:',
    disclaimerLink: 'support.anthropic.com',
    disclaimerLinkUrl: 'https://support.anthropic.com',
    serverSideHint: 'Kurzer Check: Tritt der gleiche Fehler auch auf claude.ai in einem normalen Browser (Firefox/Chrome) auf? Wenn ja, ist es ein serverseitiges Problem bei Anthropic und kein Wrapper-Bug.',
    confirmLabel: 'Das ist ein Problem der Linux-Desktop-App selbst',
    confirmHint: 'Nicht zu meinem Account, Login, Abo oder Bezahlung, und es tritt nicht genauso auf claude.ai im normalen Browser auf.',
    nudgeText: 'Das klingt nach einer Account-, Login- oder Bezahl-Frage. Die kann nur Anthropic lösen, nicht diese App:',
    descLabel: 'Beschreibung',
    descPlaceholder: 'Was ist passiert? Was hast du erwartet?',
    errorLabel: 'Fehlercodes / Meldungen (optional)',
    errorPlaceholder: 'z.B. Konsolen-Ausgaben, Fehlernummern, Stack-Traces',
    emailLabel: 'Deine E-Mail (optional)',
    emailPlaceholder: 'damit wir antworten können',
    autoInfoLabel: 'App-Version, OS und Sprache mitsenden',
    autoInfoHint: 'Hilft uns, das Problem nachzuvollziehen – empfohlen.',
    sendBtn: 'Bericht senden',
    sendingBtn: 'Wird gesendet…',
    successTitle: 'Bericht gesendet – danke!',
    successMsg: 'Wenn du deine E-Mail angegeben hast, melden wir uns zurück.',
    errorTitle: 'Bericht konnte nicht gesendet werden',
    errorHint: 'Bitte prüfe deine Internetverbindung oder schick uns manuell eine E-Mail:',
    copyBtn: 'E-Mail kopieren',
    copied: 'Kopiert!',
    closeBtn: 'Schließen',
    cancelBtn: 'Abbrechen',
    body: 'Einen Fehler gefunden oder einen Vorschlag?\nBitte sende eine E-Mail an:',
    btn: 'E-Mail kopieren'
  },
  fr: {
    title: 'Signaler un bug',
    intro: 'Vous avez trouv\u00e9 un bug ou une suggestion ? Envoyez-nous un message \u2014 vos retours nous aident \u00e0 am\u00e9liorer l\u2019application.',
    disclaimerTitle: 'Application communautaire non officielle',
    disclaimerBody: 'Ceci est un wrapper communautaire non officiel pour claude.ai, d\u00e9velopp\u00e9 par une seule personne sur son temps libre. Il n\u2019a aucun lien avec Anthropic, et votre message est envoy\u00e9 \u00e0 ce d\u00e9veloppeur, pas au support d\u2019Anthropic. Tout ce qui concerne le compte, la connexion, l\u2019abonnement, la facturation ou le paiement, ainsi que tout probl\u00e8me qui se produit aussi sur claude.ai dans un navigateur normal, ne peut \u00eatre trait\u00e9 que par Anthropic :',
    disclaimerLink: 'support.anthropic.com',
    disclaimerLinkUrl: 'https://support.anthropic.com',
    serverSideHint: 'V\u00e9rification rapide : la m\u00eame erreur appara\u00eet-elle sur claude.ai dans un navigateur normal (Firefox/Chrome) ? Si oui, c\u2019est un probl\u00e8me c\u00f4t\u00e9 serveur chez Anthropic et non un bug du wrapper.',
    confirmLabel: 'C\u2019est un probl\u00e8me de l\u2019application de bureau Linux elle-m\u00eame',
    confirmHint: 'Pas mon compte, ma connexion, mon abonnement ou mon paiement, et cela ne se produit pas de la m\u00eame fa\u00e7on sur claude.ai dans un navigateur normal.',
    nudgeText: 'Cela ressemble \u00e0 une question de compte, de connexion ou de facturation. Seul Anthropic peut la r\u00e9soudre, pas cette application :',
    descLabel: 'Description',
    descPlaceholder: 'Que s\u2019est-il pass\u00e9 ? Qu\u2019attendiez-vous ?',
    errorLabel: 'Codes d\u2019erreur / messages (facultatif)',
    errorPlaceholder: 'p. ex. sortie console, num\u00e9ros d\u2019erreur, stack traces',
    emailLabel: 'Votre e-mail (facultatif)',
    emailPlaceholder: 'pour que nous puissions vous r\u00e9pondre',
    autoInfoLabel: 'Inclure la version, l\u2019OS et la langue de l\u2019application',
    autoInfoHint: 'Aide \u00e0 reproduire le probl\u00e8me \u2014 recommand\u00e9.',
    sendBtn: 'Envoyer le rapport',
    sendingBtn: 'Envoi\u2026',
    successTitle: 'Rapport envoy\u00e9 \u2014 merci !',
    successMsg: 'Nous vous r\u00e9pondrons si vous avez fourni votre e-mail.',
    errorTitle: 'Impossible d\u2019envoyer le rapport',
    errorHint: 'Veuillez v\u00e9rifier votre connexion internet ou envoyer un e-mail manuellement :',
    copyBtn: 'Copier l\u2019e-mail',
    copied: 'Copi\u00e9 !',
    closeBtn: 'Fermer',
    cancelBtn: 'Annuler',
    body: 'Vous avez trouv\u00e9 un bug ou une suggestion ?\nVeuillez envoyer un e-mail \u00e0 :',
    btn: 'Copier l\u2019e-mail'
  },
  es: {
    title: 'Reportar un error',
    intro: '\u00bfHas encontrado un error o tienes una sugerencia? Env\u00edanos un mensaje \u2014 tu feedback ayuda a mejorar la app.',
    disclaimerTitle: 'Aplicaci\u00f3n comunitaria no oficial',
    disclaimerBody: 'Esta es una aplicaci\u00f3n comunitaria no oficial para claude.ai, creada por una sola persona en su tiempo libre. No tiene ninguna relaci\u00f3n con Anthropic, y tu mensaje va a ese desarrollador, no al soporte de Anthropic. Todo lo relacionado con cuenta, inicio de sesi\u00f3n, suscripci\u00f3n, facturaci\u00f3n o pago, as\u00ed como cualquier problema que tambi\u00e9n ocurra en claude.ai en un navegador normal, solo puede resolverlo Anthropic:',
    disclaimerLink: 'support.anthropic.com',
    disclaimerLinkUrl: 'https://support.anthropic.com',
    serverSideHint: 'Comprobaci\u00f3n r\u00e1pida: \u00bfaparece el mismo error en claude.ai en un navegador normal (Firefox/Chrome)? Si es as\u00ed, es un problema del servidor de Anthropic y no un bug del wrapper.',
    confirmLabel: 'Esto es un problema de la app de escritorio de Linux en s\u00ed',
    confirmHint: 'No es sobre mi cuenta, inicio de sesi\u00f3n, suscripci\u00f3n o pago, y no ocurre igual en claude.ai en un navegador normal.',
    nudgeText: 'Esto parece una cuesti\u00f3n de cuenta, inicio de sesi\u00f3n o pago. Solo Anthropic puede resolverla, no esta app:',
    descLabel: 'Descripci\u00f3n',
    descPlaceholder: '\u00bfQu\u00e9 pas\u00f3? \u00bfQu\u00e9 esperabas?',
    errorLabel: 'C\u00f3digos de error / mensajes (opcional)',
    errorPlaceholder: 'p. ej. salida de consola, n\u00fameros de error, stack traces',
    emailLabel: 'Tu correo (opcional)',
    emailPlaceholder: 'para poder responderte',
    autoInfoLabel: 'Incluir versi\u00f3n de la app, sistema operativo e idioma',
    autoInfoHint: 'Nos ayuda a reproducir el problema \u2014 recomendado.',
    sendBtn: 'Enviar reporte',
    sendingBtn: 'Enviando\u2026',
    successTitle: '\u00a1Reporte enviado \u2014 gracias!',
    successMsg: 'Te responderemos si nos diste tu correo.',
    errorTitle: 'No se pudo enviar el reporte',
    errorHint: 'Comprueba tu conexi\u00f3n a internet o env\u00edanos un correo manualmente:',
    copyBtn: 'Copiar correo',
    copied: '\u00a1Copiado!',
    closeBtn: 'Cerrar',
    cancelBtn: 'Cancelar',
    body: '\u00bfEncontraste un error o tienes una sugerencia?\nEnv\u00eda un correo a:',
    btn: 'Copiar correo'
  },
  pt: { title: 'Reportar um bug', body: 'Encontrou um bug ou tem uma sugest\u00e3o?\nEnvie um e-mail para:', btn: 'Copiar e-mail', copied: 'Copiado!' },
  it: {
    title: 'Segnala un bug',
    intro: 'Hai trovato un bug o hai un suggerimento? Inviaci un messaggio \u2014 il tuo feedback aiuta a migliorare l\u2019app.',
    disclaimerTitle: 'App di comunit\u00e0 non ufficiale',
    disclaimerBody: 'Questa \u00e8 un\u2019app di comunit\u00e0 non ufficiale per claude.ai, creata da una singola persona nel tempo libero. Non ha alcun legame con Anthropic, e il tuo messaggio va a quello sviluppatore, non al supporto Anthropic. Tutto ci\u00f2 che riguarda account, accesso, abbonamento, fatturazione o pagamento, cos\u00ec come qualsiasi problema che si verifica anche su claude.ai in un browser normale, pu\u00f2 essere gestito solo da Anthropic:',
    disclaimerLink: 'support.anthropic.com',
    disclaimerLinkUrl: 'https://support.anthropic.com',
    serverSideHint: 'Verifica rapida: lo stesso errore compare anche su claude.ai in un browser normale (Firefox/Chrome)? Se s\u00ec, \u00e8 un problema lato server di Anthropic e non un bug del wrapper.',
    confirmLabel: 'Riguarda l\u2019app desktop Linux stessa',
    confirmHint: 'Non riguarda il mio account, accesso, abbonamento o pagamento, e non si verifica allo stesso modo su claude.ai in un browser normale.',
    nudgeText: 'Sembra una domanda su account, accesso o pagamento. Solo Anthropic può risolverla, non questa app:',
    descLabel: 'Descrizione',
    descPlaceholder: 'Cosa \u00e8 successo? Cosa ti aspettavi?',
    errorLabel: 'Codici di errore / messaggi (facoltativo)',
    errorPlaceholder: 'es. output console, numeri di errore, stack trace',
    emailLabel: 'La tua email (facoltativa)',
    emailPlaceholder: 'cos\u00ec possiamo risponderti',
    autoInfoLabel: 'Includi versione dell\u2019app, sistema operativo e lingua',
    autoInfoHint: 'Ci aiuta a riprodurre il problema \u2014 consigliato.',
    sendBtn: 'Invia segnalazione',
    sendingBtn: 'Invio\u2026',
    successTitle: 'Segnalazione inviata \u2014 grazie!',
    successMsg: 'Ti risponderemo se hai indicato la tua email.',
    errorTitle: 'Impossibile inviare la segnalazione',
    errorHint: 'Controlla la tua connessione internet o inviaci un\u2019email manualmente:',
    copyBtn: 'Copia email',
    copied: 'Copiato!',
    closeBtn: 'Chiudi',
    cancelBtn: 'Annulla',
    body: 'Hai trovato un bug o un suggerimento?\nInvia un\u2019email a:',
    btn: 'Copia email'
  },
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

// Window-State (persistiert Größe, Position, Theme)

const stateFile = path.join(app.getPath('userData'), 'window-state.json');
let windowState = {};
let lastSavedState = '';
let tray = null;
let isQuitting = false;
let settingsWindow = null;
let quickPromptWindow = null;
let whatsNewWindow = null;
let aboutWindow = null;
let appMenuWindow = null;
let bugReportWindow = null;
let appMenuJustClosedAt = 0;
let minimizeOnClose = false;
let currentHotkey = null;
let currentClipboardHotkey = null;
let promptTemplates = [];      // [{ id, name, prefix }]
let bgNotificationsEnabled = false;
let microphoneEnabled = false;
let microphoneConsentAsked = false;
// Modul-weiter Mutex fuer den Mic-Consent-Dialog. Verhindert Double-Modals
// (z.B. wenn Settings-Toggle und claude.ai-Mic-Click parallel triggern).
let consentInflight = null;
let lastActiveTabIndex = -1;   // für Background-Notifications
let updateCheckInterval = null;
let onlineCheckInterval = null;
let waitForFirstTabInterval = null;
let notificationsFetchInterval = null;
let activeNotifications = [];                    // gefilterte, aktuell sichtbare Notifications
let dismissedNotificationIds = [];                // persistiert in windowState

// Zentrales Schema fuer alle persistierten State-Felder. Eine Stelle definiert
// Default-Verhalten + Validierung. loadWindowState() liest, buildState() schreibt.
// Felder mit `optional: true` werden nur gesetzt wenn sie im JSON definiert sind
// (behalten sonst den Modul-Default), die anderen werden immer auf den
// validierten Wert gezwungen.
const STATE_SCHEMA = [
  { key: 'customDesign', optional: true, get: () => customDesign,
    set: v => { customDesign = v === true; } },
  { key: 'isDarkMode', optional: true, get: () => isDarkMode,
    set: v => { isDarkMode = v === true; } },
  { key: 'oledMode', optional: true, get: () => oledMode,
    set: v => { oledMode = v === true; } },
  { key: 'oledIntroSeen', optional: true, get: () => oledIntroSeen,
    set: v => { oledIntroSeen = v === true; } },
  { key: 'minimizeOnClose', get: () => minimizeOnClose,
    set: v => { minimizeOnClose = v === true; } },
  { key: 'hotkey', get: () => currentHotkey,
    set: v => { currentHotkey = (typeof v === 'string' && v.length > 0) ? v : null; } },
  { key: 'clipboardHotkey', get: () => currentClipboardHotkey,
    set: v => { currentClipboardHotkey = (typeof v === 'string' && v.length > 0) ? v : null; } },
  { key: 'promptTemplates', get: () => promptTemplates,
    set: v => {
      promptTemplates = Array.isArray(v)
        ? v.filter(tpl => tpl && typeof tpl.name === 'string' && typeof tpl.prefix === 'string').slice(0, 50)
        : [];
    } },
  { key: 'bgNotificationsEnabled', get: () => bgNotificationsEnabled,
    set: v => { bgNotificationsEnabled = v === true; } },
  { key: 'microphoneEnabled', get: () => microphoneEnabled,
    set: v => { microphoneEnabled = v === true; } },
  { key: 'microphoneConsentAsked', get: () => microphoneConsentAsked,
    set: v => { microphoneConsentAsked = v === true; } },
  { key: 'dismissedNotificationIds', get: () => dismissedNotificationIds.slice(0, 200),
    set: v => {
      dismissedNotificationIds = Array.isArray(v)
        ? v.filter(id => typeof id === 'string').slice(0, 200)
        : [];
    } },
  { key: 'lastSeenVersion', get: () => windowState.lastSeenVersion || null,
    set: () => { /* eigene Logik in What's-New, hier nur passthrough */ } },
  // Offene Tabs. Fallback auf den zuletzt gespeicherten Wert ist zwingend: der
  // closed-Handler leert `tabs` bevor before-quit synchron speichert, sonst wuerde
  // beim Schliessen ueber das Fenster-X eine leere Liste die Session ueberschreiben.
  // Restore liest windowState.tabs direkt, darum ist set ein Passthrough-No-op.
  { key: 'tabs',
    get: () => (tabs.length
      ? tabs.map(tb => tb.url).filter(u => typeof u === 'string' && u.startsWith('https://'))
      : (Array.isArray(windowState.tabs) ? windowState.tabs : [])).slice(0, 20),
    set: () => { /* Restore laeuft in createWindow, hier nur passthrough */ } }
];

// Wenn die aktuelle Version in dieser Map steht, werden die hier gelisteten
// älteren Versionen beim "Was ist neu"-Fenster zusätzlich gezeigt. Gedacht für
// Hotfixes, in denen die Notes der Vorgängerversion in einer fehlerhaften Form
// (z.B. falscher Sprache) angezeigt wurden und nachgereicht werden sollen.
const RELEASE_NOTES_REVISIT = {
  '1.4.1': ['1.4.0']
};

const RELEASE_NOTES = {
  '1.4.12': [
    {
      icon: 'bolt',
      title: {
        de: 'Weiß-Wechsel ohne Ruckeln',
        en: 'Switching to White no longer stutters',
        fr: 'Le passage au thème clair ne saccade plus',
        it: 'Il passaggio al tema chiaro non scatta più'
      },
      text: {
        de: 'Der Wechsel zum weißen Theme fror kurz ein, weil dafür claude.ais komplette Farbpalette auf hell umgestellt wurde und claude.ai daraufhin die Darstellung jedes sichtbaren Elements neu berechnete (gemessen rund 480 ms, unabhängig von der Chatlänge). Weiß lässt claude.ai jetzt in seiner dunklen Palette und dreht die Seite stattdessen auf der Grafikkarte um; echte Bilder werden zurückgedreht. Statt 480 ms sind es rund 6 ms, so schnell wie der Wechsel zwischen OLED und Dunkel. Weiß ist dadurch eine farbtreue Umkehrung des dunklen Themes statt claude.ais eigenem hellen Theme.',
        en: 'Switching to the White theme froze for a moment, because it flipped claude.ai\'s entire palette to light and claude.ai then recomputed the style of every visible element (measured at about 480ms, regardless of chat length). White now keeps claude.ai in its dark palette and inverts the page on the GPU instead, with real images inverted back. That is about 6ms instead of 480ms, as fast as switching between OLED and Dark. As a result White is a colour-faithful inversion of the dark theme rather than claude.ai\'s own light theme.',
        fr: 'Le passage au thème clair se figeait un instant, car il basculait toute la palette de claude.ai en clair et claude.ai recalculait alors le style de chaque élément visible (environ 480 ms mesurées, quelle que soit la longueur de la conversation). Le thème clair garde désormais claude.ai dans sa palette sombre et inverse plutôt la page sur la carte graphique ; les vraies images sont réinversées. Cela représente environ 6 ms au lieu de 480 ms, aussi rapide que le passage entre OLED et sombre. Le thème clair est ainsi une inversion fidèle des couleurs du thème sombre plutôt que le thème clair natif de claude.ai.',
        it: 'Il passaggio al tema chiaro si bloccava per un istante, perché convertiva l’intera palette di claude.ai in chiaro e claude.ai ricalcolava poi lo stile di ogni elemento visibile (circa 480 ms misurati, indipendentemente dalla lunghezza della chat). Il tema chiaro ora mantiene claude.ai nella sua palette scura e inverte invece la pagina sulla scheda grafica; le immagini reali vengono re-invertite. Sono circa 6 ms invece di 480 ms, veloce quanto il passaggio tra OLED e scuro. Di conseguenza il tema chiaro è un’inversione fedele nei colori del tema scuro anziché il tema chiaro nativo di claude.ai.'
      }
    },
    {
      icon: 'palette',
      title: {
        de: 'Theme steht sofort beim Start',
        en: 'Theme is there right at startup',
        fr: 'Le thème est là dès le démarrage',
        it: 'Il tema è pronto già all’avvio'
      },
      text: {
        de: 'Beim Kaltstart baute sich das Theme sichtbar auf: kurz war claude.ais Standard-Darstellung zu sehen, dann sprang alles auf das dunkle Theme um. Grund war, dass das vollständige Theme von einem Skript kam, das erst rund 1,7 Sekunden nach dem Laden an die Reihe kam, weil claude.ai in der Zwischenzeit den Hauptprozess belegt. Das komplette Theme wird jetzt schon vor dem ersten Bild gesetzt, sodass wiederhergestellte Inhalte gleich richtig dargestellt werden. Die kurze Nicht-Reagierbarkeit während claude.ai selbst lädt, bleibt davon unberührt.',
        en: 'On a cold start the theme visibly built up: claude.ai\'s default look flashed for a moment, then everything snapped to the dark theme. The full theme came from a script that only got its turn about 1.7 seconds into the load, because claude.ai occupies the main process until then. The complete theme is now set before the first paint, so restored content appears correct right away. The brief unresponsiveness while claude.ai itself loads is unaffected.',
        fr: 'Au démarrage à froid, le thème se construisait visiblement : l’apparence par défaut de claude.ai apparaissait un instant, puis tout basculait vers le thème sombre. Le thème complet venait d’un script qui n’intervenait qu’environ 1,7 seconde après le chargement, car claude.ai occupe le processus principal jusque-là. Le thème complet est désormais appliqué avant le premier rendu, si bien que le contenu restauré s’affiche correctement d’emblée. La brève absence de réponse pendant que claude.ai se charge n’est pas concernée.',
        it: 'All’avvio a freddo il tema si costruiva visibilmente: per un istante compariva l’aspetto predefinito di claude.ai, poi tutto passava al tema scuro. Il tema completo proveniva da uno script che entrava in gioco solo circa 1,7 secondi dopo il caricamento, perché claude.ai occupa il processo principale fino ad allora. Il tema completo viene ora impostato prima del primo disegno, così i contenuti ripristinati appaiono subito corretti. La breve mancanza di risposta mentre claude.ai stesso si carica non è interessata.'
      }
    },
    {
      icon: 'refresh',
      title: {
        de: 'Flüssigeres Rendern des Themes',
        en: 'Smoother theme rendering',
        fr: 'Rendu du thème plus fluide',
        it: 'Rendering del tema più fluido'
      },
      text: {
        de: 'Im OLED-Modus wurde das Sternenfeld hinter offenen Dialogen über einen aufwändigen CSS-Selektor ausgeblendet, den der Browser bei jeder Änderung an der Seite neu auswerten musste. Während eine Antwort entsteht, ändert claude.ai die Seite viele Male pro Sekunde, wodurch das ständig lief und die Darstellung träge wirken ließ. Das Ausblenden läuft jetzt über einen leichtgewichtigen Schalter, der messbar keine Zusatzkosten pro Änderung verursacht.',
        en: 'In OLED mode the starfield behind open dialogs was hidden with an expensive CSS selector that the browser had to re-evaluate on every change to the page. While a response is being written, claude.ai changes the page many times per second, so this ran constantly and made the display feel sluggish. The hiding now uses a lightweight switch that measurably adds no cost per change.',
        fr: 'En mode OLED, le champ d’étoiles derrière les dialogues ouverts était masqué par un sélecteur CSS coûteux que le navigateur devait réévaluer à chaque changement de la page. Pendant qu’une réponse s’écrit, claude.ai modifie la page de nombreuses fois par seconde, ce qui s’exécutait en permanence et rendait l’affichage lent. Le masquage utilise désormais un commutateur léger qui, d’après les mesures, n’ajoute aucun coût par changement.',
        it: 'In modalità OLED il campo stellare dietro le finestre di dialogo aperte veniva nascosto con un selettore CSS costoso che il browser doveva rivalutare a ogni modifica della pagina. Mentre una risposta viene scritta, claude.ai modifica la pagina molte volte al secondo, quindi ciò veniva eseguito di continuo e rendeva la visualizzazione lenta. Ora l’occultamento usa un interruttore leggero che, secondo le misurazioni, non aggiunge alcun costo per modifica.'
      }
    }
  ],
  '1.4.11': [
    {
      icon: 'palette',
      title: {
        de: 'Farbige Brand-Symbole statt grauer',
        en: 'Brand icons are coloured again',
        fr: 'Les icônes de marque retrouvent leur couleur',
        it: 'Le icone del marchio tornano colorate'
      },
      text: {
        de: 'Im Design "Modern" mit Dunkel- oder OLED-Modus wurde der Stern über der Begrüßung und andere Akzent-Symbole grau statt farbig dargestellt. Ursache war die Umfärbung der Marken-Farbe: claude.ai erwartet an dieser Stelle keinen fertigen Farbwert, wodurch die Farbangabe ungültig wurde und die Symbole auf die Textfarbe zurückfielen. Die Umfärbung greift jetzt direkt an der richtigen Stelle.',
        en: 'In the "Modern" design with dark or OLED mode, the spark above the greeting and other accent icons appeared grey instead of coloured. The cause was the brand colour remap: claude.ai does not expect a finished colour value there, so the declaration became invalid and the icons fell back to the text colour. The remap now applies at the right place.',
        fr: 'Dans le design « Moderne » avec le mode sombre ou OLED, l’étoile au-dessus du message d’accueil et d’autres icônes d’accentuation apparaissaient en gris au lieu d’être colorées. En cause : la recoloration de la couleur de marque, car claude.ai n’attend pas ici une valeur de couleur finie, ce qui rendait la déclaration invalide et faisait retomber les icônes sur la couleur du texte. La recoloration s’applique désormais au bon endroit.',
        it: 'Nel design "Moderno" con modalità scura o OLED, la stella sopra il saluto e altre icone di accento apparivano grigie invece che colorate. La causa era la ricolorazione del colore del marchio: claude.ai non si aspetta lì un valore di colore già pronto, quindi la dichiarazione diventava non valida e le icone ripiegavano sul colore del testo. Ora la ricolorazione agisce nel punto giusto.'
      }
    },
    {
      icon: 'refresh',
      title: {
        de: 'Offene Tabs überleben den Neustart',
        en: 'Open tabs survive a restart',
        fr: 'Les onglets ouverts survivent au redémarrage',
        it: 'Le schede aperte sopravvivono al riavvio'
      },
      text: {
        de: 'Die App merkt sich jetzt, welche Unterhaltungen offen waren, und stellt sie beim nächsten Start wieder her. Die zusätzlichen Tabs laden erst beim Anklicken, damit der Start nicht ausgebremst wird.',
        en: 'The app now remembers which conversations were open and restores them on the next start. Additional tabs only load when you click them, so startup stays fast.',
        fr: 'L’application retient désormais les conversations ouvertes et les restaure au démarrage suivant. Les onglets supplémentaires ne se chargent qu’au clic, pour ne pas ralentir le démarrage.',
        it: 'L’app ora ricorda quali conversazioni erano aperte e le ripristina al successivo avvio. Le schede aggiuntive si caricano solo al clic, così l’avvio resta veloce.'
      }
    },
    {
      icon: 'bug',
      title: {
        de: 'Nach Verbindungsabbruch zurück in die richtige Unterhaltung',
        en: 'Back to the right conversation after a dropout',
        fr: 'Retour à la bonne conversation après une coupure',
        it: 'Ritorno alla conversazione giusta dopo una disconnessione'
      },
      text: {
        de: 'Brach die Verbindung ab, landete man danach in einem neuen Chat statt in der vorherigen Unterhaltung, und Tabs im Hintergrund blieben dauerhaft auf der Offline-Seite hängen. Die App merkt sich jetzt pro Tab die geöffnete Unterhaltung und kehrt beim Wiederverbinden dorthin zurück, auch über mehrere Tabs hinweg. Der Status wird außerdem sofort beim Zurückwechseln zum Fenster geprüft statt erst nach bis zu einer Minute.',
        en: 'After a connection dropout you ended up in a new chat instead of the previous conversation, and background tabs stayed stuck on the offline page for good. The app now remembers the open conversation per tab and returns to it when the connection comes back, across multiple tabs. The status is also checked as soon as you switch back to the window, instead of after up to a minute.',
        fr: 'Après une coupure de connexion, vous vous retrouviez dans une nouvelle conversation au lieu de la précédente, et les onglets en arrière-plan restaient bloqués sur la page hors ligne. L’application retient désormais la conversation ouverte pour chaque onglet et y revient au rétablissement de la connexion, sur plusieurs onglets. L’état est également vérifié dès que vous revenez sur la fenêtre, au lieu d’attendre jusqu’à une minute.',
        it: 'Dopo una disconnessione finivi in una nuova chat invece che nella conversazione precedente, e le schede in secondo piano restavano bloccate sulla pagina offline. L’app ora ricorda la conversazione aperta per ogni scheda e vi ritorna al ripristino della connessione, anche su più schede. Lo stato viene inoltre verificato appena torni sulla finestra, invece che dopo fino a un minuto.'
      }
    },
    {
      icon: 'bolt',
      title: {
        de: 'Neu zeichnen bei leerem Chatbereich',
        en: 'Redraw for a blank chat area',
        fr: 'Redessiner en cas de zone de discussion vide',
        it: 'Ridisegna in caso di area chat vuota'
      },
      text: {
        de: 'Auf manchen Systemen bleibt der Chatbereich gelegentlich leer, bis man den Tab wechselt. Im Menü "Ansicht" gibt es dafür jetzt "Neu zeichnen" (Strg+Alt+R), das die Anzeige ohne Tabwechsel wiederherstellt. Zusätzlich wurde eine Drosselung behoben, durch die ein Tab nach dem Minimieren bei niedriger Bildrate hängen bleiben konnte.',
        en: 'On some systems the chat area occasionally stays blank until you switch tabs. The View menu now has a "Redraw" entry (Ctrl+Alt+R) that restores the display without switching tabs. A throttling bug was also fixed that could leave a tab stuck at a low frame rate after minimizing.',
        fr: 'Sur certains systèmes, la zone de discussion reste parfois vide jusqu’à ce que vous changiez d’onglet. Le menu « Affichage » propose désormais « Redessiner » (Ctrl+Alt+R), qui rétablit l’affichage sans changer d’onglet. Un problème de limitation a également été corrigé, qui pouvait laisser un onglet bloqué à faible fréquence d’images après réduction.',
        it: 'Su alcuni sistemi l’area chat resta a volte vuota finché non cambi scheda. Nel menu "Visualizza" ora c’è "Ridisegna" (Ctrl+Alt+R), che ripristina la visualizzazione senza cambiare scheda. È stato inoltre corretto un problema di limitazione che poteva lasciare una scheda bloccata a bassa frequenza di fotogrammi dopo la riduzione a icona.'
      }
    },
    {
      icon: 'palette',
      title: {
        de: 'Seitenleiste bleibt im OLED-Modus sichtbar',
        en: 'Sidebar stays visible in OLED mode',
        fr: 'La barre latérale reste visible en mode OLED',
        it: 'La barra laterale resta visibile in modalità OLED'
      },
      text: {
        de: 'Im OLED-Modus konnte die Seitenleiste beim Laden mit dem gleich schwarzen Chatbereich verschmelzen und dadurch unsichtbar wirken. Die feine Trennlinie wird jetzt schon vor dem ersten Bild gesetzt, nicht erst danach. Außerdem blitzen Vorschau-Fenster für Code und Design nicht mehr weiß auf.',
        en: 'In OLED mode the sidebar could blend into the equally black chat area while loading and appear to be gone. The thin divider is now applied before the first paint instead of after. Preview windows for code and design also no longer flash white.',
        fr: 'En mode OLED, la barre latérale pouvait se fondre dans la zone de discussion tout aussi noire pendant le chargement et sembler avoir disparu. Le fin séparateur est désormais appliqué avant le premier rendu, et non après. Les fenêtres d’aperçu pour le code et le design ne clignotent plus en blanc.',
        it: 'In modalità OLED la barra laterale poteva confondersi con l’area chat altrettanto nera durante il caricamento e sembrare scomparsa. Il sottile separatore viene ora applicato prima del primo disegno, non dopo. Inoltre le finestre di anteprima per codice e design non lampeggiano più in bianco.'
      }
    }
  ],
  '1.4.10': [
    {
      icon: 'check',
      title: {
        de: 'Fehler melden: klarer vom Anthropic-Support getrennt',
        en: 'Bug Report: clearer separation from Anthropic support',
        fr: 'Signaler un bug : séparation plus nette du support Anthropic',
        it: 'Segnala un bug: separazione più netta dal supporto Anthropic'
      },
      text: {
        de: 'Immer wieder landeten Account-, Login- und Bezahl-Anfragen im Fehler-melden-Fenster, obwohl das nur Anthropic lösen kann. Der Hinweis sagt jetzt deutlich, dass die Nachricht an einen einzelnen freiwilligen Entwickler geht, nicht an Anthropic. Vor dem Absenden bestätigt man zusätzlich mit einem Häkchen, dass es wirklich um die Linux-App selbst geht.',
        en: 'Account, login and billing requests kept landing in the Bug Report window, even though only Anthropic can solve those. The notice now states clearly that the message goes to a single volunteer developer, not to Anthropic. Before sending, a checkbox also asks you to confirm the issue really is about the Linux app itself.',
        fr: 'Des demandes de compte, de connexion et de facturation arrivaient sans cesse dans la fenêtre de signalement, alors que seul Anthropic peut les résoudre. Le message indique désormais clairement qu’il est envoyé à un développeur bénévole, pas à Anthropic. Avant l’envoi, une case à cocher vous demande aussi de confirmer qu’il s’agit bien de l’application Linux elle-même.',
        it: 'Richieste di account, accesso e pagamento continuavano ad arrivare nella finestra di segnalazione, anche se solo Anthropic può risolverle. L’avviso ora indica chiaramente che il messaggio va a un singolo sviluppatore volontario, non ad Anthropic. Prima dell’invio, una casella di spunta ti chiede inoltre di confermare che si tratta davvero dell’app Linux stessa.'
      }
    },
    {
      icon: 'bell',
      title: {
        de: 'Sanfter Hinweis bei Account- oder Bezahl-Themen',
        en: 'Gentle hint on account or billing topics',
        fr: 'Indication discrète pour les sujets compte ou paiement',
        it: 'Suggerimento discreto per temi di account o pagamento'
      },
      text: {
        de: 'Klingt die Beschreibung nach Login, Passwort, Abo oder Rechnung, blendet das Formular jetzt live einen kurzen Hinweis mit Link zum Anthropic-Support ein. Das ist nur ein Hinweis, absenden lässt sich der Bericht trotzdem.',
        en: 'If the description sounds like login, password, subscription or billing, the form now shows a short inline hint with a link to Anthropic support. It is only a hint, you can still send the report.',
        fr: 'Si la description évoque une connexion, un mot de passe, un abonnement ou une facturation, le formulaire affiche désormais en direct une courte note avec un lien vers le support Anthropic. Ce n’est qu’une indication, vous pouvez quand même envoyer le rapport.',
        it: 'Se la descrizione richiama accesso, password, abbonamento o fatturazione, il modulo mostra ora al volo una breve nota con un link al supporto Anthropic. È solo un suggerimento, puoi comunque inviare la segnalazione.'
      }
    }
  ],
  '1.4.9': [
    {
      icon: 'refresh',
      title: {
        de: 'OLED: schwarze Balken auf der Bezahlseite behoben',
        en: 'OLED: black bars on the checkout page fixed',
        fr: 'OLED : bandes noires corrigées sur la page de paiement',
        it: 'OLED: barre nere corrette nella pagina di pagamento'
      },
      text: {
        de: 'Auf der Upgrade-/Bezahlseite färbte der OLED-Modus auch helle Preis-Chips komplett schwarz. Die Erkennung unterschied eine helle Tönung (z.B. 5% Deckkraft) nicht von der voll deckenden Variante desselben Tokens, wodurch der für hellen Hintergrund gedachte dunkle Text darauf unlesbar wurde. Getönte Varianten werden jetzt gezielt ausgenommen.',
        en: 'On the upgrade/checkout page, OLED mode also painted light price chips fully black. The detection did not distinguish a light tint (e.g. 5% opacity) from the fully opaque variant of the same token, making the dark text meant for a light background unreadable. Tinted variants are now specifically excluded.',
        fr: 'Sur la page de mise à niveau/paiement, le mode OLED peignait aussi en noir plein des puces de prix claires. La détection ne distinguait pas une teinte claire (par ex. 5% d’opacité) de la variante entièrement opaque du même token, rendant illisible le texte sombre prévu pour un fond clair. Les variantes teintées sont désormais exclues spécifiquement.',
        it: 'Nella pagina di aggiornamento/pagamento, la modalità OLED colorava di nero anche i chip di prezzo chiari. Il rilevamento non distingueva una tinta chiara (per es. 5% di opacità) dalla variante completamente opaca dello stesso token, rendendo illeggibile il testo scuro pensato per uno sfondo chiaro. Le varianti tinteggiate ora vengono escluse specificamente.'
      }
    },
    {
      icon: 'palette',
      title: {
        de: 'Classic/Modern-Umfärbung: modernere Farbwerte erkannt',
        en: 'Classic/Modern recolor: modern color values now recognized',
        fr: 'Recoloration Classic/Modern : valeurs de couleur modernes reconnues',
        it: 'Ricolorazione Classic/Modern: valori di colore moderni riconosciuti'
      },
      text: {
        de: 'Beim Umschalten zwischen Classic und Modern wurde das Marken-Orange auf manchen Seiten nicht mehr umgefärbt, weil claude.ai Farben zunehmend über modernere CSS-Funktionen wie oklch() oder color-mix() setzt, die die bisherige Farberkennung nicht verstand. Nicht erkannte Werte werden jetzt zusätzlich über ein unsichtbares Canvas in echte Pixelfarben umgerechnet.',
        en: 'When switching between Classic and Modern, the brand orange stopped being recolored on some pages, because claude.ai increasingly sets colors through newer CSS functions like oklch() or color-mix(), which the existing color detection did not understand. Unrecognized values are now additionally converted to real pixel colors via an invisible canvas.',
        fr: 'En basculant entre Classic et Modern, l’orange de la marque n’était plus recoloré sur certaines pages, car claude.ai définit de plus en plus les couleurs via des fonctions CSS plus récentes comme oklch() ou color-mix(), que la détection de couleur existante ne comprenait pas. Les valeurs non reconnues sont désormais aussi converties en véritables couleurs de pixel via un canevas invisible.',
        it: 'Passando tra Classic e Modern, l’arancione del marchio non veniva più ricolorato in alcune pagine, perché claude.ai imposta sempre più spesso i colori tramite funzioni CSS più recenti come oklch() o color-mix(), che il rilevamento colore esistente non comprendeva. I valori non riconosciuti vengono ora convertiti anche in veri colori dei pixel tramite un canvas invisibile.'
      }
    }
  ],
  '1.4.8': [
    {
      icon: 'shield',
      image: 'whatsnew/cf-verify.png',
      title: {
        de: 'Cloudflare-Verifizierung: Browser-Kennung korrigiert',
        en: 'Cloudflare verification: browser identity fix',
        fr: 'Vérification Cloudflare : identité du navigateur corrigée',
        it: 'Verifica Cloudflare: identità del browser corretta'
      },
      text: {
        de: 'Die App meldete der Cloudflare-Sicherheitsprüfung im HTTP-Header eine Browser-Kennung ("Google Chrome"), die die JavaScript-Schnittstelle des eingebauten Browsers gar nicht bestätigt. Ein echter Browser hält beides identisch, die Abweichung war ein Bot-Signal, das die Prüfung in eine Schleife laufen lassen konnte. Header und JavaScript-Kennung stimmen jetzt überein (durchgängig Chromium). Zusätzlich wird der "Do Not Track"-Header nicht mehr gesendet, da ein normales Chrome ihn standardmäßig auch nicht sendet.',
        en: 'The app told the Cloudflare security check, in the HTTP header, a browser identity ("Google Chrome") that the JavaScript interface of the built-in browser does not confirm. A real browser keeps both identical, so the mismatch was a bot signal that could send the check into a loop. Header and JavaScript identity now match (consistent Chromium). The "Do Not Track" header is also no longer sent, since a normal Chrome does not send it by default either.',
        fr: 'L’application indiquait à la vérification de sécurité Cloudflare, dans l’en-tête HTTP, une identité de navigateur (« Google Chrome ») que l’interface JavaScript du navigateur intégré ne confirme pas. Un vrai navigateur garde les deux identiques, cet écart était un signal de bot qui pouvait faire tourner la vérification en boucle. L’en-tête et l’identité JavaScript correspondent désormais (Chromium cohérent). L’en-tête « Do Not Track » n’est plus envoyé non plus, car un Chrome normal ne l’envoie pas par défaut.',
        it: 'L’app comunicava al controllo di sicurezza di Cloudflare, nell’header HTTP, un’identità del browser ("Google Chrome") che l’interfaccia JavaScript del browser integrato non conferma. Un browser reale le mantiene identiche, quindi questa differenza era un segnale da bot che poteva mandare il controllo in un ciclo. Ora header e identità JavaScript coincidono (Chromium coerente). Inoltre l’header "Do Not Track" non viene più inviato, poiché nemmeno un normale Chrome lo invia per impostazione predefinita.'
      }
    },
    {
      icon: 'refresh',
      title: {
        de: 'Bessere Hilfe bei hängender Verifizierung',
        en: 'Better help when verification gets stuck',
        fr: 'Meilleure aide en cas de vérification bloquée',
        it: 'Aiuto migliore quando la verifica si blocca'
      },
      text: {
        de: 'Bleibt die Cloudflare-Sicherheitsprüfung in einer Schleife hängen, erklärt der Hinweis auf der Seite jetzt genauer, was hilft: Zurücksetzen leert nur Cookies und Cache und behebt nur eine veraltete Cookie-Schleife. Hängt die Prüfung weiter, liegt es an der Netzwerk-Adresse: ein aktives VPN ist oft die Ursache (für claude.ai ausschalten), sonst hilft ein anderes Netzwerk. So landet man nicht mehr beim wirkungslosen wiederholten Zurücksetzen.',
        en: 'When the Cloudflare security check is stuck in a loop, the on-page notice now explains more precisely what helps: Reset only clears cookies and cache and only fixes a stale-cookie loop. If the check keeps looping, it is your network address: an active VPN is often the cause (turn it off for claude.ai), otherwise a different network helps. No more dead-end repeated resetting.',
        fr: 'Lorsque la vérification de sécurité Cloudflare tourne en boucle, le message sur la page explique désormais plus précisément ce qui aide : la réinitialisation efface seulement les cookies et le cache et ne corrige qu’une boucle due à un cookie obsolète. Si la vérification continue de boucler, cela vient de votre adresse réseau : un VPN actif en est souvent la cause (désactivez-le pour claude.ai), sinon un autre réseau aide. Fini la réinitialisation répétée et sans effet.',
        it: 'Quando il controllo di sicurezza di Cloudflare resta bloccato in un ciclo, l’avviso sulla pagina ora spiega più precisamente cosa aiuta: la reimpostazione cancella solo cookie e cache e risolve soltanto un ciclo dovuto a un cookie obsoleto. Se il controllo continua a ripetersi, dipende dal tuo indirizzo di rete: una VPN attiva è spesso la causa (disattivala per claude.ai), altrimenti aiuta una rete diversa. Niente più reimpostazioni ripetute e inutili.'
      }
    },
    {
      icon: 'shield',
      title: {
        de: 'Reset-Knopf jetzt in der Leiste',
        en: 'Reset button now in the toolbar',
        fr: 'Bouton de réinitialisation dans la barre',
        it: 'Pulsante di reimpostazione nella barra'
      },
      text: {
        de: 'Das Zurücksetzen der Verifizierung ist jetzt direkt über ein Schild-Symbol oben in der Leiste erreichbar, nicht mehr nur versteckt im Menü. Praktisch, wenn die Cloudflare-Prüfung hängt und du schnell handeln willst.',
        en: 'Resetting verification is now reachable directly via a shield icon in the top toolbar, no longer only hidden in the menu. Handy when the Cloudflare check is stuck and you want to act fast.',
        fr: 'La réinitialisation de la vérification est désormais accessible directement via une icône bouclier dans la barre du haut, plus seulement cachée dans le menu. Pratique quand la vérification Cloudflare bloque et que vous voulez agir vite.',
        it: 'La reimpostazione della verifica è ora raggiungibile direttamente tramite un’icona scudo nella barra in alto, non più solo nascosta nel menu. Utile quando il controllo Cloudflare si blocca e vuoi agire in fretta.'
      }
    },
    {
      icon: 'bolt',
      title: {
        de: 'Neugestaltetes „Was ist neu“-Fenster',
        en: 'Redesigned update window',
        fr: 'Fenêtre des nouveautés repensée',
        it: 'Finestra delle novità ridisegnata'
      },
      text: {
        de: 'Die Update-Übersicht ist jetzt eine kleine Diashow: ein Punkt pro Neuerung, zum Durchklicken mit Weiter/Zurück, den Punkten oder den Pfeiltasten, dazu eine dezente Animation und Platz für ein Bild. Du liest sie gerade.',
        en: 'The update overview is now a small slideshow: one slide per change, click through with next/back, the dots or the arrow keys, with a subtle animation and room for an image. You are reading it right now.',
        fr: 'L’aperçu des mises à jour est désormais un petit diaporama : une diapositive par nouveauté, à parcourir avec suivant/retour, les points ou les flèches, avec une animation discrète et de la place pour une image. Vous êtes en train de le lire.',
        it: 'La panoramica degli aggiornamenti ora è una piccola presentazione: una diapositiva per novità, da sfogliare con avanti/indietro, i punti o le frecce, con un’animazione discreta e spazio per un’immagine. La stai leggendo proprio ora.'
      }
    }
  ],
  '1.4.7': [
    {
      icon: 'bolt',
      title: {
        de: 'OLED-Modus aufpoliert',
        en: 'OLED mode polished',
        fr: 'Mode OLED peaufiné',
        it: 'Modalità OLED rifinita'
      },
      text: {
        de: 'Im OLED-Modus waren dunkle Flächen kaum voneinander zu unterscheiden. Menüs, Karten und Dialoge haben jetzt feine Trennlinien, die Seitenleiste ist klar vom Chat abgegrenzt, und der Fokusrahmen um Eingabefelder ist dezenter. Neu ist ein zurückhaltender Rahmen um das Fenster und die Dialoge, oben etwas heller und nach unten dunkler werdend, der sich dem Theme anpasst. Der Schließen-Button übernimmt jetzt die Akzentfarbe des gewählten Designs.',
        en: 'In OLED mode, dark areas were hard to tell apart. Menus, cards and dialogs now have thin separator lines, the sidebar is clearly set off from the chat, and the focus ring around input fields is more subtle. There is also a restrained frame around the window and dialogs, a little lighter at the top and darker toward the bottom, that adapts to the theme. The close button now takes on the accent color of the selected design.',
        fr: 'En mode OLED, les zones sombres étaient difficiles à distinguer. Les menus, cartes et boîtes de dialogue ont désormais de fines lignes de séparation, la barre latérale se détache nettement du chat, et le contour de focus autour des champs de saisie est plus discret. Un cadre sobre entoure également la fenêtre et les boîtes de dialogue, un peu plus clair en haut et plus sombre vers le bas, et s’adapte au thème. Le bouton de fermeture reprend maintenant la couleur d’accent du design choisi.',
        it: 'In modalità OLED le aree scure erano difficili da distinguere. Menu, schede e finestre di dialogo ora hanno sottili linee di separazione, la barra laterale si stacca nettamente dalla chat e il contorno di focus attorno ai campi di immissione è più discreto. È stata aggiunta anche una cornice sobria attorno alla finestra e alle finestre di dialogo, un po’ più chiara in alto e più scura verso il basso, che si adatta al tema. Il pulsante di chiusura ora assume il colore d’accento del design scelto.'
      }
    },
    {
      icon: 'settings',
      title: {
        de: 'Einstellungsfenster im Dunkelmodus',
        en: 'Settings window in dark mode',
        fr: 'Fenêtre des paramètres en mode sombre',
        it: 'Finestra delle impostazioni in modalità scura'
      },
      text: {
        de: 'Im OLED-Modus war im Einstellungsfenster eine helle graue Fläche neben der dunklen Seitenleiste zu sehen, und die Sterne des Hintergrunds schimmerten durch. Die Fläche ist jetzt durchgehend dunkel, die Sterne werden ausgeblendet, solange ein Fenster im Vordergrund liegt, und das Suchfeld wirkt ruhiger.',
        en: 'In OLED mode the settings window showed a light gray area next to the dark sidebar, and the background stars shimmered through. The area is now uniformly dark, the stars are hidden while a dialog is open, and the search field looks calmer.',
        fr: 'En mode OLED, la fenêtre des paramètres affichait une zone gris clair à côté de la barre latérale sombre, et les étoiles de l’arrière-plan transparaissaient. La zone est désormais uniformément sombre, les étoiles sont masquées tant qu’une boîte de dialogue est ouverte, et le champ de recherche paraît plus calme.',
        it: 'In modalità OLED la finestra delle impostazioni mostrava un’area grigio chiaro accanto alla barra laterale scura e le stelle dello sfondo trasparivano. Ora l’area è uniformemente scura, le stelle vengono nascoste finché una finestra di dialogo è aperta e il campo di ricerca appare più tranquillo.'
      }
    },
    {
      icon: 'refresh',
      title: {
        de: 'Schwarzes Fenster beim geteilten Bildschirm',
        en: 'Black window when tiling',
        fr: 'Fenêtre noire en écran partagé',
        it: 'Finestra nera a schermo diviso'
      },
      text: {
        de: 'Auf einer Bildschirmhälfte (Tiling) konnte das Fenster komplett schwarz bleiben, nur die Titelleiste war sichtbar. Nach dem Ändern der Fenstergröße erzwingt die App jetzt eine Neuzeichnung, sodass der Inhalt zuverlässig wieder erscheint.',
        en: 'When tiled to half the screen, the window could turn fully black with only the title bar showing. After a resize, the app now forces a redraw so the content reliably comes back.',
        fr: 'Placée sur une moitié d’écran (tiling), la fenêtre pouvait devenir entièrement noire, seule la barre de titre restant visible. Après un redimensionnement, l’application force désormais un nouveau rendu pour que le contenu réapparaisse de façon fiable.',
        it: 'Affiancata a metà schermo (tiling), la finestra poteva diventare completamente nera, con solo la barra del titolo visibile. Dopo un ridimensionamento, l’app forza ora un nuovo disegno così che il contenuto riappaia in modo affidabile.'
      }
    }
  ],
  '1.4.6': [
    {
      icon: 'shield',
      title: {
        de: 'Weniger Absturz-Dialoge',
        en: 'Fewer crash pop-ups',
        fr: 'Moins de fenêtres d’erreur',
        it: 'Meno finestre di errore'
      },
      text: {
        de: 'Auf der Snap-Version konnte unvermittelt das Fenster „A JavaScript error occurred in the main process" erscheinen. Auslöser war die Hintergrund-Update-Prüfung, die in eine geschlossene Log-Leitung schrieb. Das stürzt die App nicht mehr ab. Im Snap läuft der eingebaute Updater jetzt gar nicht mehr, da der Snap Store die Updates übernimmt. Auch weitere seltene Absturzquellen (externe Links öffnen, Benachrichtigungen unter striktem Snap-Confinement) werden jetzt abgefangen.',
        en: 'On the Snap build an "A JavaScript error occurred in the main process" window could appear out of nowhere. It came from the background update check writing to a closed log pipe. That no longer crashes the app, and on Snap the built-in updater no longer runs at all, since the Snap Store handles updates. Other rare crash sources (opening external links, notifications under strict Snap confinement) are now caught too.',
        fr: 'Sur la version Snap, une fenêtre « A JavaScript error occurred in the main process » pouvait surgir sans raison. Elle venait de la vérification des mises à jour en arrière-plan qui écrivait dans un canal de log fermé. Cela ne fait plus planter l’application, et sur Snap le programme de mise à jour intégré ne s’exécute plus du tout, car le Snap Store s’en charge. D’autres causes rares de plantage (ouverture de liens externes, notifications sous confinement Snap strict) sont elles aussi interceptées.',
        it: 'Sulla versione Snap poteva comparire all’improvviso una finestra "A JavaScript error occurred in the main process". Derivava dal controllo aggiornamenti in background che scriveva su un canale di log chiuso. Ora questo non manda più in crash l’app e su Snap l’updater integrato non viene più eseguito, perché ci pensa lo Snap Store. Vengono ora intercettate anche altre rare cause di crash (apertura di link esterni, notifiche sotto confinamento Snap stretto).'
      }
    },
    {
      icon: 'refresh',
      title: {
        de: 'Darstellung beim geteilten Bildschirm',
        en: 'Split-screen display fix',
        fr: 'Affichage en écran partagé',
        it: 'Visualizzazione a schermo diviso'
      },
      text: {
        de: 'Beim Anordnen des Fensters auf eine Bildschirmhälfte (Tiling) blieb die Seite manchmal auf der alten Größe stehen: Inhalt nach oben verschoben, unten ein grauer Streifen. Nach dem Ändern der Fenstergröße passt die App die Seite jetzt zuverlässig an die endgültige Größe an.',
        en: 'When you tiled the window to half the screen, the page could stay stuck at the old size: content shifted up, a gray strip left at the bottom. After a resize settles, the app now reliably re-fits the page to the final window size.',
        fr: 'En plaçant la fenêtre sur une moitié d’écran (tiling), la page pouvait rester à l’ancienne taille : contenu décalé vers le haut, bande grise en bas. Une fois le redimensionnement terminé, l’application réajuste désormais la page à la taille finale de la fenêtre.',
        it: 'Affiancando la finestra a metà schermo (tiling), la pagina poteva restare alla vecchia dimensione: contenuto spostato in alto, una striscia grigia in basso. Al termine del ridimensionamento, l’app ora riadatta in modo affidabile la pagina alla dimensione finale della finestra.'
      }
    },
    {
      icon: 'cog',
      title: {
        de: 'Anmeldung bei Connectors',
        en: 'Connector sign-in',
        fr: 'Connexion aux connecteurs',
        it: 'Accesso ai connettori'
      },
      text: {
        de: 'Anmelde-Popups, die ein weiteres Fenster öffnen (etwa bei Microsoft), bleiben jetzt in der App und in deiner Sitzung, statt ein unkontrolliertes Fenster zu öffnen. Externe Links während der Anmeldung werden strenger behandelt: eingebettete Bereiche dürfen nicht mehr beliebigen Anmelde-Adressen folgen, und eine Anmeldung auf einer Anbieterseite bleibt auf deren eigene Domain begrenzt.',
        en: 'Sign-in popups that open another window (for example with Microsoft) now stay inside the app and on your session instead of spawning an uncontrolled window. External links during sign-in are handled more strictly: embedded areas can no longer follow arbitrary sign-in URLs, and a sign-in on a provider page stays limited to that provider’s own domain.',
        fr: 'Les fenêtres de connexion qui en ouvrent une autre (par exemple avec Microsoft) restent désormais dans l’application et sur votre session au lieu d’ouvrir une fenêtre non contrôlée. Les liens externes pendant la connexion sont traités plus strictement : les zones intégrées ne peuvent plus suivre n’importe quelle adresse de connexion, et une connexion sur la page d’un fournisseur reste limitée à son propre domaine.',
        it: 'I popup di accesso che ne aprono un altro (ad esempio con Microsoft) ora restano nell’app e nella tua sessione invece di aprire una finestra non controllata. I link esterni durante l’accesso sono gestiti in modo più rigoroso: le aree incorporate non possono più seguire indirizzi di accesso arbitrari e un accesso sulla pagina di un provider resta limitato al suo dominio.'
      }
    },
    {
      icon: 'download',
      title: {
        de: 'Update-Suche im Snap',
        en: 'Update check on Snap',
        fr: 'Recherche de mises à jour (Snap)',
        it: 'Controllo aggiornamenti su Snap'
      },
      text: {
        de: '„Nach Updates suchen" gab in der Snap-Version keine Rückmeldung mehr. Jetzt erscheint der Hinweis, dass Updates über den Snap Store kommen und automatisch installiert werden.',
        en: '"Check for Updates" gave no feedback on the Snap build. It now tells you that updates come from the Snap Store and are installed automatically.',
        fr: '« Rechercher des mises à jour » ne donnait aucun retour sur la version Snap. Un message indique désormais que les mises à jour proviennent du Snap Store et sont installées automatiquement.',
        it: '"Controlla aggiornamenti" non dava alcun riscontro sulla versione Snap. Ora un messaggio indica che gli aggiornamenti arrivano dallo Snap Store e vengono installati automaticamente.'
      }
    }
  ],
  '1.4.5': [
    {
      icon: 'bolt',
      title: {
        de: 'Tastaturfokus nach Alt+Tab',
        en: 'Keyboard focus after Alt+Tab',
        fr: 'Focus clavier après Alt+Tab',
        it: 'Focus da tastiera dopo Alt+Tab'
      },
      text: {
        de: 'Beim Zurückwechseln per Alt+Tab landete der Tastaturfokus auf dem Minimieren-Knopf statt im Chat. Der erste Tastendruck minimierte dann das Fenster, statt zu schreiben. Der Fokus geht jetzt direkt in die Seite zurück.',
        en: 'When you switched back with Alt+Tab, the keyboard focus landed on the minimize button instead of the chat. The first keystroke then minimized the window instead of typing. Focus now goes straight back to the page.',
        fr: 'En revenant avec Alt+Tab, le focus clavier se plaçait sur le bouton Réduire au lieu du chat. La première touche réduisait alors la fenêtre au lieu d’écrire. Le focus revient désormais directement sur la page.',
        it: 'Tornando con Alt+Tab, il focus da tastiera finiva sul pulsante Riduci a icona invece che nella chat. Il primo tasto premuto riduceva la finestra invece di scrivere. Ora il focus torna direttamente alla pagina.'
      }
    }
  ],
  '1.4.4': [
    {
      icon: 'shield',
      title: {
        de: 'Sicherheitsprüfung bleibt seltener hängen',
        en: 'Fewer security-check loops',
        fr: 'Moins de blocages à la vérification de sécurité',
        it: 'Meno blocchi alla verifica di sicurezza'
      },
      text: {
        de: 'Die App meldete sich bei der Cloudflare-Sicherheitsprüfung mit einer Kennung, die ein echter Linux-Browser so nie sendet (der Kernel-Version). Das konnte die Prüfung in eine Schleife laufen lassen. Die Kennung entspricht jetzt exakt der eines normalen Chrome unter Linux. Falls die Prüfung doch hängt, hilft weiterhin „claude.ai-Verifizierung zurücksetzen" im Menü.',
        en: 'The app identified itself to the Cloudflare security check with a value no real Linux browser sends (the kernel version), which could send the check into a loop. That value now matches a normal Chrome on Linux exactly. If the check still hangs, "Reset claude.ai verification" in the menu still helps.',
        fr: 'L’application se présentait à la vérification de sécurité Cloudflare avec une valeur qu’aucun vrai navigateur Linux n’envoie (la version du noyau), ce qui pouvait faire boucler la vérification. Cette valeur correspond désormais exactement à celle d’un Chrome normal sous Linux. Si la vérification se bloque encore, « Réinitialiser la vérification claude.ai » dans le menu reste utile.',
        it: 'L’app si presentava alla verifica di sicurezza di Cloudflare con un valore che nessun browser Linux reale invia (la versione del kernel), e questo poteva mandare la verifica in loop. Ora quel valore corrisponde esattamente a quello di un normale Chrome su Linux. Se la verifica si blocca ancora, "Reimposta la verifica claude.ai" nel menu è ancora d’aiuto.'
      }
    }
  ],
  '1.4.3': [
    {
      icon: 'palette',
      title: {
        de: 'Neues Logo und aufgefrischtes Design',
        en: 'New logo and a refreshed look',
        fr: 'Nouveau logo et un design rafraîchi',
        it: 'Nuovo logo e un design rinfrescato'
      },
      text: {
        de: 'Die App hat ein neues Spark-Logo, und die drei Themes sind von Grund auf neu aufgebaut. Die Farbverläufe im Hintergrund kamen bei vielen nicht gut an, deshalb sind sie überall raus: in den Menüs, den Einstellungs- und Info-Fenstern und im Chat. Jedes Theme ist jetzt klar für sich gebaut: Hell ist ein neutrales Weiß ohne den früheren rötlichen Stich, Dunkel bleibt ruhig und gleichmäßig, und OLED zeigt durchgehend tiefes Schwarz mit ein paar dezenten Sternen im Hintergrund.',
        en: 'The app has a new spark logo, and the three themes are rebuilt from the ground up. The background gradients did not sit well with many people, so they are gone everywhere: in the menus, the settings and info windows, and the chat. Each theme is now built on its own terms: light is a neutral white without the earlier reddish tint, dark stays calm and even, and OLED is consistently deep black with a few subtle stars in the background.',
        fr: 'L’application a un nouveau logo « spark », et les trois thèmes sont reconstruits de zéro. Les dégradés en arrière-plan ne plaisaient pas à beaucoup de monde, ils ont donc disparu partout : dans les menus, les fenêtres de réglages et d’informations, et le chat. Chaque thème est désormais conçu pour lui-même : le clair est un blanc neutre sans la teinte rougeâtre d’avant, le sombre reste calme et homogène, et l’OLED affiche un noir profond et uniforme avec quelques étoiles discrètes en arrière-plan.',
        it: 'L’app ha un nuovo logo spark e i tre temi sono ricostruiti da zero. Le sfumature sullo sfondo non piacevano a molti, quindi sono state rimosse ovunque: nei menu, nelle finestre di impostazioni e informazioni e nella chat. Ogni tema ora è costruito per conto suo: il chiaro è un bianco neutro senza la tinta rossastra di prima, lo scuro resta calmo e uniforme e l’OLED mostra un nero profondo e uniforme con qualche stella discreta sullo sfondo.'
      }
    },
    {
      icon: 'bolt',
      title: {
        de: 'Theme ohne Nachladen',
        en: 'Theme without lag',
        fr: 'Thème sans délai',
        it: 'Tema senza ritardi'
      },
      text: {
        de: 'Das Theme steht jetzt sofort beim App-Start und beim Öffnen eines neuen Tabs. Vorher baute es sich mit kurzer Verzögerung sichtbar auf.',
        en: 'The theme is in place immediately when the app starts and when you open a new tab. Before, it built up visibly with a short delay.',
        fr: 'Le thème est en place immédiatement au démarrage de l’application et à l’ouverture d’un nouvel onglet. Auparavant, il se mettait en place avec un léger délai visible.',
        it: 'Il tema è presente subito all’avvio dell’app e quando apri una nuova scheda. Prima si formava con un breve ritardo visibile.'
      }
    },
    {
      icon: 'plus',
      title: {
        de: 'Eigene Connectors verbinden sich wieder',
        en: 'Custom connectors connect again',
        fr: 'Les connecteurs personnalisés se connectent à nouveau',
        it: 'I connettori personalizzati si collegano di nuovo'
      },
      text: {
        de: 'Beim Hinzufügen eines eigenen Connectors öffnete sich das Anmelde-Popup im Systembrowser, wo die Verbindung nie zurückkam. Es öffnet jetzt in der App, sodass die Verbindung abgeschlossen wird.',
        en: 'When you added a custom connector, the sign-in popup opened in the system browser, where the connection never came back. It now opens inside the app so the connection completes.',
        fr: 'Lors de l’ajout d’un connecteur personnalisé, la fenêtre de connexion s’ouvrait dans le navigateur système, où la connexion n’aboutissait jamais. Elle s’ouvre désormais dans l’application, ce qui permet de terminer la connexion.',
        it: 'Quando aggiungevi un connettore personalizzato, il popup di accesso si apriva nel browser di sistema, dove la connessione non tornava mai. Ora si apre nell’app, così la connessione viene completata.'
      }
    },
    {
      icon: 'download',
      title: {
        de: 'Snap: Dateien anhängen und speichern',
        en: 'Snap: attaching and saving files',
        fr: 'Snap : joindre et enregistrer des fichiers',
        it: 'Snap: allegare e salvare file'
      },
      text: {
        de: 'Unter Snap laufen das Anhängen von Dateien und das Speichern von Downloads jetzt über das System-Dateiportal. Damit erreichst du auch Dateien außerhalb deines persönlichen Ordners und auf externen Datenträgern.',
        en: 'On Snap, attaching files and saving downloads now go through the system file portal, so you can reach files outside your home folder and on external drives.',
        fr: 'Sous Snap, joindre des fichiers et enregistrer des téléchargements passe désormais par le portail de fichiers du système, ce qui permet d’accéder aux fichiers hors de votre dossier personnel et sur des disques externes.',
        it: 'Su Snap, allegare file e salvare i download avviene ora tramite il portale file di sistema, così puoi raggiungere i file fuori dalla tua cartella personale e su unità esterne.'
      },
      if: 'snap'
    },
    {
      icon: 'shield',
      title: {
        de: 'Aktualisierter Unterbau',
        en: 'Updated foundation',
        fr: 'Socle mis à jour',
        it: 'Base aggiornata'
      },
      text: {
        de: 'Aktualisiert auf das neueste Electron 41 mit den aktuellen Chromium-Sicherheitsfixes.',
        en: 'Updated to the latest Electron 41 with the current Chromium security fixes.',
        fr: 'Mise à jour vers la dernière version d’Electron 41 avec les correctifs de sécurité Chromium actuels.',
        it: 'Aggiornato all’ultima versione di Electron 41 con le correzioni di sicurezza di Chromium attuali.'
      }
    }
  ],
  '1.4.2': [
    {
      icon: 'bolt',
      title: {
        de: 'Italienisch und Französisch',
        en: 'Italian and French',
        fr: 'Italien et français',
        it: 'Italiano e francese'
      },
      text: {
        de: 'Die App-Oberfläche gibt es jetzt auch auf Italienisch und Französisch. Sie richtet sich nach deiner Systemsprache; ist deine Sprache nicht dabei, bleibt es bei Englisch.',
        en: 'The app interface is now also available in Italian and French. It follows your system language; if your language is not available, it stays in English.',
        fr: 'L’interface de l’application est désormais disponible en italien et en français. Elle suit la langue de votre système ; si votre langue n’est pas disponible, elle reste en anglais.',
        it: 'L’interfaccia dell’app è ora disponibile anche in italiano e francese. Segue la lingua del sistema; se la tua lingua non è disponibile, resta in inglese.'
      }
    },
    {
      icon: 'settings',
      title: {
        de: 'OLED-Tableiste jetzt einheitlich',
        en: 'OLED tab bar now consistent',
        fr: 'Barre d’onglets OLED uniforme',
        it: 'Barra delle schede OLED uniforme'
      },
      text: {
        de: 'Die Tab-Leiste nutzte beim Live-Umschalten auf OLED einen leicht anderen Schwarzton als beim Start direkt im OLED-Modus. Beide verwenden jetzt denselben Wert.',
        en: 'The tab bar used a slightly different black when you switched to OLED live versus starting up in OLED. Both now use the same value.',
        fr: 'La barre d’onglets utilisait un noir légèrement différent selon que vous passiez en OLED en cours d’usage ou au démarrage. Les deux utilisent désormais la même valeur.',
        it: 'La barra delle schede usava un nero leggermente diverso a seconda che passassi a OLED durante l’uso o all’avvio. Ora entrambe usano lo stesso valore.'
      }
    },
    {
      icon: 'tray',
      title: {
        de: 'Snap: Benachrichtigungen und kleinerer Download',
        en: 'Snap: notifications and a smaller download',
        fr: 'Snap : notifications et téléchargement plus léger',
        it: 'Snap: notifiche e download più leggero'
      },
      text: {
        de: 'Die App meldet sich gegenüber GNOME jetzt korrekt als Absender, damit Antwort- und Download-Benachrichtigungen unter Snap nicht mehr ausgefiltert werden. Außerdem ist der Download etwas kleiner.',
        en: 'The app now identifies itself to GNOME as the sender so reply and download notifications are no longer filtered out on Snap. The download is also a little smaller.',
        fr: 'L’application s’identifie désormais correctement auprès de GNOME, afin que les notifications de réponse et de téléchargement ne soient plus filtrées sous Snap. Le téléchargement est aussi un peu plus léger.',
        it: 'L’app ora si identifica correttamente con GNOME, così le notifiche di risposta e download non vengono più filtrate su Snap. Il download è anche un po’ più leggero.'
      },
      if: 'snap'
    }
  ],
  '1.4.1': [
    {
      icon: 'check',
      title: {
        de: '"Was ist neu" jetzt auch auf Englisch',
        en: '"What’s new" now also localized'
      },
      text: {
        de: 'Auf englischsprachigen Systemen erschienen die Update-Hinweise bislang weiterhin auf Deutsch, weil die Notes-Texte hartkodiert deutsch waren. Sie respektieren jetzt die System-Sprache. Als Nachreichung siehst du unten die Highlights aus 1.4.0 in deiner Sprache.',
        en: 'On non-German systems the update window kept showing German text because the note strings were hard-coded. Notes now follow the system language, and as a one-time catch-up you can read the 1.4.0 highlights below in your language.'
      }
    }
  ],
  '1.3.0': [
    {
      icon: 'tray',
      title: { de: 'Systemtray & Hintergrund-Modus', en: 'System tray & background mode' },
      text: { de: 'Claude l\u00e4uft jetzt im Hintergrund weiter und ist \u00fcber das Tray-Symbol erreichbar.', en: 'Claude now keeps running in the background and is reachable via the tray icon.' }
    },
    {
      icon: 'bolt',
      title: { de: 'Globaler Quick-Prompt', en: 'Global Quick-Prompt' },
      text: { de: 'Ein frei w\u00e4hlbarer Hotkey \u00f6ffnet ein Eingabefenster f\u00fcr neue Chats \u2013 direkt aus jeder App.', en: 'A configurable hotkey opens an input window for new chats, from any app.' }
    },
    {
      icon: 'check',
      title: { de: 'Update-Check mit Feedback', en: 'Update check with feedback' },
      text: { de: 'Das Men\u00fc zeigt jetzt klar an, ob ein Update bereitsteht oder die App aktuell ist.', en: 'The menu now clearly shows whether an update is available or the app is up to date.' }
    },
    {
      icon: 'settings',
      title: { de: 'App-Einstellungen', en: 'App settings' },
      text: { de: 'Neuer Dialog f\u00fcr Tray-Verhalten und Hotkey \u2013 jederzeit \u00fcber das Men\u00fc erreichbar.', en: 'New dialog for tray behavior and hotkey, reachable from the menu any time.' }
    }
  ],
  '1.3.1': [
    {
      icon: 'check',
      title: { de: 'Download-Dialog nicht mehr doppelt', en: 'Download dialog no longer duplicated' },
      text: { de: 'Beim Speichern von Dateien aus Chats erscheint der Dialog jetzt zuverl\u00e4ssig nur einmal \u2013 auch bei Blob- und Redirect-Downloads.', en: 'When saving files from chats, the dialog now reliably appears only once, including for blob and redirect downloads.' }
    },
    {
      icon: 'bolt',
      title: { de: 'Quick-Prompt sendet nicht mehr automatisch', en: 'Quick-Prompt no longer sends automatically' },
      text: { de: 'Der Text wird ins Eingabefeld \u00fcbernommen und der Cursor ans Ende gesetzt. Du dr\u00fcckst selbst Enter zum Absenden.', en: 'The text is placed in the input box with the cursor at the end. You press Enter yourself to send.' }
    },
    {
      icon: 'settings',
      title: { de: 'Dialoge zentriert \u00fcber der App', en: 'Dialogs centered over the app' },
      text: { de: 'Update- und Hinweis-Dialoge \u00f6ffnen sich jetzt zuverl\u00e4ssig zentriert \u00fcber dem App-Fenster \u2013 auch auf Multi-Monitor-Setups.', en: 'Update and notice dialogs now reliably open centered over the app window, including on multi-monitor setups.' }
    },
    {
      icon: 'check',
      title: { de: 'Code-Tab in der Sidebar funktioniert', en: 'Code tab in the sidebar works' },
      text: { de: 'Der Klick auf \u201eCode" in der Sidebar \u00f6ffnet die Seite jetzt korrekt in einem neuen Fenster, statt sich sofort wieder zu schlie\u00dfen.', en: 'Clicking "Code" in the sidebar now correctly opens the page in a new window instead of closing immediately.' }
    },
    {
      icon: 'tray',
      title: { de: 'Tray-Icon besser erkennbar', en: 'Tray icon more visible' },
      text: { de: 'Das Symbol in der Systemleiste zeigt jetzt das Sparkle-Logo gr\u00f6\u00dfer und transparent \u2013 deutlich sichtbar auf hellen wie dunklen Tray-Hintergr\u00fcnden.', en: 'The system tray icon now shows the sparkle logo larger and transparent, clearly visible on light and dark tray backgrounds.' }
    },
    {
      icon: 'bolt',
      title: { de: 'Autostart beim Anmelden', en: 'Autostart at login' },
      text: { de: 'Optional kann Claude jetzt automatisch beim Hochfahren des Systems starten \u2013 ein- und ausschaltbar in den App-Einstellungen.', en: 'Optionally Claude can now launch automatically when the system starts, toggled in the app settings.' }
    }
  ],
  '1.3.3': [
    {
      icon: 'check',
      title: { de: 'Artifact-Vorschauen werden wieder angezeigt', en: 'Artifact previews render again' },
      text: { de: 'HTML-, React- und Wireframe-Vorschauen aus Chats erscheinen jetzt wieder im Vorschau-Panel \u2013 vorher blieb es leer, weil die App den separaten Anzeige-Server (claudeusercontent.com) blockiert hat.', en: 'HTML, React and wireframe previews from chats now show up in the preview panel again. Previously the panel stayed empty because the app blocked the separate display origin (claudeusercontent.com).' }
    }
  ],
  '1.3.4': [
    {
      icon: 'bolt',
      title: { de: 'Direkt aus der App Fehler melden', en: 'Report bugs straight from the app' },
      text: { de: 'Statt eine E-Mail zu schreiben kannst du jetzt einen kurzen Bericht direkt im Fenster ausf\u00fcllen \u2013 mit optionalen Fehlercodes und Kontakt-Mail. App-Version, OS und Sprache werden auf Wunsch automatisch mitgesendet.', en: 'Instead of writing an email you can now fill in a short report directly in the window, with optional error codes and contact mail. App version, OS and language are sent along on request.' }
    },
    {
      icon: 'settings',
      title: { de: 'Dialoge erscheinen \u00fcber der App', en: 'Dialogs appear over the app' },
      text: { de: 'App-Einstellungen, Bug-Report und Update-Hinweise zentrieren sich jetzt auf dem Hauptfenster \u2013 egal wo du die App auf dem Bildschirm hast.', en: 'App settings, Bug Report and update notices now center on the main window, no matter where the app sits on screen.' }
    },
    {
      icon: 'check',
      title: { de: 'Autostart funktioniert jetzt automatisch', en: 'Autostart now works out of the box' },
      text: { de: 'Der Autostart-Schalter in den App-Einstellungen funktioniert ab sofort ohne manuellen Setup-Schritt \u2013 einfach umlegen, fertig.', en: 'The autostart toggle in app settings now works without a manual setup step \u2013 just flip it and you\u2019re done.' },
      if: 'snap'
    }
  ],
  '1.3.5': [
    {
      icon: 'settings',
      title: { de: 'Neue Tab-Leiste mit App-Men\u00fc', en: 'New tab bar with app menu' },
      text: { de: 'Das Men\u00fc-Icon ganz links (\u2261) \u00f6ffnet ein eigenes App-Men\u00fc mit allen wichtigen Funktionen. Zus\u00e4tzlich hat die Tab-Leiste jetzt direkten Zugriff auf Konversations-Export und Bug-Report.', en: 'The menu icon on the far left (\u2261) opens a dedicated app menu with all the important actions. The tab bar also gives you direct access to conversation export and Bug Report.' }
    },
    {
      icon: 'bolt',
      title: { de: 'Konversation als Markdown exportieren', en: 'Export conversation as Markdown' },
      text: { de: 'Mit Strg+Shift+E (oder \u00fcber das Men\u00fc) speicherst du den aktuellen Chat als .md-Datei \u2013 inklusive Code-Bl\u00f6cken, Listen und \u00dcberschriften.', en: 'Ctrl+Shift+E (or via the menu) saves the current chat as an .md file, including code blocks, lists and headings.' }
    },
    {
      icon: 'bolt',
      title: { de: 'Prompt-Templates f\u00fcr den Quick-Prompt', en: 'Prompt templates for the Quick-Prompt' },
      text: { de: 'In den App-Einstellungen legst du eigene Prefix-Texte an (z.B. \u201e\u00dcbersetze ins Englische:"). Im Quick-Prompt-Fenster w\u00e4hlst du sie per Tab aus und tippst nur noch deinen Inhalt.', en: 'In app settings you can define your own prefix texts (e.g. "Translate to English:"). In the Quick-Prompt window you pick one with Tab and only type your content.' }
    },
    {
      icon: 'tray',
      title: { de: 'Benachrichtigung f\u00fcr Hintergrund-Tabs', en: 'Notification for background tabs' },
      text: { de: 'Optional schickt Claude eine native Notification, sobald die Antwort in einem nicht aktiven Tab fertig ist. Aktivierbar in den App-Einstellungen.', en: 'Optionally Claude sends a native notification as soon as a response finishes in an inactive tab. Enabled in app settings.' }
    },
    {
      icon: 'bolt',
      title: { de: 'Zwischenablage als neuer Chat', en: 'Clipboard as a new chat' },
      text: { de: 'Ein eigener globaler Hotkey \u00f6ffnet einen frischen Chat und f\u00fcgt automatisch den Text aus der Zwischenablage als Prompt ein.', en: 'A dedicated global hotkey opens a fresh chat and pastes the clipboard text as the prompt.' }
    },
    {
      icon: 'check',
      title: { de: 'Copy & Paste im Snap funktioniert wieder', en: 'Copy & paste works again in the Snap' },
      text: { de: 'Auf Wayland-Sessions konnte die Snap-Version Inhalte nicht zuverl\u00e4ssig zwischen Apps kopieren. Mit dem neuen Launch-Pfad (native Wayland-Clipboard) klappt Kopieren und Einf\u00fcgen jetzt sauber.', en: 'On Wayland sessions the Snap build could not reliably copy between apps. With the new launch path (native Wayland clipboard) copy and paste now work cleanly.' },
      if: 'snap'
    },
    {
      icon: 'heart',
      title: { de: 'Danke f\u00fcrs Nutzen!', en: 'Thanks for using the app!' },
      text: { de: 'St\u00f6\u00dft du auf einen Fehler? Bitte \u00fcber das K\u00e4fer-Symbol oben in der Tab-Leiste melden \u2013 jeder Bericht hilft mir, die App zu verbessern. Vielen Dank f\u00fcr deinen Support.', en: 'Hit a bug? Please report it via the bug icon at the top of the tab bar \u2013 every report helps me improve the app. Thanks for your support.' }
    }
  ],
  '1.3.6': [
    {
      icon: 'bolt',
      title: { de: 'Spracheingabe per Mikrofon', en: 'Voice input via microphone' },
      text: { de: 'Beim ersten Klick auf das Mikrofon-Symbol in claude.ai fragt die App einmal um Erlaubnis. Du kannst die Berechtigung jederzeit in den App-Einstellungen unter \u201eMikrofon" wieder ausschalten.', en: 'The first time you click the microphone icon in claude.ai, the app asks once for permission. You can disable it again any time in app settings under "Microphone".' }
    },
    {
      icon: 'settings',
      title: { de: 'Snap: Mikrofon mit einem Klick freigeben', en: 'Snap: enable the microphone in one click' },
      text: { de: 'Im Hinweis-Dialog zeigt dir die App den Snap-Berechtigungs-Status live. \u201eIm Snap-Store \u00f6ffnen" springt direkt in den Store \u2013 oder du kopierst den Terminal-Befehl mit einem Klick. Der Dialog erkennt die Aktivierung automatisch, egal welchen Weg du nimmst.', en: 'The consent dialog shows the live Snap permission status. "Open in Snap Store" jumps straight to the store, or you copy the terminal command with one click. The dialog detects the activation automatically either way.' },
      if: 'snap'
    },
    {
      icon: 'bolt',
      title: { de: 'Live-Hinweise direkt in der App', en: 'Live notices directly in the app' },
      text: { de: 'Wichtige Hinweise (z.B. zu bekannten Problemen oder Updates) erscheinen jetzt als Banner \u00fcber der Tab-Leiste. Sie kommen direkt vom Projekt-Repo und k\u00f6nnen jederzeit per Klick auf das \u00d7 weggeschoben werden.', en: 'Important notices (e.g. known issues or updates) now appear as banners above the tab bar. They come straight from the project repo and can be dismissed any time by clicking \u00d7.' }
    }
  ],
  '1.3.7': [
    {
      icon: 'check',
      title: { de: 'App startet nach Auto-Update wieder zuverl\u00e4ssig', en: 'App launches reliably again after auto-update' },
      text: { de: 'Nach einem automatischen Update startete die App beim n\u00e4chsten Aufruf \u00fcber den Men\u00fc-Eintrag manchmal nicht mehr, weil die Verkn\u00fcpfung noch auf die alte Datei zeigte. Das ist behoben \u2013 die Verkn\u00fcpfungen werden jetzt bei jedem Start gepr\u00fcft und bei Bedarf automatisch auf die aktuelle Version umgebogen.', en: 'After an automatic update, launching via the menu entry sometimes failed because the shortcut still pointed to the old file. Fixed \u2013 shortcuts are now checked on every start and silently retargeted to the current version when needed.' }
    },
    {
      icon: 'check',
      title: { de: 'Stabiler Start aus dem App-Men\u00fc', en: 'Stable launch from the system menu' },
      text: { de: 'Beim Start aus dem System-App-Men\u00fc oder per Doppelklick aus dem Dateimanager kam es nach Updates teils zu Sandbox-Fehlern. Die App setzt das n\u00f6tige Flag jetzt selbst, der Start ist wieder stabil.', en: 'Launching from the system app menu or by double-click from the file manager occasionally hit sandbox errors after updates. The app now sets the required flag itself, so launch is stable again.' }
    }
  ],
  '1.3.8': [
    {
      icon: 'check',
      title: { de: 'Snap: Mikrofon-Status live im Settings sichtbar', en: 'Snap: microphone status visible live in settings' },
      text: { de: 'In den App-Einstellungen unter \u201eMikrofon" zeigt eine kleine farbige Anzeige jetzt direkt, ob die Audio-Record-Berechtigung im Snap aktiv ist. Wenn du den Schalter aktivierst und die Berechtigung noch fehlt, ploppt der Hilfedialog automatisch auf.', en: 'In app settings under "Microphone" a small colored indicator now shows directly whether the Snap audio-record permission is active. If you toggle the switch and the permission is still missing, the help dialog opens automatically.' }
    },
    {
      icon: 'bolt',
      title: { de: 'Hinweis-Dialog merkt, wenn du die Snap-Berechtigung aktivierst', en: 'Consent dialog notices when you enable the Snap permission' },
      text: { de: 'Sobald du im Snap-Store \u201eAudio Record" einschaltest oder den Befehl im Terminal ausf\u00fchrst, blinkt der Erlauben-Knopf im Mikrofon-Hinweis kurz auf \u2013 du musst nicht raten, ob alles geklappt hat.', en: 'The moment you enable "Audio Record" in the Snap Store or run the terminal command, the Allow button in the microphone notice briefly flashes \u2013 no guessing whether it took effect.' }
    },
    {
      icon: 'settings',
      title: { de: 'Robustere Antwort-Erkennung', en: 'More robust response detection' },
      text: { de: 'Die Hintergrund-Benachrichtigung \u201eClaude ist fertig" pr\u00fcft jetzt mehrere Strategien parallel. Wenn claude.ai sein Layout \u00e4ndert, greift einer der Fallbacks und die Notifications bleiben am Laufen.', en: 'The background "Claude is done" notification now checks several strategies in parallel. When claude.ai changes its layout, one of the fallbacks takes over and notifications keep working.' }
    },
    {
      icon: 'bug',
      title: { de: 'Klarer Hinweis im Bug-Report', en: 'Clear notice in the Bug Report' },
      text: { de: 'Im Fehler-melden-Fenster steht jetzt ein deutlicher Hinweis: das hier ist ein inoffizieller Community-Wrapper, kein offizieller Anthropic-Support. Bei Account-, Login-, Abo- oder Bezahl-Fragen f\u00fchrt ein Link direkt zu support.anthropic.com.', en: 'The Bug Report window now carries a clear notice: this is an unofficial community wrapper, not official Anthropic support. A link points to support.anthropic.com for account, login, subscription or billing questions.' }
    }
  ],
  '1.3.9': [
    {
      icon: 'check',
      title: { de: 'Wayland: Fenster landen wieder dort, wo sie hingeh\u00f6ren', en: 'Wayland: windows land where they should again' },
      text: { de: 'Auf Wayland-Sitzungen (GNOME, KDE Plasma) sind App-Men\u00fc, Einstellungen, Bug-Report und das Quick-Prompt-Fenster zuvor an zuf\u00e4lligen Stellen \u00fcber den Bildschirm verteilt aufgeploppt \u2013 weil Wayland clientseitige Fenster-Positionierung nicht erlaubt. Die App startet auf Wayland jetzt automatisch \u00fcber XWayland (so wie es VS Code, Discord und Signal auch machen). Dialoge sitzen wieder zentriert, das App-Men\u00fc \u00f6ffnet direkt unter dem Hamburger-Button.', en: 'On Wayland sessions (GNOME, KDE Plasma) the app menu, settings, Bug Report and the Quick-Prompt window used to pop up at random positions across the screen because Wayland does not allow client-side window positioning. On Wayland the app now starts via XWayland automatically (like VS Code, Discord and Signal do). Dialogs are centered again, and the app menu opens directly under the hamburger button.' }
    },
    {
      icon: 'bug',
      title: { de: 'Bug-Report-Fenster nicht mehr mehrfach aufrufbar', en: 'Bug Report window can no longer open multiple times' },
      text: { de: 'Mehrfach-Klick auf das K\u00e4fer-Symbol hat zuvor mehrere identische Bug-Report-Fenster nebeneinander ge\u00f6ffnet. Jetzt fokussiert die App das bestehende Fenster, statt ein neues zu spawnen.', en: 'Multi-clicking the bug icon used to open multiple identical Bug Report windows side by side. The app now focuses the existing window instead of spawning a new one.' }
    },
    {
      icon: 'settings',
      title: { de: 'Hamburger-Men\u00fc \u00f6ffnet sich nur noch einmal', en: 'Hamburger menu only opens once' },
      text: { de: 'Schnelles Mehrfach-Klicken auf das Men\u00fc-Icon konnte zuvor mehrere Men\u00fc-Fenster gleichzeitig erzeugen. Der Cooldown greift jetzt sofort beim Klick, nicht erst nach dem Schlie\u00dfen.', en: 'Rapidly multi-clicking the menu icon could previously create several menu windows at once. The cooldown now kicks in on click, not only after closing.' }
    },
    {
      icon: 'bolt',
      title: { de: 'Hinweis bei nicht registrierbarem Hotkey', en: 'Note when a hotkey cannot be registered' },
      text: { de: 'Falls die Registrierung eines globalen Hotkeys auf Wayland am Compositor scheitert (GNOME erlaubt es z.B. eingeschr\u00e4nkt), zeigt das App-Einstellungen-Fenster jetzt einen klaren Hinweistext, statt eine generische Fehlermeldung.', en: 'If registering a global hotkey on Wayland fails at the compositor (GNOME, for example, only allows it in a limited way), the app settings window now shows a clear hint text instead of a generic error.' }
    }
  ],
  '1.4.0': [
    {
      icon: 'settings',
      title: {
        de: 'Rahmenloses Fenster mit eigener Leiste',
        en: 'Frameless window with a custom bar'
      },
      text: {
        de: 'Das Hauptfenster läuft jetzt ohne System-Titelleiste. Tab-Bar und Window-Controls (Minimieren, Maximieren, Schließen) liegen direkt nebeneinander, ziehen funktioniert weiterhin überall auf den freien Bereichen der Leiste. Doppelklick auf die Leiste maximiert bzw. stellt wieder her.',
        en: 'The main window now runs without the system title bar. The tab bar and window controls (Minimize, Maximize, Close) sit next to each other; dragging still works on any free area of the bar. Double-clicking the bar toggles maximize.'
      }
    },
    {
      icon: 'settings',
      title: {
        de: 'OLED-Theme als drittes Design',
        en: 'OLED theme as a third mode'
      },
      text: {
        de: 'Das Sonne/Mond-Icon in der Leiste schaltet jetzt zwischen drei Modi um: Hell, Dunkel und OLED. Im OLED-Modus wird claude.ai auf einen warmen schwarzen Untergrund mit Brand-Glow umgefärbt – ideal für OLED-Bildschirme. Mit diesem Update ist OLED einmalig vorausgewählt; wer lieber Hell oder das klassische Dunkel möchte, klickt einfach das Sonne/Mond-Icon weiter, der Wechsel wird wie gewohnt gespeichert.',
        en: 'The sun/moon icon in the bar now cycles through three modes: Light, Dark and OLED. In OLED mode claude.ai is rendered on a warm near-black background with a subtle brand glow, ideal for OLED screens. OLED is preselected on the first launch after the update; click the sun/moon icon to switch back to Light or the classic Dark, and your choice is remembered as usual.'
      }
    },
    {
      icon: 'bolt',
      title: {
        de: 'Animierter Gradient um den Chat-Block',
        en: 'Animated gradient around the chat box'
      },
      text: {
        de: 'Das Eingabefeld auf der claude.ai-Startseite bekommt jetzt einen feinen, animierten Verlauf in der Markenfarbe – Orange wandert zu Magenta und zurück, im gleichen Stil wie das Quick-Prompt-Fenster.',
        en: 'The composer on the claude.ai home screen now gets a thin animated brand-color gradient, orange shifting to magenta and back, matching the Quick-Prompt window style.'
      }
    },
    {
      icon: 'settings',
      title: {
        de: 'Alle Dialoge im neuen rahmenlosen Stil',
        en: 'All dialogs in the new frameless style'
      },
      text: {
        de: '"Was ist neu", "Über Claude Desktop", Einstellungen und Fehler-Report nutzen jetzt dieselbe kompakte Titelleiste wie das Hauptfenster, mit eigenem X-Knopf rechts und im OLED-Modus mit dezentem Brand-Glow im Hintergrund.',
        en: '"What’s new", "About Claude Desktop", Settings and Bug Report now use the same compact title bar as the main window, with their own close button on the right and a subtle brand glow in the background while in OLED mode.'
      }
    },
    {
      icon: 'bolt',
      title: {
        de: '"Was ist neu" neu gestaltet',
        en: '"What’s new" redesigned'
      },
      text: {
        de: 'Das Update-Fenster, das du gerade vor dir hast, ist neu: animierter Brand-Hero oben, Highlights als Kacheln im Raster mit Icon-Kachel pro Punkt. Übersichtlicher und passt zum restlichen Design.',
        en: 'The update window you are looking at is new: an animated brand hero at the top, highlights laid out as a grid of tiles with an icon per entry. Cleaner and consistent with the rest of the design.'
      }
    },
    {
      icon: 'check',
      title: {
        de: 'Logo passt sich dem Theme an',
        en: 'Logo adapts to the theme'
      },
      text: {
        de: 'Das App-Logo im "Über"-Fenster, im Hamburger-Menü und im Quick-Prompt erscheint im OLED-Modus auf einer dunklen Kachel mit zarter Brand-Aura, damit das Symbol nicht im Schwarz verschwindet.',
        en: 'In OLED mode the app logo in the About window, hamburger menu and Quick-Prompt sits on a dark tile with a soft brand aura, so the icon stays visible against the near-black background.'
      }
    },
    {
      icon: 'check',
      title: {
        de: 'Stabilität und kleinere Fixes',
        en: 'Stability and small fixes'
      },
      text: {
        de: 'Window-Controls-IPC prüft jetzt die Absender-WebContents, sodass nur das Hauptfenster sich selbst minimieren/schließen kann. Der OLED-Intro-Status wird sofort persistiert, ein Crash kurz nach App-Start triggert die Voreinstellung nicht erneut. Sidebar-Einträge in claude.ai sind im OLED nicht mehr als einzelne Kacheln sichtbar, sondern flach mit dezentem Hover. Popup-Menüs (Account, Connectors) bekommen einen leicht abgesetzten Untergrund. Das Bug-Report-Fenster nutzt jetzt dieselben Theme-Farben wie die übrige App; der Senden-Knopf hat im "Modern"-Design jetzt den Orange-Magenta-Verlauf wie alle anderen Primary-Buttons.',
        en: 'Window-controls IPC now verifies the sender WebContents, so only the main window can minimize/close itself. The OLED intro flag is persisted immediately so a crash shortly after launch does not trigger the preselect again. claude.ai sidebar entries no longer appear as separate tiles in OLED, but render flat with a subtle hover. Popup menus (Account, Connectors) get a slightly offset background. The Bug Report window now uses the same theme colors as the rest of the app; the Send button in the "Modern" design gets the same orange-magenta gradient as all other primary buttons.'
      }
    }
  ],
  '1.3.13': [
    {
      icon: 'check',
      title: {
        de: 'Hilfe bei hängender Verifizierungs-Seite',
        en: 'In-page help when verification gets stuck'
      },
      text: {
        de: 'Bleibt die Cloudflare-Sicherheitsprüfung in einer Schleife hängen, erscheint nach einigen Sekunden ein Banner direkt auf der Seite. Ein Klick auf "Zurücksetzen" leert Cookies und Cache für claude.ai und lädt die Seite neu, ohne dass du den versteckten Menüpunkt suchen musst.',
        en: 'If the Cloudflare check loops, a banner now appears directly on the page after a few seconds. Clicking "Reset" clears claude.ai cookies and cache and reloads the page, no hidden menu entry required.'
      }
    },
    {
      icon: 'settings',
      title: {
        de: 'Info-Fenster im Menü',
        en: 'About window in the menu'
      },
      text: {
        de: 'Das Hamburger-Menü hat jetzt die Punkte "Über Claude Desktop" und "Was ist neu?". Das Info-Fenster zeigt Version, eine Kurzbeschreibung, Links zu GitHub und zum Anthropic-Support sowie den Markenhinweis. "Was ist neu?" lässt sich darüber jederzeit öffnen, nicht mehr nur nach einem Update.',
        en: 'The hamburger menu now has "About Claude Desktop" and "What’s new?" entries. The About window shows the version, a short description, links to GitHub and Anthropic Support, plus the trademark notice. "What’s new?" can be opened any time from there, not just after an update.'
      }
    }
  ],
  '1.3.12': [
    {
      icon: 'check',
      title: {
        de: 'Higgsfield-Connector lässt sich verbinden',
        en: 'Higgsfield connector can be linked'
      },
      text: {
        de: 'Beim Klick auf "Connect" / "Accept" im Higgsfield-Connector-Dialog auf claude.ai passierte vorher nichts Sichtbares. Ursache: `higgsfield.ai` war in der OAuth-Allowlist nicht eingetragen, daher wurde das Auth-Popup in den Systembrowser umgeleitet, wo der Callback zurück zur App nicht ankam. `higgsfield.ai` und Subdomains gelten jetzt als OAuth-Domain — das Popup öffnet in der App, Callback landet in derselben Session.',
        en: 'Clicking "Connect" / "Accept" in the Higgsfield connector dialog on claude.ai previously did nothing visible. Cause: `higgsfield.ai` was not in the OAuth allowlist, so the auth popup was redirected to the system browser where the callback never reached the app. `higgsfield.ai` and its subdomains now count as OAuth domains, the popup opens inside the app, and the callback lands in the same session.'
      }
    },
    {
      icon: 'check',
      title: {
        de: 'Bug-Report-Dialog: Buttons nicht mehr abgeschnitten',
        en: 'Bug Report dialog: buttons no longer cut off'
      },
      text: {
        de: 'Der in 1.3.11 hinzugefügte Browser-Gegencheck-Hinweis hat den Disclaimer-Block länger gemacht, die Fensterhöhe (760 px) blieb aber gleich – "Abbrechen" und "Bericht senden" waren je nach Skalierung halb oder ganz unten weggeschnitten. Höhe von 760 auf 860 px erhöht.',
        en: 'The browser-cross-check note added in 1.3.11 made the disclaimer block longer, but the window height (760 px) stayed the same, so "Cancel" and "Send report" were partly or fully cut off depending on scaling. Height bumped from 760 to 860 px.'
      }
    },
    {
      icon: 'bug',
      title: {
        de: 'Kleine Aufräumarbeiten',
        en: 'Small cleanups'
      },
      text: {
        de: 'mailto:-Links aus claude.ai öffnen jetzt auch dann den Mail-Client, wenn sie aus der Navigation kommen (vorher nur aus `window.open()`). Außerdem interne Kommentar-Aufräumung in main.js; rein kosmetisch.',
        en: 'mailto: links from claude.ai now open the mail client even when they come from navigation events (previously only from `window.open()`). Plus internal comment cleanup in main.js; cosmetic only.'
      }
    }
  ],
  '1.3.11': [
    {
      icon: 'check',
      title: {
        de: 'Cloudflare-Verifizierungsschleife behoben',
        en: 'Cloudflare verification loop fixed'
      },
      text: {
        de: 'Manche Nutzer blieben auf der Seite "Performing security verification" / "Verifying you are human" hängen. Drei Ursachen wurden gefixt: (1) Der Cloudflare-Turnstile-iframe (`challenges.cloudflare.com`) war in der internen Allowlist nicht eingetragen und wurde von `will-frame-navigate` blockiert – die Challenge konnte nie fertig werden. (2) Die UA-Header (inkl. Sec-Ch-Ua) wurden nur für `claude.ai` gesetzt, nicht für Sandbox-Origins, `*.anthropic.com` oder den Challenge-Endpunkt – was Cloudflare als Bot-Signal wertet. (3) `Sec-Ch-Ua-Full-Version-List` und `Sec-Ch-Ua-Platform-Version` fehlten (bekannter Electron-Bug #34762) und werden nun konsistent mit identischer Brand-Reihenfolge mitgesendet.',
        en: 'Some users got stuck on the "Performing security verification" / "Verifying you are human" page. Three root causes were fixed: (1) The Cloudflare Turnstile iframe (`challenges.cloudflare.com`) was missing from the internal allowlist and was blocked by `will-frame-navigate`, so the challenge could never finish. (2) UA headers (incl. Sec-Ch-Ua) were only set for `claude.ai`, not for sandbox origins, `*.anthropic.com` or the challenge endpoint, which Cloudflare treats as a bot signal. (3) `Sec-Ch-Ua-Full-Version-List` and `Sec-Ch-Ua-Platform-Version` were missing (known Electron bug #34762) and are now sent consistently with identical brand ordering.'
      }
    },
    {
      icon: 'bug',
      title: {
        de: 'Bug-Report: Hinweis zum Browser-Gegencheck',
        en: 'Bug Report: browser cross-check note'
      },
      text: {
        de: 'Der Bug-Report-Dialog zeigt jetzt unter dem Community-App-Hinweis einen kurzen Gegencheck: "Tritt der gleiche Fehler auch auf claude.ai in einem normalen Browser auf? Dann ist es ein serverseitiges Problem bei Anthropic und kein Wrapper-Bug." Reduziert Berichte zu Problemen wie der jüngsten "Could not load connectors directory"-Meldung, die auch im offiziellen Claude-Desktop und in regulären Browsern auftritt.',
        en: 'The Bug Report dialog now shows a quick cross-check below the community-app note: "Does the same error also happen on claude.ai in a regular browser? Then it is a server-side issue at Anthropic, not a wrapper bug." Cuts down on reports like the recent "Could not load connectors directory" message, which also shows up in the official Claude Desktop and in plain browsers.'
      }
    }
  ],
  '1.3.10': [
    {
      icon: 'check',
      title: {
        de: 'MCP-Connectoren (Visualize & Co.) funktionieren wieder',
        en: 'MCP connectors (Visualize & co.) work again'
      },
      text: {
        de: 'Wer in claude.ai einen MCP-Connector wie Visualize oder \u00e4hnliche aktiviert hat, sah zuvor die Fehlermeldung \u201eFailed to set up MCP app \u2013 check that claudemcpcontent.com is not blocked by your network or browser". Ursache war keine Netzsperre, sondern die App selbst: die Domain `claudemcpcontent.com` (separater Sandbox-Origin f\u00fcr MCP-Inhalte, analog zu `claudeusercontent.com` f\u00fcr Artifacts) war in der internen Allowlist nicht eingetragen. Behoben \u2013 MCP-iframes laden wieder, prophylaktisch auch `claudemcp.com` mit drin.',
        en: 'Anyone who enabled an MCP connector like Visualize in claude.ai previously saw the error "Failed to set up MCP app \u2013 check that claudemcpcontent.com is not blocked by your network or browser". The cause was not a network block but the app itself: the domain `claudemcpcontent.com` (a separate sandbox origin for MCP content, like `claudeusercontent.com` for Artifacts) was missing from the internal allowlist. Fixed \u2013 MCP iframes load again, with `claudemcp.com` added preemptively.'
      }
    },
    {
      icon: 'bug',
      title: {
        de: 'Neue Diagnose-Funktion im App-Men\u00fc',
        en: 'New diagnostics action in the app menu'
      },
      text: {
        de: 'Im Hamburger-Men\u00fc gibt es jetzt den Punkt \u201eDiagnose-Info kopieren". Er sammelt App-Version, Electron/Chrome-Build, Kernel, Display-Session, GPU-Vendor und WebGL-Renderer in einem Block und kopiert ihn in die Zwischenablage \u2013 hilfreich, wenn z.B. eine Cloudflare-Verifizierungs-Seite h\u00e4ngen bleibt und der Fehler genauer reproduziert werden soll.',
        en: 'The hamburger menu now has a "Copy diagnostics info" entry. It gathers app version, Electron/Chrome build, kernel, display session, GPU vendor and WebGL renderer into one block and copies it to the clipboard \u2013 useful when, for example, a Cloudflare verification page hangs and the error needs to be reproduced in detail.'
      }
    },
    {
      icon: 'check',
      title: {
        de: 'Selbsthilfe bei h\u00e4ngender claude.ai-Verifizierung',
        en: 'Self-help for stuck claude.ai verification'
      },
      text: {
        de: 'Ebenfalls neu im Men\u00fc: \u201eclaude.ai-Verifizierung zur\u00fccksetzen". L\u00f6scht Cookies und Cache f\u00fcr alle claude.ai-Origins und l\u00e4dt die Seite neu. Sinnvoll, falls die Cloudflare-Sicherheits\u00fcberpr\u00fcfung (\u201ePerforming security verification") in einer Schleife stecken bleibt. Erfordert anschlie\u00dfend einen erneuten Login.',
        en: 'Also new in the menu: "Reset claude.ai verification". Clears cookies and cache for all claude.ai origins and reloads the page. Useful when the Cloudflare security check ("Performing security verification") gets stuck in a loop. Requires you to sign in again afterwards.'
      }
    }
  ]
};

function getFilteredNotes(currentVersion, lastSeenVersion, force = false) {
  const all = Object.keys(RELEASE_NOTES);
  let versionsToShow;
  if (force || !lastSeenVersion) {
    versionsToShow = all.includes(currentVersion) ? [currentVersion] : [];
  } else {
    versionsToShow = all
      .filter(v => compareVersions(v, lastSeenVersion) > 0 && compareVersions(v, currentVersion) <= 0)
      .sort(compareVersions);
  }
  // Revisit: wenn die aktuelle Version in unserer Map steht und auch tatsächlich
  // angezeigt wird, ziehen wir die referenzierten älteren Versionen mit rein.
  const revisit = RELEASE_NOTES_REVISIT[currentVersion];
  if (Array.isArray(revisit) && versionsToShow.includes(currentVersion)) {
    for (const r of revisit) {
      if (!versionsToShow.includes(r) && RELEASE_NOTES[r]) versionsToShow.push(r);
    }
    versionsToShow.sort(compareVersions);
  }
  const notes = [];
  for (const v of versionsToShow) {
    for (const n of (RELEASE_NOTES[v] || [])) {
      if (n.if === 'snap' && !isSnap) continue;
      if (n.if === 'appimage' && isSnap) continue;
      notes.push(n);
    }
  }
  return notes;
}

function loadWindowState() {
  try {
    if (fs.existsSync(stateFile)) windowState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  for (const f of STATE_SCHEMA) {
    if (f.optional && windowState[f.key] === undefined) continue;
    f.set(windowState[f.key]);
  }

  // Einmalige Intro-Aktivierung: OLED als Default beim ersten Start mit dem
  // OLED-Release. Bei bestehenden Nutzern bleibt customDesign (Modern/Classic)
  // wie vorher, nur oledMode wird an. Sobald oledIntroSeen=true persistiert ist,
  // wird oledMode beim Folge-Start aus dem State gelesen.
  if (!oledIntroSeen) {
    oledMode = true;
    oledIntroSeen = true;
    // Sofort persistieren, damit ein Hard-Crash vor dem ersten Save den User
    // nicht beim Folge-Start nochmal zwangsweise in OLED schickt.
    try { saveWindowStateSync(); } catch {}
  }

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
  const base = {};
  for (const f of STATE_SCHEMA) base[f.key] = f.get();
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

// Domain-Validierung

const domainCache = new Map();

function isAllowedDomain(url) {
  let h;
  try { h = new URL(url).hostname; } catch { return false; }
  let r = domainCache.get(h);
  if (r !== undefined) return r;
  r = h === 'claude.ai' || h.endsWith('.claude.ai')
    || h === 'claudeusercontent.com' || h.endsWith('.claudeusercontent.com')
    || h === 'claudemcpcontent.com' || h.endsWith('.claudemcpcontent.com')
    || h === 'claudemcp.com' || h.endsWith('.claudemcp.com')
    || h === 'challenges.cloudflare.com';
  if (domainCache.size >= DOMAIN_CACHE_MAX) domainCache.delete(domainCache.keys().next().value);
  domainCache.set(h, r);
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
      || h.endsWith('.auth0.com') || h.endsWith('.claude.ai')
      || h === 'higgsfield.ai' || h.endsWith('.higgsfield.ai');
  } catch { return false; }
}

// Custom-MCP-Connector: der OAuth-Server-Host ist beliebig und steht in keiner
// Allowlist. Erkennt ein window.open mit OAuth2-Authorize-Signatur, damit das
// Popup in-app aufgeht statt im Systembrowser (sonst landet der Callback nie in
// der claude.ai-Session). Eng gefasst, damit normale externe Links extern bleiben.
function looksLikeOAuthUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const q = u.search.toLowerCase();
    if (q.includes('response_type=') || q.includes('client_id=') || q.includes('redirect_uri=')) return true;
    return /\/(oauth2?|authorize|authorization|sso)(\/|$)/.test(u.pathname.toLowerCase());
  } catch { return false; }
}

// Theme & Design

const THEME = {
  dark:  { bg: '#262624', bgHover: '#333330', bgActive: '#3a3a37', text: '#9a9a96', textActive: '#e8e8e4', border: '#333330', frameHi: '#423d38', frameLo: '#2a2622' },
  light: { bg: '#f5f2ef', bgHover: '#ede9e4', bgActive: '#faf8f6', text: '#8a7e72', textActive: '#2a2420', border: '#e8e4de', frameHi: '#ddd6cc', frameLo: '#c8c1b6' },
  oled:  { bg: '#050306', bgHover: '#121013', bgActive: '#1c181b', text: '#9a948f', textActive: '#e8e8e4', border: '#1a1719', frameHi: '#2c2429', frameLo: '#0c090b' }
};

const ACCENT = {
  custom:   { from: '#F26A3F', to: '#E83B6E' },
  original: { from: '#d4734c', to: '#d4734c' }
};

// Beta-Build erkennen — eigene Icons (BETA-Badge) zur visuellen Unterscheidung von Stable
const isBeta = process.env.CLAUDE_BETA === '1'
            || (process.env.APPIMAGE || '').toLowerCase().includes('beta');

function currentThemeMode() {
  if (!isDarkMode) return 'light';
  return oledMode ? 'oled' : 'dark';
}
function theme()  { return THEME[currentThemeMode()]; }
// Sub-Window-Theme: identisch mit theme(). Im OLED-Mode kommt die zusaetzliche
// Lesbarkeit nicht ueber einen helleren bg, sondern ueber einen Brand-Glow-Overlay
// (s. customTitlebarCSS), damit das Schwarz erhalten bleibt.
function subTheme() {
  return theme();
}
function accent() { return customDesign ? ACCENT.custom : ACCENT.original; }
function icon()   {
  if (isBeta) return path.join(__dirname, customDesign ? 'icon-beta.png' : 'icon-original-beta.png');
  return path.join(__dirname, customDesign ? 'icon.png' : 'icon-original.png');
}
function trayIcon() {
  if (isBeta) return path.join(__dirname, customDesign ? 'icon-tray-beta.png' : 'icon-original-tray-beta.png');
  return path.join(__dirname, customDesign ? 'icon-tray.png' : 'icon-original-tray.png');
}

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

// Das neue Spark-Logo hat bereits einen dunklen, abgerundeten Tile (OLED-tauglich),
// daher kein zusaetzlicher Tile/Glow-Wrapper mehr noetig - Logo wird as-is genutzt.
function iconDataUrlForCurrentTheme() {
  return iconDataUrl();
}

// Tab-Bar HTML

let _tabBarCache = '';
let _tabBarKey = '';

function getTabBarHTML() {
  const key = `${currentThemeMode()}:${customDesign}`;
  if (key === _tabBarKey && _tabBarCache) return _tabBarCache;
  _tabBarKey = key;
  const th = theme();
  const a = accent();

  _tabBarCache = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
:root{--bg:${th.bg};--bgh:${th.bgHover};--bga:${th.bgActive};--t:${th.text};--ta:${th.textActive};--bd:${th.border};
  --frame-hi:${th.frameHi};--frame-lo:${th.frameLo};--ac-from:${a.from};--ac-to:${a.to}}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{background:var(--bg);font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  color:var(--t);overflow:hidden;user-select:none;
  display:flex;flex-direction:column;contain:layout style;
  border:${WINDOW_BORDER}px solid var(--frame-lo);
  border-image:linear-gradient(180deg,var(--frame-hi),var(--frame-lo)) 1}
#notif-bar{display:flex;flex-direction:column;flex-shrink:0;-webkit-app-region:no-drag}
#notif-bar:empty{display:none}
.notif{display:flex;align-items:center;gap:14px;min-height:${NOTIFICATION_BANNER_HEIGHT}px;padding:10px 14px 10px 0;font-family:inherit;line-height:1.35;color:var(--ta);border-bottom:1px solid var(--bd);background:var(--bgh);position:relative}
.notif[data-sev="info"]{background:linear-gradient(90deg,color-mix(in srgb,var(--ac-from) 14%,var(--bgh)),var(--bgh))}
.notif[data-sev="warn"]{background:linear-gradient(90deg,color-mix(in srgb,#e0a93e 22%,var(--bgh)),var(--bgh))}
.notif[data-sev="critical"]{background:linear-gradient(90deg,color-mix(in srgb,#e05e3e 28%,var(--bgh)),var(--bgh))}
.notif[data-sev="success"]{background:linear-gradient(90deg,color-mix(in srgb,#3fb96e 22%,var(--bgh)),var(--bgh))}
.notif-dot{flex:0 0 4px;align-self:stretch;background:var(--ac-from);margin-right:6px}
.notif[data-sev="warn"] .notif-dot{background:#e0a93e}
.notif[data-sev="critical"] .notif-dot{background:#e05e3e}
.notif[data-sev="success"] .notif-dot{background:#3fb96e}
.notif-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;overflow:hidden}
.notif-text strong{font-weight:600;color:var(--ta);font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.notif-text span{color:var(--t);font-weight:400;font-size:12.5px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.notif-link{flex:0 0 auto;background:var(--ac-from);color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:12.5px;font-family:inherit;font-weight:600;cursor:pointer;white-space:nowrap;transition:filter .12s ease}
.notif[data-sev="warn"] .notif-link{background:#e0a93e;color:#1c1208}
.notif[data-sev="critical"] .notif-link{background:#e05e3e;color:#fff}
.notif[data-sev="success"] .notif-link{background:#3fb96e;color:#0e1d14}
.notif-link:hover{filter:brightness(1.08)}
.notif-x{flex:0 0 auto;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--t);font-size:18px;line-height:1;border:none;background:transparent;font-family:inherit;transition:background .12s ease}
.notif-x:hover{background:var(--bga);color:var(--ta)}
#tab-row{display:flex;align-items:flex-end;height:${TAB_BAR_HEIGHT}px;flex:0 0 ${TAB_BAR_HEIGHT}px;-webkit-app-region:drag}
.menu-btn{-webkit-app-region:no-drag;width:30px;height:30px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;color:var(--ta);border-radius:8px;margin:0 2px 6px 6px;flex-shrink:0;
  transition:background .15s,color .15s,border-color .15s;border:1px solid transparent;opacity:.85}
.menu-btn:hover{background:color-mix(in srgb,var(--ac-from) 12%,transparent);
  border-color:color-mix(in srgb,var(--ac-from) 35%,transparent);color:var(--ac-from);opacity:1}
.menu-btn svg{width:16px;height:16px}
#tabs{display:flex;align-items:flex-end;height:100%;flex:1;padding:0 4px;gap:2px;
  overflow-x:auto;min-width:0}
#tabs::-webkit-scrollbar{height:0}
.tab{display:flex;align-items:center;height:34px;padding:0 14px;border-radius:11px 11px 0 0;
  cursor:pointer;white-space:nowrap;max-width:220px;min-width:60px;gap:8px;
  position:relative;color:var(--t);transition:background .15s,color .15s;contain:layout style;
  -webkit-app-region:no-drag}
.tab:hover{background:linear-gradient(180deg,transparent,var(--bgh));color:var(--ta)}
.tab.active{background:var(--bga);color:var(--ta);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ac-from) 28%,transparent)}
.tab.active::after{content:'';position:absolute;bottom:0;left:10px;right:10px;height:2.5px;
  background:linear-gradient(90deg,var(--ac-from),var(--ac-to));border-radius:2px 2px 0 0;
  box-shadow:0 0 8px color-mix(in srgb,var(--ac-from) 45%,transparent)}
.tab-title{flex:1;overflow:hidden;text-overflow:ellipsis}
.tab-close{width:18px;height:18px;border-radius:8px;display:flex;align-items:center;justify-content:center;
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
.win-controls{display:flex;align-items:stretch;margin-left:6px;padding-right:2px;-webkit-app-region:no-drag;height:${TAB_BAR_HEIGHT}px}
.win-btn{width:38px;height:100%;border:none;background:transparent;color:var(--ta);
  cursor:pointer;display:flex;align-items:center;justify-content:center;
  transition:background .12s,color .12s;opacity:.78;font-family:inherit;padding:0}
.win-btn:hover{background:var(--bgh);opacity:1}
.win-btn svg{width:11px;height:11px;display:block}
#win-close:hover{background:linear-gradient(135deg,var(--ac-from),var(--ac-to));color:#fff}
</style></head><body>
<div id="notif-bar"></div>
<div id="tab-row">
<div class="menu-btn" id="app-menu" title="${t('Menü', 'Menu', 'Menu', 'Menu')}">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
</div>
<div id="tabs"></div>
<div class="controls">
  <div class="design-pill" id="design-toggle" title="${t('Design wechseln', 'Toggle design', 'Changer de design', 'Cambia design')}">${customDesign ? 'Modern' : 'Classic'}</div>
  <div class="ctrl-btn" id="export-btn" title="${t('Konversation als Markdown exportieren', 'Export conversation as Markdown', 'Exporter la conversation en Markdown', 'Esporta la conversazione in Markdown')}">
    <svg viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </div>
  <div class="ctrl-btn" id="bug-report" title="${(bugReportStrings[sysLang] || bugReportStrings.en).title}">
    <svg viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </div>
  <div class="ctrl-btn" id="reset-verify" title="${t('claude.ai-Verifizierung zurücksetzen (bei hängender Sicherheitsprüfung)', 'Reset claude.ai verification (when the security check is stuck)', 'Réinitialiser la vérification claude.ai (si la vérification est bloquée)', 'Reimposta la verifica claude.ai (se il controllo è bloccato)')}">
    <svg viewBox="0 0 24 24" fill="none"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </div>
  <div class="ctrl-btn" id="theme-toggle" title="${t('Theme wechseln', 'Toggle theme', 'Changer de thème', 'Cambia tema')}">
    <svg id="theme-icon-dark" viewBox="0 0 24 24"${currentThemeMode() === 'dark' ? '' : ' style="display:none"'}><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    <svg id="theme-icon-light" viewBox="0 0 24 24"${currentThemeMode() === 'light' ? '' : ' style="display:none"'}><circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
    <svg id="theme-icon-oled" viewBox="0 0 24 24"${currentThemeMode() === 'oled' ? '' : ' style="display:none"'}><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" fill="currentColor"/></svg>
  </div>
  <div class="ctrl-btn" id="new-tab" title="${t('Neuer Tab', 'New Tab', 'Nouvel onglet', 'Nuova scheda')} (Ctrl+T)">
    <svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>
  </div>
</div>
<div class="win-controls">
  <button class="win-btn" id="win-min" title="${t('Minimieren', 'Minimize', 'Réduire', 'Riduci a icona')}" aria-label="Minimize">
    <svg viewBox="0 0 12 12"><rect x="2" y="5.5" width="8" height="1" fill="currentColor"/></svg>
  </button>
  <button class="win-btn" id="win-max" title="${t('Maximieren', 'Maximize', 'Agrandir', 'Ingrandisci')}" aria-label="Maximize">
    <svg id="win-max-icon" viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>
    <svg id="win-restore-icon" viewBox="0 0 12 12" style="display:none"><rect x="2.5" y="4" width="5.5" height="5.5" fill="none" stroke="currentColor" stroke-width="1"/><path d="M4.5 4V2.5H10V8H8" fill="none" stroke="currentColor" stroke-width="1"/></svg>
  </button>
  <button class="win-btn" id="win-close" title="${t('Schließen', 'Close', 'Fermer', 'Chiudi')}" aria-label="Close">
    <svg viewBox="0 0 12 12"><path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
  </button>
</div>
</div>
<script>
const tabsEl=document.getElementById('tabs');
let tabEls=[];
document.getElementById('new-tab').addEventListener('click',()=>window.tabAPI.newTab());
document.getElementById('theme-toggle').addEventListener('click',()=>window.tabAPI.toggleTheme());
document.getElementById('design-toggle').addEventListener('click',()=>window.tabAPI.toggleDesign());
document.getElementById('bug-report').addEventListener('click',()=>window.tabAPI.bugReport());
document.getElementById('reset-verify').addEventListener('click',()=>window.tabAPI.resetVerification());
document.getElementById('export-btn').addEventListener('click',()=>window.tabAPI.exportConversation());
document.getElementById('app-menu').addEventListener('click',(e)=>{
  const r=e.currentTarget.getBoundingClientRect();
  window.tabAPI.openAppMenu(Math.round(r.left),Math.round(r.bottom));
});
document.getElementById('win-min').addEventListener('click',()=>window.tabAPI.winMinimize());
document.getElementById('win-max').addEventListener('click',()=>window.tabAPI.winToggleMaximize());
document.getElementById('win-close').addEventListener('click',()=>window.tabAPI.winClose());
window.tabAPI.onWindowStateUpdate(s=>{
  const m=!!(s&&s.maximized);
  document.getElementById('win-max-icon').style.display=m?'none':'';
  document.getElementById('win-restore-icon').style.display=m?'':'none';
});
window.tabAPI.requestWindowState();

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

// v[6]=frameHi, v[7]=frameLo muessen mit dem THEME-Objekt oben synchron bleiben.
const THEME_VARS={
  light:['#f5f2ef','#ede9e4','#faf8f6','#8a7e72','#2a2420','#e8e4de','#ddd6cc','#c8c1b6'],
  dark: ['#262624','#333330','#3a3a37','#9a9a96','#e8e8e4','#333330','#423d38','#2a2622'],
  oled: ['#050306','#121013','#1c181b','#9a948f','#e8e8e4','#1a1719','#2c2429','#0c090b']
};
window.tabAPI.onThemeUpdate(mode=>{
  const m=(mode==='light'||mode==='oled')?mode:'dark';
  // Weicher Wechsel: bei echtem Moduswechsel (nicht beim ersten Aufruf) kurz eine
  // Farb-Transition einblenden, damit die Leiste mit dem Inhalt zusammen fadet statt
  // hart umzuspringen. Danach leeren, damit Hover etc. nicht dauerhaft mitanimieren.
  if(window.__tbMode!==undefined && window.__tbMode!==m){
    let ts=document.getElementById('tb-trans');
    if(!ts){ts=document.createElement('style');ts.id='tb-trans';document.head.appendChild(ts);}
    ts.textContent='*{transition:background-color .28s ease,color .28s ease,border-color .28s ease !important}';
    clearTimeout(window.__tbTransT);
    window.__tbTransT=setTimeout(()=>{const s=document.getElementById('tb-trans');if(s)s.textContent='';},360);
  }
  window.__tbMode=m;
  const v=THEME_VARS[m];
  const r=document.documentElement.style;
  r.setProperty('--bg',v[0]);r.setProperty('--bgh',v[1]);r.setProperty('--bga',v[2]);
  r.setProperty('--t',v[3]);r.setProperty('--ta',v[4]);r.setProperty('--bd',v[5]);
  r.setProperty('--frame-hi',v[6]);r.setProperty('--frame-lo',v[7]);
  document.body.style.background='';
  document.getElementById('theme-icon-dark').style.display=m==='dark'?'':'none';
  document.getElementById('theme-icon-light').style.display=m==='light'?'':'none';
  document.getElementById('theme-icon-oled').style.display=m==='oled'?'':'none';
});

const notifBar=document.getElementById('notif-bar');
function escTxt(s){return String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
window.tabAPI.onNotificationsUpdate(list=>{
  notifBar.innerHTML='';
  if(!Array.isArray(list)||list.length===0)return;
  for(const n of list){
    const row=document.createElement('div');
    row.className='notif';row.dataset.sev=n.severity||'info';
    row.innerHTML=
      '<span class="notif-dot"></span>'+
      '<div class="notif-text"><strong>'+escTxt(n.title)+'</strong>'+
        (n.body?'<span>'+escTxt(n.body)+'</span>':'')+'</div>'+
      (n.link?'<button class="notif-link" data-act="link">'+escTxt(n.linkLabel||'${t('Mehr', 'More', 'Plus', 'Altro')}')+'</button>':'')+
      (n.dismissible!==false?'<button class="notif-x" data-act="dismiss" title="${t('Schließen', 'Close', 'Fermer', 'Chiudi')}">×</button>':'');
    row.addEventListener('click',e=>{
      const a=e.target&&e.target.dataset?e.target.dataset.act:null;
      if(a==='link'&&n.link)window.tabAPI.openNotificationLink(n.id,n.link);
      else if(a==='dismiss')window.tabAPI.dismissNotification(n.id);
    });
    notifBar.appendChild(row);
  }
});
window.tabAPI.requestNotifications();
</script></body></html>`;
  return _tabBarCache;
}

// Tab-Bar Sync (IPC → Renderer)

const sendTabsUpdate = throttle(() => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tabs-update', {
    tabs: tabs.map((tab, i) => ({ title: tab.title || `Tab ${i + 1}` })),
    activeIndex: activeTabIndex
  });
}, 100);

function sendThemeUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('theme-update', currentThemeMode());
}

function sendDesignUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('design-update', customDesign);
}

// Script-Injection

// Verify-Banner-Script mit lokalisierten Strings befüllen
function verifyScript() {
  const i18n = {
    msg: t(
      'Die Sicherheitsprüfung hängt in einer Schleife. „Zurücksetzen“ leert die claude.ai-Sitzung vollständig und behebt das in den meisten Fällen, du meldest dich danach neu an. Hilft das nicht, liegt es an deiner Netzwerk-Adresse: ein aktives VPN ist oft die Ursache (für claude.ai ausschalten), sonst hilft ein anderes Netzwerk.',
      'The security check is stuck in a loop. "Reset" fully clears the claude.ai session and fixes this in most cases; you sign in again afterwards. If that does not help, it is your network address: an active VPN is often the cause (turn it off for claude.ai), otherwise try a different network.',
      'La vérification de sécurité tourne en boucle. « Réinitialiser » efface entièrement la session claude.ai et résout le problème dans la plupart des cas ; vous vous reconnectez ensuite. Si cela ne suffit pas, cela vient de votre adresse réseau : un VPN actif en est souvent la cause (désactivez-le pour claude.ai), sinon essayez un autre réseau.',
      'Il controllo di sicurezza è bloccato in un ciclo. "Reimposta" cancella completamente la sessione di claude.ai e nella maggior parte dei casi risolve; dopodiché accedi di nuovo. Se non basta, dipende dal tuo indirizzo di rete: una VPN attiva è spesso la causa (disattivala per claude.ai), altrimenti prova una rete diversa.'
    ),
    reset: t('Zurücksetzen', 'Reset', 'Réinitialiser', 'Reimposta'),
    dismiss: t('Schließen', 'Dismiss', 'Ignorer', 'Ignora')
  };
  return VERIFY_SCRIPT.replace('__VERIFY_I18N__', JSON.stringify(i18n));
}

// Theme-State fuer den Controller (inject/theme.js): mode + design + accent.
// mid (#E8524F) ist der Brand-Mittelton fuer das Orange->Brand-Recoloring (Modern).
function themeState() {
  const ac = customDesign ? ACCENT.custom : ACCENT.original;
  return { mode: currentThemeMode(), design: customDesign ? 'modern' : 'classic', accent: { from: ac.from, to: ac.to, mid: '#E8524F' } };
}
function themeScript() {
  return 'window._cdTheme=' + JSON.stringify(themeState()) + ';' + THEME_SCRIPT;
}

// Anti-FOUC: preload-content.js holt Theme-State + das volle statische Sheet synchron bei
// document-start, um das komplette OLED-Theme VOR dem ersten claude.ai-Paint zu setzen. Sonst
// rendert claude.ai ~1.7s mit eigenem Styling, bis der per executeJavaScript bei dom-ready
// eingereihte Controller hinter Reacts Hydration im Main-Thread endlich drankommt und alles
// sichtbar umspringt. staticCSS kommt aus derselben Quelle wie der Controller (theme-static.js).
ipcMain.on('cd-theme-mode', (e) => {
  const st = themeState();
  let staticCSS = '';
  try { if (st.mode === 'oled') staticCSS = cdBuildStaticCSS(st); } catch {}
  e.returnValue = Object.assign({}, st, { staticCSS });
});

function injectScripts(wc) {
  if (!alive(wc)) return;
  // Nur in claude.ai-Seiten injizieren, nie in OAuth-Provider-/Login-Seiten
  // (Google, Linear, ...), die waehrend eines Connector-Flows im View laufen.
  // Sonst werden fremde Login-Seiten umgefaerbt (unlesbar) und unsere
  // MutationObserver stoeren deren OAuth-JS ("Invalid flow state").
  if (!isAllowedDomain(wc.getURL())) return;
  wc.executeJavaScript(NOTIFY_SCRIPT).catch(() => {});
  wc.executeJavaScript(verifyScript()).catch(() => {});
  wc.executeJavaScript(themeScript()).catch(() => {});
}

function reinjectScripts(wc) {
  if (!alive(wc)) return;
  if (!isAllowedDomain(wc.getURL())) return;
  // Notify-Script: idempotent
  wc.executeJavaScript('!!window._cdNotify').then(active => {
    if (!active) wc.executeJavaScript(NOTIFY_SCRIPT).catch(() => {});
  }).catch(() => {});
  // Theme-Controller bleibt bei SPA-Nav bestehen; falls weg neu injizieren, sonst State re-asserten
  wc.executeJavaScript('!!window._cdThemeCtl').then(active => {
    if (!active) wc.executeJavaScript(themeScript()).catch(() => {});
    else wc.executeJavaScript('window._cdSetTheme&&window._cdSetTheme(' + JSON.stringify(themeState()) + ')').catch(() => {});
  }).catch(() => {});
}

// Theme live auf alle offenen Views anwenden (kein Reload, kein Re-Inject):
// nur Attribute am <html> umschalten via window._cdSetTheme.
function applyThemeToAllViews() {
  const s = JSON.stringify(themeState());
  for (const tab of tabs) {
    if (!tab || !alive(tab.view)) continue;
    const wc = tab.view.webContents;
    if (!isAllowedDomain(wc.getURL())) continue;
    wc.executeJavaScript('window._cdSetTheme&&window._cdSetTheme(' + s + ')').catch(() => {});
  }
}

// View Setup (Security + Events)

// Window-Open-Handler: OAuth/claude.ai in-app, Rest extern. Als Factory, damit das
// OAuth-Popup denselben Handler bekommt; Provider mit verschachteltem window.open
// (z.B. Microsoft) oeffnen sonst ein ungesteuertes Default-Fenster ohne Session.
function oauthWindowOpenHandler(getOpenerUrl) {
  return ({ url }) => {
    if (isOAuthDomain(url) || (isAllowedDomain(getOpenerUrl()) && looksLikeOAuthUrl(url))) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 600, height: 750, title: t('Anmeldung', 'Sign In', 'Connexion', 'Accesso'),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:claude' }
      }};
    }
    if (isAllowedDomain(url)) return { action: 'allow' };
    try {
      const p = new URL(url).protocol;
      if (p === 'https:' || p === 'http:' || p === 'mailto:') openExternalSafe(url);
    } catch {}
    return { action: 'deny' };
  };
}

function setupView(view) {
  const wc = view.webContents;

  // Window-Open: OAuth in-app, claude.ai erlaubt, Rest extern
  wc.setWindowOpenHandler(oauthWindowOpenHandler(() => wc.getURL()));

  // OAuth-Popup Lifecycle (nur wenn das neue Fenster wirklich OAuth ist)
  wc.on('did-create-window', (childWindow, details) => {
    const initialUrl = details && details.url ? details.url : '';
    // Artefakt-/Preview-Fenster von claude.ai: kein OAuth-Lifecycle, aber sie erben
    // setBackgroundColor nicht (das gilt nur fuer createContentView) und blitzen im
    // OLED-Mode weiss auf. Nur die Hintergrundfarbe setzen, sonst nichts anfassen.
    if (isAllowedDomain(initialUrl) && !isOAuthDomain(initialUrl)) {
      try { childWindow.setBackgroundColor(theme().bg); } catch {}
      return;
    }
    if (!isOAuthDomain(initialUrl) && !looksLikeOAuthUrl(initialUrl)) return;

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

    // Verschachteltes window.open aus dem Popup (Provider-SSO) ebenfalls steuern.
    childWindow.webContents.setWindowOpenHandler(oauthWindowOpenHandler(() => {
      try { return childWindow.isDestroyed() ? '' : childWindow.webContents.getURL(); } catch { return ''; }
    }));
  });

  // Navigation Guards
  wc.on('will-navigate', (event, navUrl) => {
    // claude.ai/bekannte-OAuth/OAuth-Authorize immer zulassen. looksLikeOAuthUrl deckt
    // den Connector-Approve ab, der im selben Fenster zum Provider (Host nicht in der
    // Allowlist) navigiert; ohne das blockt der Guard still -> "Approve tut nichts".
    if (isAllowedDomain(navUrl) || isOAuthDomain(navUrl) || looksLikeOAuthUrl(navUrl)) return;
    // Mid-OAuth: sind wir bereits auf einer externen Provider-Seite (per OAuth dorthin
    // gelangt), dessen eigene Folge-Schritte (Login etc.) per https zulassen, bis es
    // zurueck auf claude.ai redirected. Startup (leer/about:blank) faellt nicht darunter.
    let onProvider = false;
    try { onProvider = new URL(wc.getURL()).protocol === 'https:' && !isAllowedDomain(wc.getURL()); } catch {}
    let proto = '';
    try { proto = new URL(navUrl).protocol; } catch {}
    // Mid-OAuth nur auf der gleichen Registrable-Domain wie die Provider-Seite
    // zulassen; fremde https-Hosts (Marketing-/Hilfe-Links der Provider-Seite)
    // gehen extern, damit die View kein offener Browser wird.
    let sameSite = false;
    try {
      const a = new URL(navUrl).hostname.split('.').slice(-2).join('.');
      const b = new URL(wc.getURL()).hostname.split('.').slice(-2).join('.');
      sameSite = !!a && a === b;
    } catch {}
    if (onProvider && proto === 'https:' && sameSite) return;
    event.preventDefault();
    if (proto === 'https:' || proto === 'http:' || proto === 'mailto:') openExternalSafe(navUrl);
  });

  wc.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return; // Hauptframe entscheidet will-navigate
    const navUrl = event.url;
    // Subframes enger: ein blosses looksLikeOAuthUrl reicht fuer ein eingebettetes
    // iframe nicht, nur zulassen wenn die Top-Level-Seite selbst claude.ai ist.
    if (isAllowedDomain(navUrl) || isOAuthDomain(navUrl) || (isAllowedDomain(wc.getURL()) && looksLikeOAuthUrl(navUrl))) return;
    event.preventDefault();
  });

  // Tab-Titel
  wc.on('page-title-updated', (e, title) => {
    e.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`Claude v${version}`);
    const idx = tabs.findIndex(tab => tab.view === view);
    if (idx >= 0) {
      const clean = title.replace(/\s*[-\u2013]\s*Claude.*$/, '') || t('Neuer Chat', 'New Chat', 'Nouvelle conversation', 'Nuova chat');
      if (tabs[idx].title !== clean) { tabs[idx].title = clean; sendTabsUpdate(); }
    }
  });

  // Theme-Controller schon bei dom-ready injizieren (vor dem ersten Content-Paint),
  // damit beim neuen Tab/Reload kein heller/grauer claude.ai-Frame aufblitzt.
  wc.on('dom-ready', () => {
    if (alive(wc) && isAllowedDomain(wc.getURL())) wc.executeJavaScript(themeScript()).catch(() => {});
  });
  // Restliche Skripte + Theme-Reassert bei vollem Load
  wc.on('did-finish-load', () => {
    updateTitle();
    injectScripts(wc);
  });

  // SPA-Navigation (Chat-Wechsel): Scripts re-injizieren
  wc.on('did-navigate-in-page', () => reinjectScripts(wc));

  // Aktuelle URL am Tab mitfuehren, damit Offline-Restore und Session-Wiederherstellung
  // den echten Chat kennen. data: ausschliessen, sonst frisst die Offline-Seite die URL.
  const syncTabUrl = (url) => {
    const tab = tabs.find(tb => tb.view === view);
    if (tab && url && !url.startsWith('data:')) tab.url = url;
  };
  wc.on('did-navigate', (_e, url) => syncTabUrl(url));
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) syncTabUrl(url); });

  // Crash-Recovery
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

// View-Erstellung + Pool

function createContentView() {
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      partition: 'persist:claude',
      backgroundThrottling: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload-content.js')
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
    setTimeout(fillPool, 1200);
    return view;
  }
  return null;
}


// Tab-Operationen

// defer: Tab anlegen ohne zu laden und ohne zu aktivieren. Geladen wird beim ersten
// Anklicken (pendingUrl in switchToTab). Fuer den Session-Restore, damit N Tabs nicht
// gleichzeitig claude.ai anfragen.
function createTab(url = 'https://claude.ai', defer = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  let view = (!defer && url === 'https://claude.ai') ? getPooledView() : null;
  if (!view) {
    view = createContentView();
    setupView(view);
    if (!defer) view.webContents.loadURL(url);
  }

  mainWindow.contentView.addChildView(view);
  tabs.push({ view, title: t('Neuer Chat', 'New Chat', 'Nouvelle conversation', 'Nuova chat'), url, crashCount: 0, pendingUrl: defer ? url : null });
  if (!defer) switchToTab(tabs.length - 1);
  else sendTabsUpdate();
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

// Beim Fenster-Fokus (z.B. Alt+Tab) landet der Tastaturfokus sonst im Tabbar
// (Top-Level-WebContents) auf dem ersten Button (win-min) statt im Chat-Inhalt,
// wodurch der erste Tastendruck das Fenster minimiert. Fokus auf die aktive View
// umlenken. Deferred, weil Electron den nativen Fokus nach dem Event restauriert.
function focusActiveView() {
  setImmediate(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused()) return;
    const active = tabs[activeTabIndex];
    if (!active || !alive(active.view)) return;
    try { active.view.webContents.focus(); } catch {}
  });
}

const resizeActiveView = throttle(() => {
  if (!mainWindow || mainWindow.isDestroyed() || !tabs[activeTabIndex]) return;
  const b = mainWindow.getContentBounds();
  const nh = getNotificationBarHeight();
  const bw = WINDOW_BORDER;
  const topInset = TAB_BAR_HEIGHT + nh + bw;
  const key = `${b.width}:${b.height}:${nh}`;
  if (key === lastViewBounds) return;
  lastViewBounds = key;
  tabs[activeTabIndex].view.setBounds({ x: bw, y: topInset, width: Math.max(0, b.width - 2 * bw), height: Math.max(0, b.height - topInset - bw) });
}, 16);

// Nach einem Resize-Burst (Tiling/Half-Screen) ein letztes autoritatives Relayout.
// Auf X11 bleibt die WebContentsView nach dem Tiling sonst mit veralteten Bounds
// haengen: Inhalt verschoben oder Fensterrest schwarz/grau. Cache leeren + finales
// Relayout. Wenn das Fenster dieselben Bounds behaelt und nur die Compositor-Surface
// haengt, ist setBounds mit identischen Werten ein No-op und die Flaeche bleibt
// schwarz - darum zusaetzlich ein echter 1px-Delta (kurz verkleinern, zuruecksetzen),
// der eine Neukomposition erzwingt.
const settleActiveView = debounce(() => {
  if (!mainWindow || mainWindow.isDestroyed() || !tabs[activeTabIndex] || !alive(tabs[activeTabIndex].view)) return;
  lastViewBounds = '';
  resizeActiveView();
  const view = tabs[activeTabIndex].view;
  try {
    const b = view.getBounds();
    view.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.max(0, b.height - 1) });
    setImmediate(() => { if (alive(view)) view.setBounds(b); });
  } catch {}
}, 200);

// Manueller Repaint fuer den Fall, dass die Compositor-Surface leer bleibt. Bewusst
// dieselbe setVisible-Sequenz wie switchToTab, denn das Weg-und-zurueck-Wechseln ist
// der einzige nachweislich funktionierende Weg, die Surface neu anzuhaengen. Ueber
// switchToTab selbst geht es nicht: dort greift der Early-Return auf den aktiven Tab.
function repaintActiveView() {
  const a = tabs[activeTabIndex];
  if (!a || !alive(a.view)) return;
  try {
    a.view.webContents.setBackgroundThrottling(false);
    if (typeof a.view.webContents.setFrameRate === 'function') a.view.webContents.setFrameRate(60);
    a.view.setVisible(false);
    setImmediate(() => {
      if (!alive(a.view)) return;
      a.view.setVisible(true);
      lastViewBounds = '';
      resizeActiveView();
      focusActiveView();
    });
  } catch {}
}

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
  // Gegenstueck zu throttleActiveView: ohne das bleibt eine View, die per minimize/hide
  // auf 10 fps gedrosselt wurde, dort haengen, bis ein show/restore/focus-Event kommt.
  try {
    if (typeof target.view.webContents.setFrameRate === 'function') target.view.webContents.setFrameRate(60);
  } catch {}
  if (target.pendingUrl) { const u = target.pendingUrl; target.pendingUrl = null; target.view.webContents.loadURL(u); }
  else if (target.needsReload) { target.needsReload = false; target.view.webContents.reload(); }

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

// Design-Toggle

function toggleDesign() {
  customDesign = !customDesign;

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(icon());
  if (tray) {
    try {
      const img = nativeImage.createFromPath(trayIcon());
      tray.setImage(img.isEmpty() ? trayIcon() : img);
    } catch {}
  }
  // Snap liefert sein Icon ueber die gebundelte .desktop, Schreiben in ~/ ist no-op und macht journalctl-Laerm
  if (!process.env.SNAP) {
    try { fs.copyFileSync(icon(), path.join(app.getPath('home'), 'Apps', 'claude-desktop-icon.png')); } catch {}
  }

  // Pinned-Icon im Dock/Taskleiste mit-switchen (Linux: GNOME/Plasma lesen aus icon-theme)
  // Beta-Build überschreibt nur claude-desktop-beta.png, nicht das Stable-Icon
  if (process.platform === 'linux' && !process.env.SNAP) {
    const iconFile = isBeta ? 'claude-desktop-beta.png' : 'claude-desktop.png';
    const sizes = ['512x512', '256x256', '128x128', '64x64', '48x48', '32x32', '16x16'];
    for (const sz of sizes) {
      const target = path.join(app.getPath('home'), '.local', 'share', 'icons', 'hicolor', sz, 'apps', iconFile);
      try {
        if (fs.existsSync(target)) fs.copyFileSync(icon(), target);
      } catch {}
    }
    const { exec } = require('child_process');
    exec('gtk-update-icon-cache -t -f ' + JSON.stringify(path.join(app.getPath('home'), '.local', 'share', 'icons', 'hicolor')), () => {});
  }

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

// Bug-Report-Dialog

const BUG_EMAIL = 'claudeai.desktop.linux@gmail.com';
const WEB3FORMS_ACCESS_KEY = 'f72095f3-b338-4fa5-8462-5ddee347eb32';
const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit';

function getAppMode() {
  if (process.env.APPIMAGE) return 'AppImage';
  if (process.env.SNAP) return 'Snap';
  if (!app.isPackaged) return 'Development';
  return 'Packaged';
}

async function copyDiagnosticsInfo() {
  const lines = [];
  lines.push(`App: Claude Desktop v${app.getVersion()}`);
  lines.push(`Mode: ${getAppMode()}`);
  lines.push(`Electron: ${process.versions.electron}  Chrome: ${process.versions.chrome}  Node: ${process.versions.node}`);
  lines.push(`OS: ${process.platform} ${process.arch}  Kernel: ${require('os').release()}`);
  lines.push(`Session: XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE || '?'}  WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY || ''}  DISPLAY=${process.env.DISPLAY || ''}`);
  lines.push(`Locale: ${app.getLocale()}  sysLang: ${sysLang}`);
  lines.push(`UA: ${chromeUA}`);

  try {
    const features = app.getGPUFeatureStatus ? app.getGPUFeatureStatus() : null;
    if (features && typeof features === 'object') {
      const fmt = Object.keys(features).sort().map(k => `${k}=${features[k]}`).join(', ');
      lines.push(`GPU-Features: ${fmt}`);
    }
  } catch (e) {
    lines.push(`GPU-Features: error (${e && e.message || e})`);
  }

  try {
    const gpuInfo = await app.getGPUInfo('complete');
    if (gpuInfo && Array.isArray(gpuInfo.gpuDevice)) {
      gpuInfo.gpuDevice.forEach((d, i) => {
        lines.push(`GPU[${i}]: vendor=0x${(d.vendorId || 0).toString(16)} device=0x${(d.deviceId || 0).toString(16)} active=${d.active} driverVendor=${d.driverVendor || ''} driverVersion=${d.driverVersion || ''}`);
      });
    }
    const aux = gpuInfo && gpuInfo.auxAttributes;
    if (aux) {
      const glVendor = aux.glVendor || aux.gl_vendor || '';
      const glRenderer = aux.glRenderer || aux.gl_renderer || '';
      const glVersion = aux.glVersion || aux.gl_version || '';
      lines.push(`GL-Vendor: ${glVendor}`);
      lines.push(`GL-Renderer: ${glRenderer}`);
      lines.push(`GL-Version: ${glVersion}`);
    }
  } catch (e) {
    lines.push(`GPU-Info: error (${e && e.message || e})`);
  }

  const active = tabs[activeTabIndex];
  if (active && alive(active.view)) {
    try {
      const wgl = await active.view.webContents.executeJavaScript(`(()=>{try{const c=document.createElement('canvas');const gl=c.getContext('webgl2')||c.getContext('webgl');if(!gl)return{ok:false};const e=gl.getExtension('WEBGL_debug_renderer_info');return{ok:true,vendor:e?gl.getParameter(e.UNMASKED_VENDOR_WEBGL):'',renderer:e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):'',version:gl.getParameter(gl.VERSION),ua:navigator.userAgent};}catch(err){return{ok:false,err:String(err)};}})()`, true);
      if (wgl && wgl.ok) {
        lines.push(`WebGL-Vendor: ${wgl.vendor}`);
        lines.push(`WebGL-Renderer: ${wgl.renderer}`);
        lines.push(`WebGL-Version: ${wgl.version}`);
        lines.push(`navigator.userAgent: ${wgl.ua}`);
      } else {
        lines.push(`WebGL: not available (${wgl && wgl.err || ''})`);
      }
    } catch (e) {
      lines.push(`WebGL-Probe: error (${e && e.message || e})`);
    }
  }

  const text = lines.join('\n');
  try { clipboard.writeText(text); } catch {}
  showCustomMessageBox({
    type: 'info',
    title: 'Claude',
    message: t('Diagnose-Info in Zwischenablage kopiert', 'Diagnostics info copied to clipboard', 'Infos de diagnostic copiées dans le presse-papiers', 'Informazioni di diagnostica copiate negli appunti'),
    detail: text
  });
}

async function resetClaudeVerification(targetTab) {
  const confirm = await showCustomMessageBox({
    type: 'warning',
    title: 'Claude',
    message: t(
      'claude.ai-Cache und -Cookies zurücksetzen?',
      'Reset claude.ai cache and cookies?',
      'Réinitialiser le cache et les cookies de claude.ai ?',
      'Reimpostare cache e cookie di claude.ai?'
    ),
    detail: t(
      'Du wirst danach erneut bei claude.ai angemeldet sein müssen. Hilft, wenn die Verifizierungs-Seite („Performing security verification") in einer Schleife hängt.',
      'You will need to sign in to claude.ai again afterwards. This helps when the verification page ("Performing security verification") gets stuck in a loop.',
      'Vous devrez ensuite vous reconnecter à claude.ai. Utile lorsque la page de vérification (« Performing security verification ») tourne en boucle.',
      'Dopodiché sarà necessario accedere di nuovo a claude.ai. Utile quando la pagina di verifica ("Performing security verification") rimane bloccata in un ciclo.'
    ),
    buttons: [t('Abbrechen', 'Cancel', 'Annuler', 'Annulla'), t('Zurücksetzen', 'Reset', 'Réinitialiser', 'Reimposta')],
    defaultId: 1,
    cancelId: 0
  });
  if (!confirm || confirm.response !== 1) return;

  try {
    const ses = session.fromPartition('persist:claude');
    // Cloudflare bindet seinen Verdacht an Session-State (cf_clearance/__cf_bm, auch auf
    // challenges.cloudflare.com, plus Cache und Auth-Cache). Origin-gefiltertes Loeschen
    // liess davon genug stehen, dass die Partition CF-seitig "verbrannt" blieb und die
    // Verifizierung weiter in der Schleife hing. Empirisch verifiziert: nur ein vollstaendiges
    // Leeren der Partition (alle Origins, alle Caches) macht sie wieder durchlaessig.
    try { await ses.clearStorageData(); } catch {}
    try { await ses.clearCache(); } catch {}
    try { await ses.clearAuthCache(); } catch {}
    try { await ses.clearCodeCaches({}); } catch {}
    try { await ses.clearHostResolverCache(); } catch {}
    domainCache.clear();
  } catch (e) {
    console.error('resetClaudeVerification:', e);
  }

  const active = (targetTab && alive(targetTab.view)) ? targetTab : tabs[activeTabIndex];
  if (active && alive(active.view)) {
    active.view.webContents.loadURL('https://claude.ai');
  }
}

function showBugReportDialog() {
  if (bugReportWindow && !bugReportWindow.isDestroyed()) {
    bugReportWindow.focus();
    return;
  }
  const s = { ...bugReportStrings.en, ...(bugReportStrings[sysLang] || {}) };
  const th = subTheme();
  const ac = accent();
  const dark = isDarkMode;
  const bg = th.bg;
  const fg = th.textActive;
  const sub = th.text;
  const inputBg = th.bgHover;
  const inputBorder = th.border;
  const inputFocus = ac.from;
  const btnBg = ac.from;
  const btnHover = ac.to;
  const btnDisabled = th.bgActive;
  const successColor = '#3da66a';

  const meta = {
    version: app.getVersion(),
    os: `${process.platform} ${process.arch} (${require('os').release()})`,
    locale: app.getLocale() || sysLang || 'unknown',
    mode: getAppMode()
  };

  const brSize = { width: 540, height: 1000 };
  const brPos = centerOnMainWindow(brSize.width, brSize.height);
  const win = new BrowserWindow({
    ...brSize, ...brPos, resizable: false,
    parent: mainWindow, modal: true,
    title: s.title, icon: icon(),
    backgroundColor: bg,
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-bugreport.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true
    }
  });
  bugReportWindow = win;
  win.setMenuBarVisibility(false);
  win.on('closed', () => { bugReportWindow = null; });

  const cfg = JSON.stringify({
    bugEmail: BUG_EMAIL,
    web3formsKey: WEB3FORMS_ACCESS_KEY,
    web3formsEndpoint: WEB3FORMS_ENDPOINT,
    meta,
    strings: s
  });

  const html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https://api.web3forms.com;">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:${bg};color:${fg};font-family:system-ui,-apple-system,sans-serif;font-size:14px;
  display:flex;flex-direction:column;height:100vh;padding:0;overflow:hidden}
h2{font-size:18px;font-weight:600;margin-bottom:8px}
.intro{color:${sub};font-size:13px;line-height:1.5;margin-bottom:18px}
.field{margin-bottom:14px;display:flex;flex-direction:column}
label{font-size:12px;font-weight:500;color:${sub};margin-bottom:6px;letter-spacing:.02em}
textarea,input[type=email]{background:${inputBg};color:${fg};border:1px solid ${inputBorder};
  border-radius:8px;padding:10px 12px;font-size:13.5px;font-family:inherit;outline:none;
  transition:border-color .15s,box-shadow .15s;resize:none}
textarea:focus,input[type=email]:focus{border-color:${inputFocus};box-shadow:0 0 0 3px ${inputFocus}22}
textarea.desc{min-height:110px;line-height:1.5}
textarea.errcodes{min-height:70px;line-height:1.45;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}
.auto-info-row{display:flex;align-items:flex-start;gap:10px;margin:6px 0 14px;
  padding:10px 12px;background:${inputBg};border:1px solid ${inputBorder};border-radius:8px;cursor:pointer;
  user-select:none;transition:border-color .15s}
.auto-info-row:hover{border-color:${inputFocus}}
.auto-info-row input[type=checkbox]{margin-top:2px;accent-color:${inputFocus};cursor:pointer;flex-shrink:0}
.auto-info-row .text{display:flex;flex-direction:column;gap:2px}
.auto-info-row .label{font-size:13px;color:${fg};font-weight:500}
.auto-info-row .hint{font-size:11.5px;color:${sub};line-height:1.4}
.confirm-row{display:flex;align-items:flex-start;gap:10px;margin:2px 0 16px;
  padding:11px 13px;border-radius:8px;cursor:pointer;user-select:none;
  background:${dark ? 'rgba(224,169,62,0.10)' : 'rgba(224,150,40,0.12)'};
  border:1.5px solid ${dark ? 'rgba(224,169,62,0.45)' : 'rgba(224,150,40,0.5)'};
  transition:border-color .15s,background .15s}
.confirm-row:hover{border-color:${inputFocus}}
.confirm-row.checked{background:${inputBg};border-color:${inputBorder}}
.confirm-row input[type=checkbox]{margin-top:2px;accent-color:${inputFocus};cursor:pointer;flex-shrink:0}
.confirm-row .text{display:flex;flex-direction:column;gap:2px}
.confirm-row .label{font-size:13px;color:${fg};font-weight:600}
.confirm-row .hint{font-size:11.5px;color:${sub};line-height:1.4}
.nudge{display:none;gap:9px;align-items:flex-start;padding:10px 12px;margin:-4px 0 14px;
  background:${dark ? 'rgba(224,169,62,0.12)' : 'rgba(224,150,40,0.14)'};
  border:1px solid ${dark ? 'rgba(224,169,62,0.5)' : 'rgba(224,150,40,0.55)'};
  border-radius:8px;font-size:12.5px;line-height:1.45}
.nudge.show{display:flex}
.nudge .ico{flex:0 0 auto;color:${dark ? '#e0a93e' : '#c97e1c'};line-height:0;margin-top:1px}
.nudge .txt{flex:1;color:${fg}}
.nudge a{color:${inputFocus};text-decoration:underline;cursor:pointer;font-weight:500}
.nudge a:hover{filter:brightness(1.15)}
.actions{display:flex;gap:10px;justify-content:flex-end;margin-top:auto;padding-top:8px}
button{border:none;padding:10px 20px;border-radius:9px;font-size:13.5px;cursor:pointer;
  font-weight:500;font-family:inherit;transition:filter .15s,background .15s,opacity .15s}
button.primary{background:linear-gradient(135deg,${ac.from},${ac.to});color:#fff}
button.primary:hover:not(:disabled){filter:brightness(1.08)}
button.primary:disabled{background:${btnDisabled};cursor:not-allowed;filter:none}
button.secondary{background:transparent;color:${sub};border:1px solid ${inputBorder}}
button.secondary:hover{background:${inputBg};color:${fg}}
button:focus-visible{outline:2px solid ${ac.from};outline-offset:2px}
.honeypot{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.disclaimer{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;margin:-2px 0 16px;
  background:${dark ? 'rgba(224,169,62,0.10)' : 'rgba(224,150,40,0.12)'};
  border:1px solid ${dark ? 'rgba(224,169,62,0.35)' : 'rgba(224,150,40,0.45)'};
  border-radius:8px;font-size:12.5px;line-height:1.5}
.disclaimer .ico{flex:0 0 auto;color:${dark ? '#e0a93e' : '#c97e1c'};line-height:0;margin-top:1px}
.disclaimer .txt{flex:1;color:${fg}}
.disclaimer .ttl{font-weight:600;display:block;margin-bottom:3px;color:${dark ? '#e0a93e' : '#a86412'}}
.disclaimer a{color:${inputFocus};text-decoration:underline;cursor:pointer;font-weight:500}
.disclaimer a:hover{filter:brightness(1.15)}
.status{display:none;flex-direction:column;align-items:center;justify-content:center;
  height:100%;text-align:center;padding:20px}
.status.visible{display:flex}
.status .icon{margin-bottom:14px;line-height:0;color:${sub}}
.status .icon svg{width:48px;height:48px}
.status h3{font-size:17px;font-weight:600;margin-bottom:8px}
.status p{color:${sub};font-size:13px;line-height:1.5;margin-bottom:18px;max-width:380px}
.status.success .icon{color:${successColor}}
.status .email{font-size:14px;font-weight:600;color:${fg};margin-bottom:14px;word-break:break-all;
  background:${inputBg};padding:8px 14px;border-radius:6px;border:1px solid ${inputBorder}}
.error-row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
${customTitlebarCSS()}
.bugreport-main{flex:1;padding:18px 24px 24px;overflow-y:auto;display:flex;flex-direction:column;min-height:0}
.bugreport-main::-webkit-scrollbar{width:10px}
.bugreport-main::-webkit-scrollbar-track{background:transparent}
.bugreport-main::-webkit-scrollbar-thumb{background:${inputBorder};border-radius:6px;border:3px solid ${bg};background-clip:padding-box}
.bugreport-main::-webkit-scrollbar-thumb:hover{background:${sub};border:3px solid ${bg};background-clip:padding-box}
.status-host{flex:1;display:flex;align-items:center;justify-content:center}
</style></head><body>
${customTitlebarHTML(s.title)}
<div class="bugreport-main">
<div id="form-view">
  <h2>${s.title}</h2>
  <p class="intro">${s.intro}</p>

  <div class="disclaimer" role="note">
    <span class="ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>
    <span class="txt"><span class="ttl">${s.disclaimerTitle}</span>${s.disclaimerBody} <a id="anthropic-link" href="#" tabindex="0">${s.disclaimerLink}</a>${s.serverSideHint ? `<br><br>${s.serverSideHint}` : ''}</span>
  </div>

  <form id="bugform" novalidate>
    <div class="field">
      <label for="desc">${s.descLabel}</label>
      <textarea id="desc" class="desc" required placeholder="${s.descPlaceholder}"></textarea>
    </div>

    <div class="nudge" id="support-nudge" role="note">
      <span class="ico"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span>
      <span class="txt">${s.nudgeText} <a id="nudge-link" href="#" tabindex="0">${s.disclaimerLink}</a></span>
    </div>

    <div class="field">
      <label for="errcodes">${s.errorLabel}</label>
      <textarea id="errcodes" class="errcodes" placeholder="${s.errorPlaceholder}"></textarea>
    </div>
    <div class="field">
      <label for="email">${s.emailLabel}</label>
      <input type="email" id="email" placeholder="${s.emailPlaceholder}" autocomplete="email">
    </div>

    <label class="auto-info-row" for="autoinfo">
      <input type="checkbox" id="autoinfo" checked>
      <span class="text">
        <span class="label">${s.autoInfoLabel}</span>
        <span class="hint">${s.autoInfoHint}</span>
      </span>
    </label>

    <input type="text" name="botcheck" id="botcheck" class="honeypot" tabindex="-1" autocomplete="off">

    <label class="confirm-row" for="confirmapp" id="confirm-row">
      <input type="checkbox" id="confirmapp">
      <span class="text">
        <span class="label">${s.confirmLabel}</span>
        <span class="hint">${s.confirmHint}</span>
      </span>
    </label>

    <div class="actions">
      <button type="button" class="secondary" id="cancel-btn">${s.cancelBtn}</button>
      <button type="submit" class="primary" id="send-btn" disabled>${s.sendBtn}</button>
    </div>
  </form>
</div>

<div class="status success" id="success-view">
  <div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg></div>
  <h3>${s.successTitle}</h3>
  <p>${s.successMsg}</p>
  <button class="primary" onclick="window.close()">${s.closeBtn}</button>
</div>

<div class="status" id="error-view">
  <div class="icon" style="color:${btnBg}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
  <h3>${s.errorTitle}</h3>
  <p>${s.errorHint}</p>
  <div class="email" id="err-email"></div>
  <div class="error-row">
    <button class="secondary" onclick="window.close()">${s.closeBtn}</button>
    <button class="primary" id="copy-btn"></button>
  </div>
</div>
</div>

<script>
(function(){
  const cfg = ${cfg};
  const formView = document.getElementById('form-view');
  const successView = document.getElementById('success-view');
  const errorView = document.getElementById('error-view');
  const form = document.getElementById('bugform');
  const sendBtn = document.getElementById('send-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const desc = document.getElementById('desc');
  const errcodes = document.getElementById('errcodes');
  const emailInput = document.getElementById('email');
  const autoInfoCheckbox = document.getElementById('autoinfo');
  const confirmCheckbox = document.getElementById('confirmapp');
  const confirmRow = document.getElementById('confirm-row');
  const botcheck = document.getElementById('botcheck');
  const errEmail = document.getElementById('err-email');
  const copyBtn = document.getElementById('copy-btn');

  errEmail.textContent = cfg.bugEmail;
  copyBtn.textContent = cfg.strings.copyBtn;
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(cfg.bugEmail).then(() => {
      copyBtn.textContent = cfg.strings.copied;
      setTimeout(() => { copyBtn.textContent = cfg.strings.copyBtn; }, 1500);
    });
  });

  cancelBtn.addEventListener('click', () => window.close());

  const syncConfirm = () => {
    sendBtn.disabled = !confirmCheckbox.checked;
    confirmRow.classList.toggle('checked', confirmCheckbox.checked);
  };
  confirmCheckbox.addEventListener('change', syncConfirm);
  syncConfirm();

  const tbClose = document.getElementById('cd-titlebar-close');
  if (tbClose) tbClose.addEventListener('click', () => window.close());

  function wireSupportLink(el) {
    if (!el) return;
    const open = (e) => {
      if (e) { e.preventDefault(); }
      try { window.bugAPI.openSupport(); } catch {}
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') open(e);
    });
  }
  wireSupportLink(document.getElementById('anthropic-link'));
  wireSupportLink(document.getElementById('nudge-link'));

  // Wenn die Beschreibung nach Account/Login/Bezahlung klingt, dezent auf den
  // Anthropic-Support hinweisen. Nur ein Nudge, das harte Gate bleibt die Checkbox.
  const supportNudge = document.getElementById('support-nudge');
  const NUDGE_KW = ['log in','login','logg','einlogg','anmeld','sign in','signin',
    'password','passwort','kennwort','mot de passe','contrase',
    'account','konto','cuenta','compte',
    'subscription','abonn','abbonamento','suscrip','abo-','abo kündig','abo kundig',
    'billing','rechnung','facturac','factura','fatturaz','invoice',
    'payment','paiement','bezahl','zahlung','pagamento',
    'refund','erstattung','remboursement','reembolso','rimborso','chargeback',
    'cancel','kündig','kundig','annuler','cancelar','cancellare','disdire',
    'credit card','kreditkarte','carte bancaire','tarjeta','carta di credito',
    'upgrade','downgrade'];
  const checkNudge = () => {
    const t = (desc.value + ' ' + errcodes.value).toLowerCase();
    supportNudge.classList.toggle('show', NUDGE_KW.some((k) => t.includes(k)));
  };
  desc.addEventListener('input', checkNudge);
  errcodes.addEventListener('input', checkNudge);

  function showView(which) {
    formView.style.display = which === 'form' ? '' : 'none';
    successView.classList.toggle('visible', which === 'success');
    errorView.classList.toggle('visible', which === 'error');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const description = desc.value.trim();
    if (!description) { desc.focus(); return; }
    if (!confirmCheckbox.checked) { confirmCheckbox.focus(); return; }
    if (botcheck.value) return;

    const userEmail = emailInput.value.trim();
    const errText = errcodes.value.trim();
    const includeAutoInfo = !!autoInfoCheckbox.checked;
    sendBtn.disabled = true;
    sendBtn.textContent = cfg.strings.sendingBtn;

    const meta = cfg.meta;
    let bodyMessage = description;
    if (errText) {
      bodyMessage += '\\n\\n--- Error Codes / Messages ---\\n' + errText;
    }
    if (includeAutoInfo) {
      bodyMessage +=
        '\\n\\n--- App-Info ---' +
        '\\nVersion: ' + meta.version +
        '\\nOS: ' + meta.os +
        '\\nLocale: ' + meta.locale +
        '\\nMode: ' + meta.mode;
    }
    bodyMessage += (userEmail ? '\\n\\nUser-Email: ' + userEmail : '\\n\\nUser-Email: (not provided)');

    const payload = {
      access_key: cfg.web3formsKey,
      subject: 'Claude Desktop Bug Report v' + meta.version,
      from_name: 'Claude Desktop App',
      message: bodyMessage,
      botcheck: ''
    };
    if (userEmail) payload.email = userEmail;

    try {
      const res = await fetch(cfg.web3formsEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        showView('success');
      } else {
        throw new Error(data.message || ('HTTP ' + res.status));
      }
    } catch (err) {
      console.error('Bug-report submit failed:', err);
      showView('error');
    } finally {
      sendBtn.textContent = cfg.strings.sendBtn;
      sendBtn.disabled = !confirmCheckbox.checked;
    }
  });

  setTimeout(() => desc.focus(), 50);
})();
</script>
</body></html>`;

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

// Tray, Hintergrund-Modus, globaler Hotkey

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
    placeholder: t('Frage an Claude\u2026', 'Ask Claude\u2026', 'Poser une question \u00e0 Claude\u2026', 'Chiedi a Claude\u2026'),
    hint: t('Enter zum Senden \u00b7 Shift+Enter neue Zeile \u00b7 Esc abbrechen \u00b7 Tab Template', 'Enter to send \u00b7 Shift+Enter new line \u00b7 Esc to cancel \u00b7 Tab template', 'Entr\u00e9e pour envoyer \u00b7 Maj+Entr\u00e9e nouvelle ligne \u00b7 \u00c9chap annuler \u00b7 Tab mod\u00e8le', 'Invio per inviare \u00b7 Maiusc+Invio nuova riga \u00b7 Esc annulla \u00b7 Tab modello'),
    noTemplate: t('Kein Template', 'No template', 'Aucun modèle', 'Nessun modello'),
    templates: t('Template', 'Template', 'Modèle', 'Modello')
  };
  const logoUrl = iconDataUrlForCurrentTheme();
  // XSS-safe: </script> in Template-Namen würde sonst aus dem Script-Kontext brechen
  const tpls = JSON.stringify(promptTemplates.map(t => ({ id: t.id, name: t.name, prefix: t.prefix })))
    .replace(/<\//g, '<\\/');
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
.inner{height:100%;background:${th.bg};border-radius:10px;padding:12px 16px 10px;display:flex;flex-direction:column;gap:8px}
.wrap{flex:1;display:flex;align-items:flex-start;gap:12px;min-height:0}
.logo{width:28px;height:28px;flex-shrink:0;border-radius:7px;margin-top:4px;object-fit:contain;
  box-shadow:0 2px 8px color-mix(in srgb,${ac.from} 40%,transparent)}
textarea{flex:1;background:transparent;border:none;outline:none;resize:none;color:${th.textActive};font-family:inherit;font-size:15px;line-height:1.5;min-height:48px;padding:4px 0}
textarea::placeholder{color:${th.text}}
.bot{display:flex;align-items:center;justify-content:space-between;gap:10px}
.tpl-pick{display:flex;align-items:center;gap:6px;font-size:11.5px;color:${th.text}}
.tpl-pick select{background:${th.bgHover};color:${th.textActive};border:1px solid ${th.border};border-radius:5px;padding:3px 8px;font-family:inherit;font-size:11.5px;outline:none;cursor:pointer;max-width:200px}
.tpl-pick select:focus{border-color:${ac.from}}
.tpl-pick.empty{display:none}
.hint{color:${th.text};font-size:11px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<div class="frame"><div class="inner">
<div class="wrap">
  <img class="logo" src="${logoUrl}" alt="Claude"/>
  <textarea id="q" placeholder="${i18n.placeholder}" autofocus></textarea>
</div>
<div class="bot">
  <div class="tpl-pick" id="tplwrap">
    <span>${i18n.templates}:</span>
    <select id="tpl"></select>
  </div>
  <div class="hint">${i18n.hint}</div>
</div>
</div></div>
<script>
const api = window.quickPromptAPI;
const q = document.getElementById('q');
const sel = document.getElementById('tpl');
const tplwrap = document.getElementById('tplwrap');
const TEMPLATES = ${tpls};
const I = ${safeJson(i18n)};

function buildTplOptions() {
  if (!TEMPLATES.length) { tplwrap.classList.add('empty'); return; }
  const opt = document.createElement('option'); opt.value = ''; opt.textContent = I.noTemplate;
  sel.appendChild(opt);
  for (const t of TEMPLATES) {
    const o = document.createElement('option'); o.value = t.id; o.textContent = t.name;
    sel.appendChild(o);
  }
}
buildTplOptions();

q.focus();
q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); api.cancel(); return; }
  if (e.key === 'Tab' && TEMPLATES.length) { e.preventDefault(); sel.focus(); return; }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const v = q.value.trim();
    if (v.length === 0) { api.cancel(); return; }
    const tpl = TEMPLATES.find(t => t.id === sel.value);
    const finalText = tpl ? (tpl.prefix.trimEnd() + ' ' + v) : v;
    api.submit(finalText);
  }
});
sel.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); api.cancel(); }
  if (e.key === 'Enter') { e.preventDefault(); q.focus(); }
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
  const qpBase = {
    ...qpSize,
    frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    transparent: true, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-quickprompt.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      spellcheck: false
    }
  };
  quickPromptWindow = new BrowserWindow({
    ...qpBase, ...centerOnMainDisplay(qpSize.width, qpSize.height)
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

// Quick-Prompt: Text in Eingabefeld einfügen und Cursor positionieren.
// Bewusst KEIN Auto-Submit: kein Button-Klick, kein synthetisches KeyboardEvent.
// User drückt selbst Enter zum Absenden – konsistent mit dem "passiver Wrapper"-Prinzip.
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
        if (attempts > 40) return; // ~6s max
        const el = document.querySelector('div[contenteditable="true"].ProseMirror')
                || document.querySelector('div[contenteditable="true"]')
                || document.querySelector('.ProseMirror');
        if (!el) { setTimeout(tryFill, 150); return; }
        try {
          el.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, prompt);
          // Cursor ans Ende setzen, damit Enter direkt sendet
          const end = document.createRange();
          end.selectNodeContents(el);
          end.collapse(false);
          sel.removeAllRanges();
          sel.addRange(end);
        } catch(e) {}
      };
      tryFill();
    })();`).catch(() => {});
  };
  wc.once('did-finish-load', inject);
}

function customTitlebarCSS() {
  const th = subTheme();
  // Sub-Fenster nutzen pro Theme nur ihre flache Theme-Farbe (kein Brand-Glow mehr).
  // Soft-Depth-Fensterrahmen (oben heller, unten dunkler) gleich wie Hauptfenster, gemeinsam fuer
  // alle Dialoge die diese Titlebar einbinden (Bug-Report/Settings/What's-New/About).
  return `
body{border:${WINDOW_BORDER}px solid ${th.frameLo};border-image:linear-gradient(180deg,${th.frameHi},${th.frameLo}) ${WINDOW_BORDER}}
.cd-titlebar{height:36px;-webkit-app-region:drag;display:flex;align-items:center;
  padding:0 0 0 14px;background:transparent;color:${th.textActive};
  font-size:12.5px;flex-shrink:0;user-select:none}
.cd-titlebar-title{flex:1;font-weight:500;letter-spacing:.2px;color:${th.textActive};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:8px}
.cd-titlebar-controls{display:flex;-webkit-app-region:no-drag;height:100%}
.cd-titlebar-btn{width:38px;height:36px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;color:${th.textActive};border:0;background:transparent;
  transition:background .12s,color .12s;opacity:.78;padding:0;font-family:inherit}
.cd-titlebar-btn:hover{background:${th.bgHover};opacity:1}
.cd-titlebar-btn.cd-close:hover{background:#e05e3e;color:#fff}
.cd-titlebar-btn svg{width:11px;height:11px;display:block}`;
}

function customTitlebarHTML(titleText) {
  return `<div class="cd-titlebar">
    <span class="cd-titlebar-title">${titleText}</span>
    <div class="cd-titlebar-controls">
      <button class="cd-titlebar-btn cd-close" id="cd-titlebar-close" aria-label="Close">
        <svg viewBox="0 0 12 12"><path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>`;
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

function centerOnMainWindow(width, height) {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) {
      return centerOnMainDisplay(width, height);
    }
    const b = mainWindow.getBounds();
    return {
      x: Math.round(b.x + (b.width - width) / 2),
      y: Math.round(b.y + (b.height - height) / 2)
    };
  } catch {
    return centerOnMainDisplay(width, height);
  }
}

// Gemeinsamer BrowserWindow-Setup fuer Modal-Dialoge (showCustomMessageBox,
// requestMicrophoneConsent). Zentriert auf das Main-Window, parent+modal wenn
// mainWindow sichtbar ist, preload-messagebox.js + sandbox an.
function createDialogWindow(opts) {
  const width = opts.width;
  const height = opts.height;
  const pos = centerOnMainWindow(width, height);
  const parentWin = (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) ? mainWindow : undefined;
  const win = new BrowserWindow({
    width, height, ...pos,
    parent: parentWin,
    modal: !!parentWin,
    resizable: false, minimizable: false, maximizable: false,
    title: opts.title || '',
    backgroundColor: subTheme().bg,
    icon: icon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, opts.preload || 'preload-messagebox.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      spellcheck: false
    }
  });
  win.setMenu(null);
  return win;
}

function setupTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(trayIcon());
    tray = new Tray(img.isEmpty() ? trayIcon() : img);
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
      { label: t('\u00d6ffnen', 'Open', 'Ouvrir', 'Apri'), click: showMainWindow },
      { label: t('Neuer Chat', 'New Chat', 'Nouvelle conversation', 'Nuova chat'), click: openNewChatFromHotkey },
      { type: 'separator' },
      { label: t('App-Einstellungen\u2026', 'App Settings\u2026', 'Paramètres de l’application…', 'Impostazioni dell’app…'), click: () => openSettingsWindow() },
      { type: 'separator' },
      { label: t('Beenden', 'Quit', 'Quitter', 'Esci'), click: () => { isQuitting = true; app.quit(); } }
    ]));
  } catch {}
}

function registerHotkey(accel) {
  if (typeof accel === 'string' && accel.length > 0 && accel === currentClipboardHotkey) return 'conflict';
  if (currentHotkey) {
    try { globalShortcut.unregister(currentHotkey); } catch {}
  }
  currentHotkey = null;
  if (!accel || typeof accel !== 'string') return 'ok';
  try {
    if (globalShortcut.register(accel, openQuickPrompt)) {
      currentHotkey = accel;
      return 'ok';
    }
  } catch {}
  return isWayland ? 'failed-wayland' : 'failed';
}

// Feature 6: Clipboard → Chat
function openClipboardChat() {
  let text = '';
  try { text = clipboard.readText() || ''; } catch {}
  text = text.trim();
  if (!text) {
    // Screenshot liegt als Bild in der Zwischenablage, nicht als Text. Ein Bild
    // laesst sich von hier nicht in den claude.ai-Composer injizieren, daher Hinweis
    // auf direktes Einfuegen statt der irrefuehrenden "leer"-Meldung.
    let hasImage = false;
    try { hasImage = !clipboard.readImage().isEmpty(); } catch {}
    notify({
      title: 'Claude',
      body: hasImage
        ? t('Bild in der Zwischenablage. Bitte direkt im Chat mit Strg+V einfügen.', 'Image in clipboard. Paste it directly in the chat with Ctrl+V.', 'Image dans le presse-papiers. Collez-la directement dans le chat avec Ctrl+V.', 'Immagine negli appunti. Incollala direttamente nella chat con Ctrl+V.')
        : t('Zwischenablage ist leer.', 'Clipboard is empty.', 'Le presse-papiers est vide.', 'Gli appunti sono vuoti.')
    });
    return;
  }
  if (text.length > 8000) text = text.slice(0, 8000);
  submitQuickPrompt(text);
}

function registerClipboardHotkey(accel) {
  if (typeof accel === 'string' && accel.length > 0 && accel === currentHotkey) return 'conflict';
  if (currentClipboardHotkey) {
    try { globalShortcut.unregister(currentClipboardHotkey); } catch {}
  }
  currentClipboardHotkey = null;
  if (!accel || typeof accel !== 'string') return 'ok';
  try {
    if (globalShortcut.register(accel, openClipboardChat)) {
      currentClipboardHotkey = accel;
      return 'ok';
    }
  } catch {}
  return isWayland ? 'failed-wayland' : 'failed';
}

// Feature 4: Markdown-Export
async function exportActiveConversation() {
  const tab = tabs[activeTabIndex];
  if (!tab || !alive(tab.view)) return;
  const wc = tab.view.webContents;
  const url = wc.getURL();
  if (!/^https:\/\/(?:[a-z0-9-]+\.)?claude\.ai\//i.test(url)) {
    showCustomMessageBox({
      type: 'info', title: 'Claude',
      message: t('Export nur in claude.ai-Tabs verfügbar.', 'Export only available in claude.ai tabs.', 'Export disponible uniquement dans les onglets claude.ai.', 'Esportazione disponibile solo nelle schede claude.ai.')
    });
    return;
  }

  let payload = null;
  try {
    payload = await wc.executeJavaScript(`(function(){
      function clean(s){ return (s||'').replace(/\\u00a0/g,' ').replace(/\\s+\\n/g,'\\n').trim(); }
      function nodeToMarkdown(root){
        if(!root) return '';
        const walk = (node) => {
          if(node.nodeType === 3) return node.textContent;
          if(node.nodeType !== 1) return '';
          const tag = node.tagName.toLowerCase();
          const inner = Array.from(node.childNodes).map(walk).join('');
          if(tag === 'br') return '\\n';
          if(tag === 'strong' || tag === 'b') return '**' + inner + '**';
          if(tag === 'em' || tag === 'i') return '*' + inner + '*';
          if(tag === 'code' && node.parentElement && node.parentElement.tagName.toLowerCase() !== 'pre') return '\`' + inner + '\`';
          if(tag === 'pre'){
            const code = node.querySelector('code');
            const lang = code && code.className ? (code.className.match(/language-([\\w-]+)/) || [])[1] || '' : '';
            return '\\n\\n\`\`\`' + lang + '\\n' + (code ? code.innerText : node.innerText) + '\\n\`\`\`\\n\\n';
          }
          if(tag === 'a'){
            const href = node.getAttribute('href') || '';
            return href ? '[' + inner + '](' + href + ')' : inner;
          }
          if(tag === 'li') return '- ' + inner.trim() + '\\n';
          if(tag === 'ul' || tag === 'ol') return '\\n' + inner + '\\n';
          if(tag === 'h1') return '\\n# ' + inner + '\\n\\n';
          if(tag === 'h2') return '\\n## ' + inner + '\\n\\n';
          if(tag === 'h3') return '\\n### ' + inner + '\\n\\n';
          if(tag === 'h4') return '\\n#### ' + inner + '\\n\\n';
          if(tag === 'blockquote') return inner.split('\\n').map(l=>'> '+l).join('\\n') + '\\n\\n';
          if(tag === 'p' || tag === 'div') return inner + '\\n\\n';
          return inner;
        };
        return clean(walk(root));
      }
      const title = (document.title || 'Claude Chat').replace(/\\s*[-\\u2013]\\s*Claude.*$/, '').trim() || 'Claude Chat';
      const sels = [
        '[data-testid="user-message"]',
        '[data-testid="assistant-message"]',
        '[data-test-render-count]',
        'div.font-claude-message',
        'div.font-user-message'
      ];
      const found = new Map();
      for(const sel of sels){
        document.querySelectorAll(sel).forEach(el => {
          const r = el.getBoundingClientRect();
          const key = Math.round(window.scrollY + r.top) + ':' + Math.round(r.left);
          if(!found.has(key)) found.set(key, el);
        });
      }
      const parts = Array.from(found.values()).sort((a,b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return (ar.top + window.scrollY) - (br.top + window.scrollY);
      });
      const blocks = [];
      for(const el of parts){
        const isUser = !!(el.matches('[data-testid="user-message"]') || el.closest('[data-testid="user-message"]') || el.classList.contains('font-user-message'));
        const role = isUser ? 'User' : 'Claude';
        const md = nodeToMarkdown(el);
        if(md) blocks.push({ role, md });
      }
      return { title, url: location.href, blocks };
    })()`);
  } catch (e) {
    console.error('Export-Scrape fehlgeschlagen:', e);
  }
  if (!payload || !payload.blocks || !payload.blocks.length) {
    showCustomMessageBox({
      type: 'info', title: 'Claude',
      message: t('Konnte keine Konversation finden.', 'Could not find a conversation on this page.', 'Impossible de trouver une conversation sur cette page.', 'Impossibile trovare una conversazione in questa pagina.'),
      detail: t('Stelle sicher, dass du in einem Chat bist (nicht auf der Übersicht).', 'Make sure you are inside a chat (not on the overview).', 'Assurez-vous d’être dans une conversation (pas sur la vue d’ensemble).', 'Assicurati di essere in una chat (non nella panoramica).')
    });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  let md = `# ${payload.title}\n\n`;
  md += `_${t('Quelle', 'Source', 'Source', 'Fonte')}: ${payload.url}_\n`;
  md += `_${t('Exportiert', 'Exported', 'Exporté', 'Esportato')}: ${today}_\n\n---\n\n`;
  for (const b of payload.blocks) {
    md += `## ${b.role === 'User' ? t('Du', 'You', 'Vous', 'Tu') : 'Claude'}\n\n${b.md}\n\n---\n\n`;
  }

  const safeName = payload.title.replace(/[^\w\s.-]+/g, '_').slice(0, 80) || 'claude-chat';
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), `${safeName}-${today}.md`),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: t('Alle Dateien', 'All Files', 'Tous les fichiers', 'Tutti i file'), extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return;
  fs.writeFile(result.filePath, md, 'utf8', (err) => {
    if (err) {
      showCustomMessageBox({
        type: 'error', title: t('Export fehlgeschlagen', 'Export failed', 'Échec de l’export', 'Esportazione non riuscita'),
        message: err.message || String(err)
      });
      return;
    }
    notify({
      title: t('Konversation exportiert', 'Conversation exported', 'Conversation exportée', 'Conversazione esportata'),
      body: path.basename(result.filePath)
    });
  });
}


function getSettingsHTML() {
  const th = subTheme();
  const ac = accent();
  const i18n = {
    title: t('Einstellungen', 'Settings', 'Param\u00e8tres', 'Impostazioni'),
    subtitle: t('Hintergrund, Hotkeys, Templates', 'Background, hotkeys, templates', 'Arri\u00e8re-plan, raccourcis, mod\u00e8les', 'Background, scorciatoie, modelli'),
    secBackground: t('Hintergrund', 'Background', 'Arri\u00e8re-plan', 'Background'),
    secMicrophone: t('Mikrofon', 'Microphone', 'Microphone', 'Microfono'),
    secHotkeys: t('Globale Hotkeys', 'Global hotkeys', 'Raccourcis globaux', 'Scorciatoie globali'),
    secTemplates: t('Prompt-Templates', 'Prompt templates', 'Mod\u00e8les de prompt', 'Modelli di prompt'),
    minimizeLabel: t('Beim Schlie\u00dfen in den Hintergrund minimieren', 'Minimize to tray on close', 'R\u00e9duire dans la zone de notification \u00e0 la fermeture', 'Riduci nell\'area di notifica alla chiusura'),
    minimizeHint: t('Claude bleibt im Hintergrund erreichbar \u2013 \u00fcber das Tray-Symbol oder die Hotkeys unten.', 'Claude stays reachable in the background \u2013 via the tray icon or the hotkeys below.', 'Claude reste accessible en arri\u00e8re-plan, via l\'ic\u00f4ne de la zone de notification ou les raccourcis ci-dessous.', 'Claude resta accessibile in background, tramite l\'icona nell\'area di notifica o le scorciatoie qui sotto.'),
    autostartLabel: t('Beim Anmelden automatisch starten', 'Start automatically at login', 'Lancer automatiquement \u00e0 la connexion', 'Avvia automaticamente all\'accesso'),
    autostartHint: t('Claude startet beim Hochfahren des Systems automatisch.', 'Claude launches automatically when the system starts.', 'Claude se lance automatiquement au d\u00e9marrage du syst\u00e8me.', 'Claude si avvia automaticamente all\'avvio del sistema.'),
    autostartFailed: t('Autostart konnte nicht aktiviert werden.', 'Could not enable autostart.', 'Impossible d\'activer le d\u00e9marrage automatique.', 'Impossibile attivare l\'avvio automatico.'),
    bgNotifLabel: t('Antwort-Benachrichtigung f\u00fcr Hintergrund-Tabs', 'Notify when a background tab finishes a response', 'Notification de r\u00e9ponse pour les onglets en arri\u00e8re-plan', 'Notifica di risposta per le schede in background'),
    bgNotifHint: t('Native Notification, sobald Claude in einem nicht aktiven Tab fertig geantwortet hat.', 'Native notification once Claude finishes a response in a tab you\u2019re not currently looking at.', 'Notification native d\u00e8s que Claude a termin\u00e9 sa r\u00e9ponse dans un onglet que vous ne regardez pas.', 'Notifica nativa non appena Claude termina una risposta in una scheda che non stai guardando.'),
    micLabel: t('Mikrofon-Zugriff erlauben', 'Allow microphone access', 'Autoriser l\'acc\u00e8s au microphone', 'Consenti l\'accesso al microfono'),
    micHint: t('Erlaubt Claude, dein Mikrofon f\u00fcr Spracheingaben zu nutzen. Beim ersten Klick auf das Mikrofon-Symbol fragt die App einmal nach \u2013 die Auswahl kannst du hier jederzeit \u00e4ndern.', 'Lets Claude use your microphone for voice input. The app asks once the first time you click the microphone icon \u2013 you can change your choice here at any time.', 'Permet \u00e0 Claude d\'utiliser votre microphone pour la saisie vocale. Au premier clic sur l\'ic\u00f4ne du microphone, l\'application demande une fois, vous pouvez modifier ce choix ici \u00e0 tout moment.', 'Permette a Claude di usare il microfono per l\'input vocale. Al primo clic sull\'icona del microfono l\'app chiede una volta, puoi modificare questa scelta qui in qualsiasi momento.'),
    micSnapHint: t('Auf Snap muss das Mikrofon einmalig freigegeben werden. Entweder im Snap-Store \u00f6ffnen und \u201eAudio Record" aktivieren \u2013 oder den Befehl unten im Terminal ausf\u00fchren.', 'On Snap the microphone must be enabled once. Either open the Snap Store and enable \u201cAudio Record\u201d \u2013 or run the command below in a terminal.', 'Sur Snap, le microphone doit \u00eatre autoris\u00e9 une fois. Ouvrez le Snap Store et activez \u00ab Audio Record \u00bb, ou ex\u00e9cutez la commande ci-dessous dans un terminal.', 'Su Snap il microfono deve essere autorizzato una volta. Apri lo Snap Store e attiva "Audio Record", oppure esegui il comando qui sotto in un terminale.'),
    micSnapButton: t('Im Snap-Store \u00f6ffnen', 'Open in Snap Store', 'Ouvrir dans le Snap Store', 'Apri nello Snap Store'),
    micSnapCmdLabel: t('Oder im Terminal:', 'Or in a terminal:', 'Ou dans un terminal :', 'Oppure in un terminale:'),
    micSnapCmdCopy: t('Befehl kopieren', 'Copy command', 'Copier la commande', 'Copia comando'),
    micSnapCmdCopied: t('Kopiert \u2713', 'Copied \u2713', 'Copi\u00e9 \u2713', 'Copiato \u2713'),
    micResetLabel: t('Erneut fragen beim n\u00e4chsten Mikrofon-Klick', 'Ask again on next microphone click', 'Redemander au prochain clic sur le microphone', 'Chiedi di nuovo al prossimo clic sul microfono'),
    micResetDone: t('Erledigt \u2013 Dialog erscheint beim n\u00e4chsten Mikrofon-Klick wieder.', 'Done \u2013 dialog will appear again on next microphone click.', 'Termin\u00e9, le dialogue r\u00e9appara\u00eetra au prochain clic sur le microphone.', 'Fatto, la finestra riapparir\u00e0 al prossimo clic sul microfono.'),
    micResetHint: t('Verwirft die letzte Auswahl, sodass der Hinweis-Dialog beim n\u00e4chsten Mikrofon-Zugriff wieder erscheint.', 'Discards the last choice so the consent dialog appears again on the next microphone request.', 'Annule le dernier choix afin que le dialogue de consentement r\u00e9apparaisse lors du prochain acc\u00e8s au microphone.', 'Annulla l\'ultima scelta in modo che la finestra di consenso riappaia al prossimo accesso al microfono.'),
    micSnapStatusConnected: t('Snap: Audio-Record verbunden', 'Snap: audio-record connected', 'Snap : Audio Record connect\u00e9', 'Snap: Audio Record connesso'),
    micSnapStatusDisconnected: t('Snap: Audio-Record nicht verbunden', 'Snap: audio-record not connected', 'Snap : Audio Record non connect\u00e9', 'Snap: Audio Record non connesso'),
    micSnapStatusUnknown: t('Snap-Status wird gepr\u00fcft\u2026', 'Checking snap status\u2026', 'V\u00e9rification du statut Snap\u2026', 'Verifica dello stato Snap\u2026'),
    micToggleNeedsConsent: t('Bitte zuerst die Snap-Berechtigung freigeben.', 'Please enable the Snap permission first.', 'Veuillez d\'abord activer l\'autorisation Snap.', 'Attiva prima l\'autorizzazione Snap.'),
    hotkeyQp: t('Neuer Chat (Quick-Prompt)', 'New chat (Quick-Prompt)', 'Nouvelle conversation (Quick-Prompt)', 'Nuova chat (Quick-Prompt)'),
    hotkeyClip: t('Zwischenablage als Prompt einf\u00fcgen', 'Send clipboard text as new prompt', 'Envoyer le presse-papiers comme nouveau prompt', 'Invia gli appunti come nuovo prompt'),
    press: t('Klick hier und dr\u00fccke eine Tastenkombination', 'Click here and press a key combination', 'Cliquez ici et appuyez sur une combinaison de touches', 'Fai clic qui e premi una combinazione di tasti'),
    pressing: t('Dr\u00fccke die gew\u00fcnschte Tastenkombination\u2026', 'Press your key combination\u2026', 'Appuyez sur la combinaison souhait\u00e9e\u2026', 'Premi la combinazione desiderata\u2026'),
    clear: t('L\u00f6schen', 'Clear', 'Effacer', 'Cancella'),
    close: t('Schlie\u00dfen', 'Close', 'Fermer', 'Chiudi'),
    registered: t('Hotkey registriert.', 'Hotkey registered.', 'Raccourci enregistré.', 'Scorciatoia registrata.'),
    failed: t('Diese Kombination konnte nicht registriert werden – evtl. systemweit belegt.', 'Could not register this combination — likely already in use system-wide.', 'Impossible d\'enregistrer cette combinaison, elle est peut-être déjà utilisée au niveau du système.', 'Impossibile registrare questa combinazione, forse è già in uso a livello di sistema.'),
    failedWayland: t('Globaler Hotkey konnte unter Wayland nicht registriert werden – der Compositor erlaubt das nicht. Quick-Prompt funktioniert nur bei aktivem Fenster.', 'Could not register a global hotkey on Wayland – the compositor does not allow it. Quick-Prompt only works when the window is focused.', 'Impossible d\'enregistrer un raccourci global sous Wayland, le compositeur ne l\'autorise pas. Le Quick-Prompt ne fonctionne que lorsque la fenêtre est active.', 'Impossibile registrare una scorciatoia globale su Wayland, il compositor non lo consente. Il Quick-Prompt funziona solo quando la finestra è attiva.'),
    conflictQp: t('Diese Kombination ist bereits dem Quick-Prompt-Hotkey zugewiesen.', 'This combination is already assigned to the Quick-Prompt hotkey.', 'Cette combinaison est déjà attribuée au raccourci Quick-Prompt.', 'Questa combinazione è già assegnata alla scorciatoia Quick-Prompt.'),
    conflictClip: t('Diese Kombination ist bereits dem Clipboard-Hotkey zugewiesen.', 'This combination is already assigned to the Clipboard hotkey.', 'Cette combinaison est déjà attribuée au raccourci du presse-papiers.', 'Questa combinazione è già assegnata alla scorciatoia degli appunti.'),
    removed: t('Hotkey entfernt.', 'Hotkey removed.', 'Raccourci supprimé.', 'Scorciatoia rimossa.'),
    needMod: t('Bitte mindestens eine Modifikator-Taste (Strg/Alt/Shift) verwenden.', 'Please use at least one modifier key (Ctrl/Alt/Shift).', 'Veuillez utiliser au moins une touche de modification (Ctrl/Alt/Maj).', 'Usa almeno un tasto modificatore (Ctrl/Alt/Maiusc).'),
    waylandHint: t('Hinweis: Auf Wayland werden globale Hotkeys vom Compositor begrenzt und können je nach Desktop (GNOME/KDE) nicht systemweit greifen. Wenn die Registrierung fehlschlägt, weicht die App still aus – du kannst den Quick-Prompt dann nur bei aktivem Fenster auslösen.', 'Note: On Wayland, global hotkeys are gated by the compositor and may not work system-wide depending on the desktop (GNOME/KDE). If registration fails, the app silently skips it – the Quick-Prompt is then only reachable while the window is focused.', 'Remarque : sous Wayland, les raccourcis globaux sont limités par le compositeur et peuvent ne pas fonctionner au niveau du système selon le bureau (GNOME/KDE). Si l\'enregistrement échoue, l\'application l\'ignore silencieusement, le Quick-Prompt n\'est alors accessible que lorsque la fenêtre est active.', 'Nota: su Wayland le scorciatoie globali sono limitate dal compositor e potrebbero non funzionare a livello di sistema a seconda del desktop (GNOME/KDE). Se la registrazione fallisce, l\'app la ignora silenziosamente, il Quick-Prompt è quindi accessibile solo quando la finestra è attiva.'),
    tplEmpty: t('Noch keine Templates. F\u00fcgst du eines hinzu, erscheint es im Quick-Prompt-Fenster als Auswahl.', 'No templates yet. Once added, they appear as a picker in the Quick-Prompt window.', 'Aucun mod\u00e8le pour l\'instant. Lorsque vous en ajoutez un, il appara\u00eet comme choix dans la fen\u00eatre Quick-Prompt.', 'Ancora nessun modello. Quando ne aggiungi uno, appare come scelta nella finestra Quick-Prompt.'),
    tplName: t('Name (z.B. \u201e\u00dcbersetze")', 'Name (e.g. \u201eTranslate")', 'Nom (par ex. \u00ab Traduire \u00bb)', 'Nome (es. "Traduci")'),
    tplPrefix: t('Prefix-Text (wird vor deinem Input eingef\u00fcgt)', 'Prefix text (prepended to your input)', 'Texte de pr\u00e9fixe (ajout\u00e9 avant votre saisie)', 'Testo prefisso (inserito prima del tuo input)'),
    tplAdd: t('Hinzuf\u00fcgen', 'Add', 'Ajouter', 'Aggiungi'),
    tplDelete: t('L\u00f6schen', 'Delete', 'Supprimer', 'Elimina'),
    tplLimit: t('Maximal 50 Templates.', 'Maximum 50 templates.', 'Maximum 50 mod\u00e8les.', 'Massimo 50 modelli.'),
    tplDup: t('Name existiert bereits.', 'A template with that name already exists.', 'Ce nom existe d\u00e9j\u00e0.', 'Esiste gi\u00e0 un modello con questo nome.')
  };
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{padding:0;background:${th.bg};color:${th.textActive};font-family:system-ui,-apple-system,sans-serif;font-size:13.5px;user-select:none;display:flex;flex-direction:column}
.head{padding:18px 22px 12px;border-bottom:1px solid ${th.border}}
h1{font-size:16px;margin:0 0 2px;font-weight:600}
.sub{color:${th.text};font-size:12px}
.scroll{flex:1;overflow-y:auto;padding:14px 22px 4px}
.scroll::-webkit-scrollbar{width:8px}
.scroll::-webkit-scrollbar-thumb{background:${th.border};border-radius:4px}
.section{margin-bottom:18px}
.section h2{font-size:11px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:${th.text};margin:0 0 10px}
.row{margin:10px 0}
label{display:block;margin-bottom:5px;font-weight:500}
.chk{display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-weight:500}
.chk input{margin-top:2px;accent-color:${ac.from};cursor:pointer}
.hint{color:${th.text};font-size:11.5px;margin-top:3px;margin-left:24px;line-height:1.5}
.hotkey-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin:6px 0}
.hotkey-row .lab{font-size:12px;color:${th.text};grid-column:1/-1;margin-bottom:-2px;font-weight:500}
.capture{padding:8px 12px;background:${th.bgHover};border:1px solid ${th.border};border-radius:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;cursor:pointer;color:${th.textActive};outline:none;min-height:34px;display:flex;align-items:center}
.capture.listening{border-color:${ac.from};background:${th.bgActive}}
button{background:linear-gradient(135deg,${ac.from},${ac.to});color:#fff;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:12.5px;font-weight:500;font-family:inherit;transition:filter .15s ease,border-color .15s ease,color .15s ease}
button.secondary{background:${th.bgHover};color:${th.textActive};border:1px solid ${th.border}}
button.danger{background:transparent;color:${th.text};border:1px solid ${th.border};padding:5px 10px;font-size:11.5px}
button.danger:hover{color:#e05e3e;border-color:#e05e3e}
button:hover{filter:brightness(1.08)}
button:focus-visible,.capture:focus-visible{outline:2px solid ${ac.from};outline-offset:2px}
button:disabled{opacity:.5;cursor:not-allowed}
.tpl-add{display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:10px}
.tpl-add input,.tpl-add textarea{background:${th.bgHover};border:1px solid ${th.border};color:${th.textActive};border-radius:6px;padding:7px 10px;font-family:inherit;font-size:12.5px;outline:none;width:100%}
.tpl-add textarea{resize:vertical;min-height:44px;line-height:1.4;grid-column:1/-1}
.tpl-add input:focus,.tpl-add textarea:focus{border-color:${ac.from}}
.tpl-list{display:flex;flex-direction:column;gap:6px}
.tpl-empty{color:${th.text};font-size:11.5px;font-style:italic;padding:8px 0}
.tpl-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;background:${th.bgHover};border:1px solid ${th.border};border-radius:6px}
.tpl-info{flex:1;min-width:0}
.tpl-name{font-weight:600;font-size:12.5px;margin-bottom:1px}
.tpl-prefix{color:${th.text};font-size:11.5px;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.actions{padding:12px 22px;border-top:1px solid ${th.border};display:flex;gap:8px;justify-content:flex-end}
.status{color:${th.text};font-size:11.5px;margin-top:5px;min-height:14px}
.snap-actions{margin-top:8px;margin-left:24px;display:flex;flex-direction:column;gap:6px}
.snap-cmd-label{color:${th.text};font-size:11.5px;margin-top:4px}
.snap-cmd-row{display:flex;gap:6px;align-items:center}
.snap-cmd-text{flex:1;background:${th.bgHover};border:1px solid ${th.border};border-radius:6px;padding:6px 9px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:${th.textActive};user-select:text;-webkit-user-select:text;overflow-x:auto;white-space:nowrap}
.snap-cmd-copy-btn{padding:6px 10px!important;font-size:11.5px}
.hint-block{margin-left:0;margin-top:6px}
.snap-status-pill{display:inline-flex;align-items:center;gap:6px;margin:6px 0 0 24px;padding:3px 10px;border-radius:999px;font-size:11.5px;border:1px solid ${th.border};background:${th.bgHover};color:${th.text}}
.snap-status-pill .dot{width:8px;height:8px;border-radius:50%;background:${th.text}}
.snap-status-pill[data-status="connected"]{background:rgba(46,160,67,.15);border-color:rgba(46,160,67,.4);color:#3aaf52}
.snap-status-pill[data-status="connected"] .dot{background:#3aaf52;box-shadow:0 0 0 0 rgba(58,175,82,.6);animation:dotpulse 2.4s infinite}
.snap-status-pill[data-status="disconnected"]{background:rgba(224,94,62,.15);border-color:rgba(224,94,62,.4);color:#e05e3e}
.snap-status-pill[data-status="disconnected"] .dot{background:#e05e3e}
@keyframes dotpulse{0%{box-shadow:0 0 0 0 rgba(58,175,82,.6)}70%{box-shadow:0 0 0 6px rgba(58,175,82,0)}100%{box-shadow:0 0 0 0 rgba(58,175,82,0)}}
${customTitlebarCSS()}
</style></head><body>
${customTitlebarHTML(t('Claude – Einstellungen', 'Claude – Settings', 'Claude – Paramètres', 'Claude – Impostazioni'))}
<div class="head">
  <h1>${i18n.title}</h1>
  <div class="sub">${i18n.subtitle}</div>
</div>

<div class="scroll">

  <div class="section">
    <h2>${i18n.secBackground}</h2>
    <div class="row">
      <label class="chk"><input type="checkbox" id="mc"><span>${i18n.minimizeLabel}</span></label>
      <div class="hint">${i18n.minimizeHint}</div>
    </div>
    <div class="row">
      <label class="chk"><input type="checkbox" id="as"><span>${i18n.autostartLabel}</span></label>
      <div class="hint">${i18n.autostartHint}</div>
    </div>
    <div class="row">
      <label class="chk"><input type="checkbox" id="bn"><span>${i18n.bgNotifLabel}</span></label>
      <div class="hint">${i18n.bgNotifHint}</div>
    </div>
    <div class="status" id="status-bg"></div>
  </div>

  <div class="section">
    <h2>${i18n.secMicrophone}</h2>
    <div class="row">
      <label class="chk"><input type="checkbox" id="mic"><span>${i18n.micLabel}</span></label>
      <div class="snap-status-pill" id="mic-snap-status" style="display:none" data-status="unknown">
        <span class="dot"></span><span class="text">${i18n.micSnapStatusUnknown}</span>
      </div>
      <div class="hint">${i18n.micHint}</div>
      <div class="hint" id="mic-snap-hint" style="display:none">${i18n.micSnapHint}</div>
      <div id="mic-snap-actions" class="snap-actions" style="display:none">
        <button class="secondary" id="mic-snap-open">${i18n.micSnapButton}</button>
        <div class="snap-cmd-label">${i18n.micSnapCmdLabel}</div>
        <div class="snap-cmd-row">
          <code class="snap-cmd-text" id="mic-snap-cmd">sudo snap connect claude-ai-desktop:audio-record</code>
          <button class="secondary snap-cmd-copy-btn" id="mic-snap-copy">${i18n.micSnapCmdCopy}</button>
        </div>
      </div>
    </div>
    <div class="row">
      <button class="secondary" id="mic-reset">${i18n.micResetLabel}</button>
      <div class="hint hint-block">${i18n.micResetHint}</div>
    </div>
    <div class="status" id="status-mic"></div>
  </div>

  <div class="section">
    <h2>${i18n.secHotkeys}</h2>
    ${isWayland ? `<div class="hint" style="margin-left:0;margin-bottom:10px">${i18n.waylandHint}</div>` : ''}
    <div class="hotkey-row">
      <div class="lab">${i18n.hotkeyQp}</div>
      <div class="capture" data-key="qp" tabindex="0">${i18n.press}</div>
      <button class="danger" data-clear="qp">${i18n.clear}</button>
    </div>
    <div class="hotkey-row">
      <div class="lab">${i18n.hotkeyClip}</div>
      <div class="capture" data-key="clip" tabindex="0">${i18n.press}</div>
      <button class="danger" data-clear="clip">${i18n.clear}</button>
    </div>
    <div class="status" id="status-hk"></div>
  </div>

  <div class="section">
    <h2>${i18n.secTemplates}</h2>
    <div class="tpl-add">
      <input type="text" id="tpl-name" maxlength="40" placeholder="${i18n.tplName}">
      <button id="tpl-add">${i18n.tplAdd}</button>
      <textarea id="tpl-prefix" maxlength="2000" placeholder="${i18n.tplPrefix}"></textarea>
    </div>
    <div class="tpl-list" id="tpl-list"></div>
    <div class="status" id="status-tpl"></div>
  </div>

</div>

<div class="actions">
  <button id="close">${i18n.close}</button>
</div>

<script>
const I = ${safeJson(i18n)};
const api = window.settingsAPI;
const mc = document.getElementById('mc');
const as = document.getElementById('as');
const bn = document.getElementById('bn');
const mic = document.getElementById('mic');
const micReset = document.getElementById('mic-reset');
const micSnapHint = document.getElementById('mic-snap-hint');
const micSnapActions = document.getElementById('mic-snap-actions');
const micSnapStatusPill = document.getElementById('mic-snap-status');
const micSnapStatusText = micSnapStatusPill ? micSnapStatusPill.querySelector('.text') : null;
const micSnapOpen = document.getElementById('mic-snap-open');
const micSnapCopy = document.getElementById('mic-snap-copy');
let micSnapCopyTimer = null;
let micSnapPollHandle = null;
let isSnapInstall = false;
const closeBtn = document.getElementById('close');
const statusBg = document.getElementById('status-bg');
const statusHk = document.getElementById('status-hk');
const statusTpl = document.getElementById('status-tpl');
const statusMic = document.getElementById('status-mic');
let statusMicTimer = null;

const captures = { qp: null, clip: null };
const display = { qp: I.press, clip: I.press };
let listeningKey = null;

document.querySelectorAll('.capture').forEach(el => {
  const key = el.dataset.key;
  captures[key] = el;
  el.addEventListener('click', () => startListening(key));
  el.addEventListener('blur', () => { if (listeningKey === key) resetCapture(key); });
  el.addEventListener('keydown', (e) => onKeydown(e, key));
});
document.querySelectorAll('button[data-clear]').forEach(btn => {
  btn.addEventListener('click', () => clearHotkey(btn.dataset.clear));
});

function startListening(key) {
  if (listeningKey && listeningKey !== key) resetCapture(listeningKey);
  listeningKey = key;
  captures[key].classList.add('listening');
  captures[key].textContent = I.pressing;
  statusHk.textContent = '';
  captures[key].focus();
}

function resetCapture(key) {
  if (listeningKey === key) listeningKey = null;
  captures[key].classList.remove('listening');
  captures[key].textContent = display[key];
}

function onKeydown(e, key) {
  if (listeningKey !== key) return;
  e.preventDefault();
  const k = e.key;
  if (k === 'Escape') { resetCapture(key); return; }
  if (['Control','Shift','Alt','Meta','Dead','Unidentified'].includes(k)) return;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (parts.length === 0) { statusHk.textContent = I.needMod; return; }
  let kk = k;
  if (kk === ' ') kk = 'Space';
  else if (kk.length === 1) kk = kk.toUpperCase();
  parts.push(kk);
  const accel = parts.join('+');
  applyHotkey(key, accel).then(res => {
    if (res === 'ok') statusHk.textContent = I.registered;
    else if (res === 'conflict') statusHk.textContent = key === 'qp' ? I.conflictClip : I.conflictQp;
    else if (res === 'failed-wayland') statusHk.textContent = I.failedWayland;
    else statusHk.textContent = I.failed;
    resetCapture(key);
  });
}

function applyHotkey(key, accel) {
  const fn = key === 'qp' ? api.setHotkey : key === 'clip' ? api.setClipboardHotkey : null;
  if (!fn) return Promise.resolve('failed');
  return fn(accel).then(res => {
    if (res === 'ok') display[key] = accel;
    return res;
  });
}

function clearHotkey(key) {
  applyHotkey(key, null).then(() => {
    display[key] = I.press;
    captures[key].textContent = I.press;
    statusHk.textContent = I.removed;
  });
}

mc.addEventListener('change', () => api.setMinimize(mc.checked));
as.addEventListener('change', async () => {
  const want = as.checked;
  as.disabled = true;
  try {
    const r = await api.setAutostart(want);
    if (r !== 'ok') { as.checked = !want; statusBg.textContent = I.autostartFailed; }
    else statusBg.textContent = '';
  } finally { as.disabled = false; }
});
bn.addEventListener('change', () => api.setBgNotifications(bn.checked));
mic.addEventListener('change', async () => {
  const want = mic.checked;
  if (!isSnapInstall) {
    api.setMicrophone(want);
    return;
  }
  // Snap: Plug-Status pruefen + ggf. Consent-Dialog
  mic.disabled = true;
  try {
    const res = await api.setMicrophoneWithConsent(want);
    mic.checked = !!res.applied;
    updateSnapStatus(res.status);
    if (want && !res.applied && res.status === 'disconnected') {
      statusMic.textContent = I.micToggleNeedsConsent;
      if (statusMicTimer) clearTimeout(statusMicTimer);
      statusMicTimer = setTimeout(() => { statusMic.textContent = ''; }, 4000);
    }
  } catch {
    mic.checked = !want;
  } finally {
    mic.disabled = false;
  }
});

function updateSnapStatus(status) {
  if (!micSnapStatusPill || !micSnapStatusText) return;
  micSnapStatusPill.dataset.status = status;
  if (status === 'connected') micSnapStatusText.textContent = I.micSnapStatusConnected;
  else if (status === 'disconnected') micSnapStatusText.textContent = I.micSnapStatusDisconnected;
  else micSnapStatusText.textContent = I.micSnapStatusUnknown;
}

async function refreshSnapStatus() {
  if (!isSnapInstall) return;
  try {
    const status = await api.getSnapMicStatus();
    updateSnapStatus(status);
  } catch {}
}
micReset.addEventListener('click', () => {
  api.resetMicrophoneConsent();
  mic.checked = false;
  statusMic.textContent = I.micResetDone;
  if (statusMicTimer) clearTimeout(statusMicTimer);
  statusMicTimer = setTimeout(() => { statusMic.textContent = ''; }, 2500);
});
micSnapOpen.addEventListener('click', () => api.openSnapPermissions());
micSnapCopy.addEventListener('click', () => {
  api.copySnapCmd();
  micSnapCopy.textContent = I.micSnapCmdCopied;
  if (micSnapCopyTimer) clearTimeout(micSnapCopyTimer);
  micSnapCopyTimer = setTimeout(() => { micSnapCopy.textContent = I.micSnapCmdCopy; }, 1800);
});

api.get().then(s => {
  mc.checked = !!s.minimizeOnClose;
  as.checked = !!s.autostart;
  bn.checked = !!s.bgNotifications;
  mic.checked = !!s.microphoneEnabled;
  isSnapInstall = !!s.isSnap;
  if (s.isSnap) {
    micSnapHint.style.display = '';
    micSnapActions.style.display = '';
    if (micSnapStatusPill) micSnapStatusPill.style.display = '';
    refreshSnapStatus();
    micSnapPollHandle = setInterval(refreshSnapStatus, 3000);
    window.addEventListener('beforeunload', () => {
      if (micSnapPollHandle) { clearInterval(micSnapPollHandle); micSnapPollHandle = null; }
    });
  }
  if (s.hotkey) { display.qp = s.hotkey; captures.qp.textContent = s.hotkey; }
  if (s.clipboardHotkey) { display.clip = s.clipboardHotkey; captures.clip.textContent = s.clipboardHotkey; }
  renderTemplates(s.templates || []);
});

const tplName = document.getElementById('tpl-name');
const tplPrefix = document.getElementById('tpl-prefix');
const tplAdd = document.getElementById('tpl-add');
const tplList = document.getElementById('tpl-list');

function renderTemplates(list) {
  tplList.innerHTML = '';
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'tpl-empty';
    e.textContent = I.tplEmpty;
    tplList.appendChild(e);
    return;
  }
  for (const t of list) {
    const item = document.createElement('div');
    item.className = 'tpl-item';
    const info = document.createElement('div'); info.className = 'tpl-info';
    const n = document.createElement('div'); n.className = 'tpl-name'; n.textContent = t.name;
    const p = document.createElement('div'); p.className = 'tpl-prefix'; p.textContent = t.prefix;
    info.appendChild(n); info.appendChild(p);
    const del = document.createElement('button'); del.className = 'danger'; del.textContent = I.tplDelete;
    del.addEventListener('click', () => api.deleteTemplate(t.id).then(res => renderTemplates(res.templates)));
    item.appendChild(info); item.appendChild(del);
    tplList.appendChild(item);
  }
}

tplAdd.addEventListener('click', () => {
  const name = tplName.value.trim();
  const prefix = tplPrefix.value;
  if (!name || !prefix.trim()) return;
  api.addTemplate({ name, prefix }).then(res => {
    if (res && Array.isArray(res.templates)) {
      tplName.value = '';
      tplPrefix.value = '';
      statusTpl.textContent = '';
      renderTemplates(res.templates);
    } else if (res && res.error === 'limit') statusTpl.textContent = I.tplLimit;
    else if (res && res.error === 'dup') statusTpl.textContent = I.tplDup;
  });
});

closeBtn.addEventListener('click', () => api.close());
const titlebarClose = document.getElementById('cd-titlebar-close');
if (titlebarClose) titlebarClose.addEventListener('click', () => api.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !listeningKey && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') api.close();
});
</script>
</body></html>`;
}

function getWhatsNewHTML(force = false) {
  const th = subTheme();
  const ac = accent();
  // Immer nur die Notes der aktuellen Version zeigen (alles seit dem letzten Release),
  // nie kumuliert ueber uebersprungene Versionen. force=true erzwingt versionsToShow=[version].
  const notes = getFilteredNotes(version, windowState.lastSeenVersion, true);
  const icons = {
    tray: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="3"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 2 4 14 12 14 11 22 20 10 12 10 13 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    tabs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 4v5"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/></svg>',
    palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.1"/><circle cx="12" cy="8" r="1.1"/><circle cx="16" cy="10" r="1.1"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>'
  };
  const i18n = {
    header: t('Neu in Claude v' + version, 'New in Claude v' + version, 'Nouveautés de Claude v' + version, 'Novità di Claude v' + version),
    sub: t('Ein kurzer \u00dcberblick \u00fcber die wichtigsten \u00c4nderungen', 'A quick look at the highlights', 'Un aperçu rapide des principales nouveautés', 'Una rapida panoramica sulle novità principali'),
    close: t('Los geht\u2019s', 'Let\u2019s go', 'C’est parti', 'Iniziamo'),
    openSettings: t('App-Einstellungen \u00f6ffnen', 'Open app settings', 'Ouvrir les paramètres de l’application', 'Apri le impostazioni dell’app')
  };
  // Optionales Bild pro Note: 'image' kann eine data:-URL oder ein Pfad relativ zum
  // App-Verzeichnis sein (z.B. 'whatsnew/1.4.8-feature.png'). Ohne Bild -> Icon.
  const slideMedia = (n) => {
    const fallback = `<div class="slide-ic">${icons[n.icon] || icons.check}</div>`;
    if (!n.image) return fallback;
    // image: String (ein Bild fuer alle Sprachen) ODER {de,en,fr,it}-Objekt (Bild pro
    // Sprache, analog zu title/text). Der Screenshot ist die einzige sprachabhaengige Stelle.
    let src = typeof n.image === 'string' ? n.image : localize(n.image);
    if (!src) return fallback;
    if (!src.startsWith('data:')) {
      // Das Fenster laeuft als data:-URL (opaque origin) und darf keine file://-Bilder laden,
      // darum das Asset zur Laufzeit lesen und als data-URL einbetten.
      try {
        const buf = fs.readFileSync(path.join(__dirname, n.image));
        const ext = path.extname(n.image).slice(1).toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
        src = `data:${mime};base64,${buf.toString('base64')}`;
      } catch { return fallback; }
    }
    return `<img class="slide-img" src="${src}" alt="">`;
  };
  const slides = notes.map((n, i) => `
    <div class="slide${i === 0 ? ' active' : ''}${n.image ? ' has-img' : ''}" data-i="${i}">
      ${slideMedia(n)}
      <div class="slide-title">${localize(n.title)}</div>
      <div class="slide-text">${localize(n.text)}</div>
    </div>`).join('');
  const dots = notes.map((_, i) => `<span class="dot${i === 0 ? ' active' : ''}" data-i="${i}"></span>`).join('');
  const obNext = t('Weiter', 'Next', 'Suivant', 'Avanti');
  const obBack = t('Zurück', 'Back', 'Retour', 'Indietro');
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:${th.bg};color:${th.textActive};font-family:system-ui,-apple-system,sans-serif;font-size:14px;user-select:none}
body{display:flex;flex-direction:column;overflow:hidden}
${customTitlebarCSS()}
@keyframes wnGradShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
.hero{position:relative;padding:30px 32px 28px;overflow:hidden;color:#fff;flex-shrink:0;
  background:linear-gradient(135deg,${ac.from},${ac.to},${ac.from},${ac.to});
  background-size:300% 300%;
  animation:wnGradShift 9s ease-in-out infinite}
.hero::before{content:'';position:absolute;right:-90px;top:-90px;width:240px;height:240px;border-radius:50%;background:rgba(255,255,255,.10);pointer-events:none}
.hero::after{content:'';position:absolute;right:40px;bottom:-70px;width:160px;height:160px;border-radius:50%;background:rgba(255,255,255,.06);pointer-events:none}
.hero-pill{display:inline-flex;align-items:center;gap:6px;background:rgba(0,0,0,.22);padding:5px 12px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.5px;margin-bottom:14px;position:relative;z-index:1;backdrop-filter:blur(4px)}
.hero-pill::before{content:'';width:6px;height:6px;border-radius:50%;background:#fff;box-shadow:0 0 8px rgba(255,255,255,.65)}
.hero-title{font-size:28px;font-weight:700;letter-spacing:-.6px;margin-bottom:6px;position:relative;z-index:1;line-height:1.1}
.hero-sub{font-size:13.5px;line-height:1.5;opacity:.92;position:relative;z-index:1;max-width:80%}
.body{flex:1;overflow-y:auto;padding:18px}
.trans-note{margin:0 0 14px;padding:10px 14px;border-radius:10px;font-size:11.5px;line-height:1.5;background:color-mix(in srgb,${ac.from} 10%,${th.bgHover});border:1px solid color-mix(in srgb,${ac.from} 30%,${th.border});color:${th.text}}
.body::-webkit-scrollbar{width:8px}
.body::-webkit-scrollbar-thumb{background:${th.border};border-radius:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.tile{padding:18px 18px 16px;border-radius:14px;background:${th.bgHover};border:1px solid ${th.border};
  display:flex;flex-direction:column;gap:8px;transition:border-color .15s,transform .15s,background .15s}
.tile:hover{border-color:color-mix(in srgb,${ac.from} 50%,${th.border});background:${th.bgActive}}
.tile-ic{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,color-mix(in srgb,${ac.from} 18%,transparent),color-mix(in srgb,${ac.to} 14%,transparent));
  border:1px solid color-mix(in srgb,${ac.from} 35%,transparent);
  display:flex;align-items:center;justify-content:center;color:${ac.from};margin-bottom:2px}
.tile-ic svg{width:18px;height:18px}
.tile-title{font-weight:600;font-size:13.5px;color:${th.textActive};letter-spacing:-.1px;line-height:1.3}
.tile-text{color:${th.text};font-size:12px;line-height:1.55}
.tile-text code{display:inline-block;margin:2px 0;padding:2px 6px;background:${th.bgActive};border:1px solid ${th.border};border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:${th.textActive};user-select:text}
.slides{position:relative;flex:1;display:flex;align-items:center;justify-content:center;padding:8px 24px;overflow-y:auto}
.slides::-webkit-scrollbar{width:8px}
.slides::-webkit-scrollbar-thumb{background:${th.border};border-radius:4px}
.slide{display:none;flex-direction:column;align-items:center;text-align:center;max-width:460px}
.slide.active{display:flex}
.slide.active .slide-ic{animation:obPop .5s cubic-bezier(.34,1.56,.64,1) both}
.slide.active .slide-title{animation:obUp .42s ease .1s both}
.slide.active .slide-text{animation:obUp .42s ease .18s both}
@keyframes obPop{0%{opacity:0;transform:scale(.6) translateY(8px)}100%{opacity:1;transform:none}}
@keyframes obUp{0%{opacity:0;transform:translateY(12px)}100%{opacity:1;transform:none}}
.slide.has-img{max-width:500px}
.slide-img{width:100%;max-width:460px;max-height:250px;object-fit:cover;border-radius:14px;border:1px solid ${th.border};margin-bottom:20px;box-shadow:0 10px 28px rgba(0,0,0,.28)}
.slide.active .slide-img{animation:obImg .55s cubic-bezier(.22,1,.36,1) both}
@keyframes obImg{0%{opacity:0;transform:scale(.96) translateY(12px)}100%{opacity:1;transform:none}}
.slide-ic{width:66px;height:66px;border-radius:18px;background:linear-gradient(135deg,color-mix(in srgb,${ac.from} 20%,transparent),color-mix(in srgb,${ac.to} 15%,transparent));
  border:1px solid color-mix(in srgb,${ac.from} 38%,transparent);display:flex;align-items:center;justify-content:center;color:${ac.from};margin-bottom:20px}
.slide-ic svg{width:30px;height:30px}
.slide-title{font-weight:700;font-size:20px;letter-spacing:-.3px;color:${th.textActive};margin-bottom:12px;line-height:1.2}
.slide-text{color:${th.text};font-size:14px;line-height:1.65}
.dots{display:flex;gap:7px;justify-content:center;padding:4px 0 2px;flex-shrink:0}
.dot{width:7px;height:7px;border-radius:50%;background:${th.border};cursor:pointer;transition:background .2s,width .2s,border-radius .2s}
.dot.active{background:${ac.from};width:20px;border-radius:4px}
.footer{padding:14px 24px 20px;display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid ${th.border};flex-shrink:0}
.footer button{font-family:inherit;cursor:pointer;border:none;border-radius:8px;font-size:12.5px;font-weight:600;transition:filter .15s,color .15s,background .15s}
.footer button.secondary{background:transparent;color:${th.text};padding:6px 0}
.footer button.secondary:hover{color:${th.textActive}}
.footer button.primary{background:linear-gradient(135deg,${ac.from},${ac.to});color:#fff;padding:11px 26px;box-shadow:0 4px 14px ${ac.from}33}
.footer button.primary:hover{filter:brightness(1.08)}
.footer button:focus-visible{outline:2px solid ${ac.from};outline-offset:2px}
</style></head><body>
${customTitlebarHTML(t('Neu in Claude', 'What’s new in Claude', 'Nouveautés de Claude', 'Novità di Claude'))}
<div class="hero">
  <div class="hero-pill">v${version}</div>
  <div class="hero-title">${t('Was ist neu', 'What’s new', 'Nouveautés', 'Novità')}</div>
  <div class="hero-sub">${i18n.sub}</div>
</div>
<div class="body"><div class="slides">${slides}</div></div>
<div class="dots">${dots}</div>
<div class="footer">
  <button class="secondary" id="ob-back" style="visibility:hidden">${obBack}</button>
  <button class="primary" id="ob-next">${obNext}</button>
</div>
<script>
(function(){
  var idx=0, total=${notes.length};
  var slides=[].slice.call(document.querySelectorAll('.slide'));
  var dots=[].slice.call(document.querySelectorAll('.dot'));
  var back=document.getElementById('ob-back'), next=document.getElementById('ob-next');
  var nextLbl=${JSON.stringify(obNext)}, doneLbl=${JSON.stringify(i18n.close)};
  function show(i){
    idx=Math.max(0,Math.min(total-1,i));
    for(var j=0;j<slides.length;j++){slides[j].classList.toggle('active',j===idx);dots[j].classList.toggle('active',j===idx);}
    back.style.visibility=idx===0?'hidden':'visible';
    next.textContent=idx>=total-1?doneLbl:nextLbl;
  }
  back.addEventListener('click',function(){show(idx-1);});
  next.addEventListener('click',function(){ if(idx>=total-1){window.whatsNewAPI.close();} else {show(idx+1);} });
  for(var j=0;j<dots.length;j++){(function(k){dots[k].addEventListener('click',function(){show(k);});})(j);}
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'){show(idx+1);} else if(e.key==='ArrowLeft'){show(idx-1);}
    else if(e.key==='Escape'){window.whatsNewAPI.close();}
    else if(e.key==='Enter'){ if(idx>=total-1){window.whatsNewAPI.close();} else {show(idx+1);} }
  });
  var tc=document.getElementById('cd-titlebar-close'); if(tc){tc.addEventListener('click',function(){window.whatsNewAPI.close();});}
  if(total<=1){ next.textContent=doneLbl; }
  show(0);
})();
</script>
</body></html>`;
}

function openWhatsNewWindow(force = false) {
  if (whatsNewWindow && !whatsNewWindow.isDestroyed()) {
    whatsNewWindow.focus();
    return;
  }
  const size = { width: 640, height: 680 };
  const wnBase = {
    ...size,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false, resizable: false, minimizable: false, maximizable: false,
    title: t('Neu in Claude', 'What\u2019s new in Claude', 'Nouveautés de Claude', 'Novità di Claude'),
    backgroundColor: subTheme().bg,
    icon: icon(),
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-whatsnew.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      spellcheck: false
    }
  };
  whatsNewWindow = new BrowserWindow({
    ...wnBase, ...centerOnMainWindow(size.width, size.height)
  });
  whatsNewWindow.setMenu(null);
  whatsNewWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getWhatsNewHTML(force)));
  whatsNewWindow.on('closed', () => { whatsNewWindow = null; });
}

// About / Info-Fenster

function getAboutHTML() {
  const th = subTheme();
  const ac = accent();
  const i18n = {
    tagline: t('Inoffizieller claude.ai-Wrapper für Linux', 'Unofficial claude.ai wrapper for Linux', 'Wrapper claude.ai non officiel pour Linux', 'Wrapper claude.ai non ufficiale per Linux'),
    secAbout: t('Über die App', 'About this app', 'À propos de l’application', 'Informazioni sull’app'),
    aboutText: t(
      'Eine inoffizielle Community-App, die claude.ai als native Desktop-Anwendung auf Linux bringt – mit Tabs, Tray, Quick-Prompt, Voice-Input und mehr. Open Source unter MIT-Lizenz.',
      'An unofficial community app that brings claude.ai to Linux as a native desktop application – with tabs, tray, quick-prompt, voice input and more. Open source under the MIT licence.',
      'Une application communautaire non officielle qui amène claude.ai sur Linux comme application de bureau native, avec onglets, zone de notification, Quick-Prompt, saisie vocale et plus encore. Open source sous licence MIT.',
      'Un\'app comunitaria non ufficiale che porta claude.ai su Linux come applicazione desktop nativa, con schede, area di notifica, Quick-Prompt, input vocale e altro ancora. Open source con licenza MIT.'
    ),
    secLinks: t('Links', 'Links', 'Liens', 'Link'),
    linkRepo: t('Quellcode & Issues auf GitHub', 'Source code & issues on GitHub', 'Code source et tickets sur GitHub', 'Codice sorgente e issue su GitHub'),
    linkSupport: t('Anthropic-Support (offizielle Hilfe für claude.ai)', 'Anthropic Support (official help for claude.ai)', 'Support Anthropic (aide officielle pour claude.ai)', 'Supporto Anthropic (aiuto ufficiale per claude.ai)'),
    secLegal: t('Rechtliches', 'Legal', 'Mentions légales', 'Note legali'),
    legalText: t(
      'Diese App ist nicht mit Anthropic verbunden und wird nicht von Anthropic unterstützt. „Claude" und das Claude-Logo sind Markenzeichen von Anthropic PBC. Für Fragen zu Account, Login, Abo oder Bezahlung wende dich bitte direkt an den Anthropic-Support.',
      'This app is not affiliated with or endorsed by Anthropic. "Claude" and the Claude logo are trademarks of Anthropic PBC. For account, login, subscription or billing questions please contact Anthropic Support directly.',
      'Cette application n\'est ni affiliée à Anthropic ni approuvée par Anthropic. « Claude » et le logo Claude sont des marques d\'Anthropic PBC. Pour toute question concernant le compte, la connexion, l\'abonnement ou le paiement, contactez directement le support Anthropic.',
      'Questa applicazione non è affiliata ad Anthropic né approvata da Anthropic. "Claude" e il logo Claude sono marchi di Anthropic PBC. Per domande su account, accesso, abbonamento o pagamento, contatta direttamente il supporto Anthropic.'
    ),
    btnWhatsNew: t('Neuigkeiten anzeigen', 'Show What’s New', 'Afficher les nouveautés', 'Mostra le novità'),
    btnClose: t('Schließen', 'Close', 'Fermer', 'Chiudi')
  };
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:${th.bg};color:${th.textActive};font-family:system-ui,-apple-system,sans-serif;font-size:13.5px;user-select:none}
body{display:flex;flex-direction:column;overflow:hidden}
.hero{position:relative;padding:24px 28px 22px;background:linear-gradient(135deg,${ac.from},${ac.to});color:#fff;overflow:hidden;display:flex;align-items:center;gap:16px}
.hero::before{content:'';position:absolute;right:-70px;top:-70px;width:210px;height:210px;border-radius:50%;background:rgba(255,255,255,.12);pointer-events:none}
.hero::after{content:'';position:absolute;right:36px;bottom:-46px;width:126px;height:126px;border-radius:50%;background:rgba(255,255,255,.08);pointer-events:none}
.hero-logo{width:58px;height:58px;border-radius:14px;flex-shrink:0;position:relative;z-index:1;box-shadow:0 2px 12px rgba(0,0,0,.28)}
.hero-text{position:relative;z-index:1;flex:1;min-width:0}
.hero-name{font-size:21px;font-weight:700;letter-spacing:-.2px;margin-bottom:2px}
.hero-version{font-size:12px;opacity:.85;font-family:ui-monospace,Menlo,Consolas,monospace;margin-bottom:6px}
.hero-tagline{font-size:13px;opacity:.92}
.body{flex:1;padding:18px 28px 12px;overflow-y:auto;display:flex;flex-direction:column;gap:16px}
.body::-webkit-scrollbar{width:8px}
.body::-webkit-scrollbar-thumb{background:${th.border};border-radius:4px}
h2{font-size:11px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:${th.text};margin-bottom:6px}
.about-text{font-size:13px;line-height:1.55;color:${th.textActive}}
.legal-text{font-size:12px;color:${th.text};line-height:1.5}
.link-list{display:flex;flex-direction:column;gap:6px}
.link-list a{display:flex;align-items:center;gap:10px;padding:9px 12px;background:${th.bgHover};border:1px solid ${th.border};border-radius:7px;color:${th.textActive};text-decoration:none;font-size:12.5px;cursor:pointer;transition:background .12s,border-color .12s}
.link-list a:hover{background:${th.bgActive};border-color:${ac.from}}
.link-list a:focus-visible{outline:2px solid ${ac.from};outline-offset:2px}
.link-list svg{width:15px;height:15px;flex-shrink:0;color:${ac.from}}
.footer{padding:14px 28px 18px;display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid ${th.border}}
button{background:linear-gradient(135deg,${ac.from},${ac.to});color:#fff;border:none;padding:9px 18px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:600;font-family:inherit;transition:filter .15s ease}
button.secondary{background:${th.bgHover};color:${th.textActive};border:1px solid ${th.border}}
button:hover{filter:brightness(1.08)}
button:focus-visible{outline:2px solid ${ac.from};outline-offset:2px}
${customTitlebarCSS()}
</style></head><body>
${customTitlebarHTML(t('Über Claude Desktop', 'About Claude Desktop', 'À propos de Claude Desktop', 'Informazioni su Claude Desktop'))}
<div class="hero">
  <img class="hero-logo" src="${iconDataUrlForCurrentTheme()}" alt="Claude Desktop"/>
  <div class="hero-text">
    <div class="hero-name">Claude Desktop</div>
    <div class="hero-version">v${version}</div>
    <div class="hero-tagline">${i18n.tagline}</div>
  </div>
</div>
<div class="body">
  <div>
    <h2>${i18n.secAbout}</h2>
    <div class="about-text">${i18n.aboutText}</div>
  </div>
  <div>
    <h2>${i18n.secLinks}</h2>
    <div class="link-list">
      <a data-href="https://github.com/simonlinuxcraft/claude-ai-desktop-app">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/></svg>
        <span>${i18n.linkRepo}</span>
      </a>
      <a data-href="https://support.anthropic.com">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
        <span>${i18n.linkSupport}</span>
      </a>
    </div>
  </div>
  <div>
    <h2>${i18n.secLegal}</h2>
    <div class="legal-text">${i18n.legalText}</div>
  </div>
</div>
<div class="footer">
  <button class="secondary" id="whatsnew-btn">${i18n.btnWhatsNew}</button>
  <button id="close">${i18n.btnClose}</button>
</div>
<script>
const api = window.aboutAPI;
document.getElementById('close').addEventListener('click', () => api.close());
document.getElementById('cd-titlebar-close')?.addEventListener('click', () => api.close());
document.getElementById('whatsnew-btn').addEventListener('click', () => api.openWhatsNew());
document.querySelectorAll('a[data-href]').forEach(a => {
  a.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(a.dataset.href); });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.close(); });
</script>
</body></html>`;
}

function openAboutWindow() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }
  const size = { width: 540, height: 580 };
  const base = {
    ...size,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false, resizable: false, minimizable: false, maximizable: false,
    title: t('Über Claude Desktop', 'About Claude Desktop', 'À propos de Claude Desktop', 'Informazioni su Claude Desktop'),
    backgroundColor: subTheme().bg,
    icon: icon(),
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-about.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      spellcheck: false
    }
  };
  aboutWindow = new BrowserWindow({ ...base, ...centerOnMainWindow(size.width, size.height) });
  aboutWindow.setMenu(null);
  aboutWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getAboutHTML()));
  aboutWindow.on('closed', () => { aboutWindow = null; });
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  const swSize = { width: 540, height: 480 };
  const swBase = {
    ...swSize,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false, resizable: false, minimizable: false, maximizable: false,
    title: t('Claude \u2013 Einstellungen', 'Claude \u2013 Settings', 'Claude – Paramètres', 'Claude – Impostazioni'),
    backgroundColor: subTheme().bg,
    icon: icon(),
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      spellcheck: false
    }
  };
  settingsWindow = new BrowserWindow({
    ...swBase, ...centerOnMainWindow(swSize.width, swSize.height)
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getSettingsHTML()));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// Custom App-Menü (HTML-Popup statt OS-nativ)

function getAppMenuItems() {
  const designLabel = `Design: ${customDesign ? 'Modern' : 'Classic'}`;
  return [
    { type: 'item', action: 'new-tab', label: t('Neuer Tab', 'New Tab', 'Nouvel onglet', 'Nuova scheda'), accel: 'Ctrl+T', icon: 'plus' },
    { type: 'item', action: 'close-tab', label: t('Tab schließen', 'Close Tab', 'Fermer l’onglet', 'Chiudi scheda'), accel: 'Ctrl+W', icon: 'x' },
    { type: 'sep' },
    { type: 'item', action: 'export', label: t('Konversation exportieren…', 'Export conversation…', 'Exporter la conversation…', 'Esporta la conversazione…'), accel: 'Ctrl+Shift+E', icon: 'download' },
    { type: 'item', action: 'reload', label: t('Neu laden', 'Reload', 'Recharger', 'Ricarica'), accel: 'Ctrl+R', icon: 'refresh' },
    { type: 'sep' },
    { type: 'item', action: 'design-toggle', label: designLabel, icon: 'palette' },
    { type: 'item', action: 'settings', label: t('App-Einstellungen…', 'App Settings…', 'Paramètres de l\'application…', 'Impostazioni dell\'app…'), accel: 'Ctrl+,', icon: 'cog' },
    { type: 'sep' },
    { type: 'item', action: 'check-updates', label: t('Nach Updates suchen…', 'Check for Updates…', 'Rechercher des mises à jour…', 'Controlla aggiornamenti…'), icon: 'refresh' },
    { type: 'item', action: 'bug-report', label: (bugReportStrings[sysLang] || bugReportStrings.en).title, icon: 'bug' },
    { type: 'item', action: 'copy-diagnostics', label: t('Diagnose-Info kopieren', 'Copy diagnostics info', 'Copier les infos de diagnostic', 'Copia informazioni di diagnostica'), icon: 'info' },
    { type: 'item', action: 'reset-verification', label: t('claude.ai-Verifizierung zurücksetzen…', 'Reset claude.ai verification…', 'Réinitialiser la vérification claude.ai…', 'Reimposta la verifica claude.ai…'), icon: 'shield' },
    { type: 'sep' },
    { type: 'item', action: 'whats-new', label: t('Was ist neu?…', 'What’s New…', 'Nouveautés…', 'Novità…'), icon: 'bolt' },
    { type: 'item', action: 'about', label: t('Über Claude Desktop…', 'About Claude Desktop…', 'À propos de Claude Desktop…', 'Informazioni su Claude Desktop…'), icon: 'info' },
    { type: 'sep' },
    { type: 'item', action: 'quit', label: t('Beenden', 'Quit', 'Quitter', 'Esci'), accel: 'Ctrl+Q', icon: 'power' }
  ];
}

function getAppMenuHTML() {
  const th = subTheme();
  const ac = accent();
  const dark = isDarkMode;
  const items = getAppMenuItems();
  const ICONS = {
    plus:    '<path d="M12 5v14M5 12h14"/>',
    x:       '<path d="M18 6L6 18M6 6l12 12"/>',
    download:'<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    refresh: '<path d="M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16M3 21v-5h5"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/><circle cx="14.5" cy="15.5" r="1"/>',
    cog:     '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3h0a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8v0a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/>',
    bug:     '<path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>',
    info:    '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/>',
    bolt:    '<polyline points="13 2 4 14 12 14 11 22 20 10 12 10 13 2"/>',
    shield:  '<path d="M12 2L4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z"/><path d="M9 12l2 2 4-4"/>',
    power:   '<path d="M18.36 6.64a9 9 0 11-12.73 0M12 2v10"/>'
  };

  const renderItem = (it, idx) => {
    if (it.type === 'sep') return '<div class="sep"></div>';
    const icon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[it.icon] || ''}</svg>`;
    const accel = it.accel ? `<span class="accel">${it.accel}</span>` : '';
    return `<button class="item" data-action="${it.action}" data-idx="${idx}"><span class="icon">${icon}</span><span class="label">${it.label}</span>${accel}</button>`;
  };

  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:transparent;color:${th.textActive};
  font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',system-ui,sans-serif;font-size:13px;
  overflow:hidden;user-select:none}
body{padding:8px}
.card{background:${th.bg};border:1px solid ${th.border};border-radius:10px;
  box-shadow:0 6px 24px ${dark ? 'rgba(0,0,0,.45)' : 'rgba(0,0,0,.18)'},
    0 1px 3px ${dark ? 'rgba(0,0,0,.4)' : 'rgba(0,0,0,.08)'};
  padding:5px;overflow:hidden}
.head{display:flex;align-items:center;gap:11px;padding:8px 11px 9px;margin:-1px -1px 4px;
  border-bottom:1px solid ${th.border}}
.head .meta{display:flex;flex-direction:column;line-height:1.2;flex:1;min-width:0}
.head .name{font-weight:700;font-size:14px;color:${th.textActive};letter-spacing:.2px}
.head .ver{font-size:11px;color:${th.text};font-family:ui-monospace,Menlo,Consolas,monospace}
.item{display:flex;align-items:center;gap:11px;width:100%;height:30px;padding:0 9px;
  border:none;background:transparent;color:${th.textActive};
  border-radius:6px;cursor:pointer;font:inherit;font-size:13px;
  transition:background .08s ease,color .08s ease}
.item:hover,.item.focused{background:${th.bgHover}}
.item.focused{outline:none}
.item:active{background:${th.bgActive}}
.icon{display:flex;align-items:center;justify-content:center;width:16px;height:16px;color:${th.text};flex-shrink:0}
.icon svg{width:16px;height:16px}
.item:hover .icon,.item.focused .icon{color:${ac.from}}
.label{flex:1;text-align:left;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.accel{color:${th.text};font-size:11.5px;font-weight:500;letter-spacing:.2px;flex-shrink:0;
  font-family:ui-monospace,Menlo,Consolas,monospace}
.item:hover .accel,.item.focused .accel{color:${th.textActive}}
.sep{height:1px;background:${th.border};margin:5px 4px}
</style></head><body>
<div class="card" id="card">
  <div class="head">
    <div class="meta">
      <div class="name">Claude</div>
      <div class="ver">v${version}</div>
    </div>
  </div>
  ${items.map(renderItem).join('')}
</div>
<script>
const api = window.appMenuAPI;
const card = document.getElementById('card');
const buttons = Array.from(card.querySelectorAll('.item'));
let focusIdx = -1;

function focusItem(i) {
  buttons.forEach(b => b.classList.remove('focused'));
  if (i >= 0 && i < buttons.length) {
    buttons[i].classList.add('focused');
    focusIdx = i;
  }
}

card.addEventListener('click', (e) => {
  const btn = e.target.closest('.item');
  if (!btn) return;
  api.action(btn.dataset.action);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); api.close(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusItem((focusIdx + 1) % buttons.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusItem((focusIdx - 1 + buttons.length) % buttons.length);
  } else if (e.key === 'Enter' && focusIdx >= 0) {
    e.preventDefault();
    api.action(buttons[focusIdx].dataset.action);
  }
});

window.addEventListener('blur', () => api.close());

// Größe an Inhalt anpassen und an Main melden — Window resized auf Card-Höhe
const observer = new ResizeObserver(() => {
  const r = card.getBoundingClientRect();
  document.body.dataset.height = String(Math.ceil(r.height + 16));
});
observer.observe(card);
</script>
</body></html>`;
}

function openAppMenuWindow(rendererX, rendererY) {
  if (appMenuWindow && !appMenuWindow.isDestroyed()) {
    // Cooldown SOFORT setzen, nicht erst im closed-Event. Das closed-Event
    // feuert async; ohne sofortiges Setzen rast ein zweiter Hamburger-Klick
    // durch den 250ms-IPC-Filter und spawned ein zweites Fenster.
    appMenuJustClosedAt = Date.now();
    appMenuWindow.close();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;

  const items = getAppMenuItems();
  // Höhe: Header ~52px + Items 30px + Separators 11px + 18px card-padding/border + 16px body-padding
  const itemH = 30, sepH = 11, headerH = 52;
  let height = 18 + 16 + headerH;
  for (const it of items) height += (it.type === 'sep' ? sepH : itemH);
  const width = 280;

  const cb = mainWindow.getContentBounds();
  const screenX = cb.x + (Number.isFinite(rendererX) ? Math.round(rendererX) : 0);
  const screenY = cb.y + (Number.isFinite(rendererY) ? Math.round(rendererY) : TAB_BAR_HEIGHT);

  // Wayland-Compositor ignoriert x/y -> auf parent+center:true ausweichen,
  // mutter zentriert dann auf das Hauptfenster. Auf X11 weiter Pixel-genau.
  const baseOpts = {
    width, height,
    x: screenX, y: screenY,
    frame: false, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    transparent: true, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload-appmenu.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      spellcheck: false
    }
  };
  appMenuWindow = new BrowserWindow(baseOpts);
  appMenuWindow.setMenu(null);
  appMenuWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getAppMenuHTML()));
  appMenuWindow.once('ready-to-show', () => {
    if (!appMenuWindow || appMenuWindow.isDestroyed()) return;
    appMenuWindow.show();
    appMenuWindow.focus();
  });
  appMenuWindow.on('blur', () => {
    if (appMenuWindow && !appMenuWindow.isDestroyed()) {
      appMenuJustClosedAt = Date.now();
      appMenuWindow.close();
    }
  });
  appMenuWindow.on('closed', () => {
    appMenuJustClosedAt = Date.now();
    appMenuWindow = null;
  });
}

// Custom MessageBox – zentriert über der App statt GTK-nativ

let _msgboxCounter = 0;

function showCustomMessageBox(opts) {
  const id = ++_msgboxCounter;
  const channel = `msgbox-respond-${id}`;
  const type = opts.type || 'info';
  const title = opts.title || 'Claude';
  const message = opts.message || '';
  const detail = opts.detail || '';
  const buttons = (Array.isArray(opts.buttons) && opts.buttons.length) ? opts.buttons : ['OK'];
  const defaultId = typeof opts.defaultId === 'number' ? opts.defaultId : 0;
  const cancelId = typeof opts.cancelId === 'number' ? opts.cancelId : (buttons.length - 1);

  return new Promise((resolve) => {
    let settled = false;
    let ipcHandler;
    const finish = (index) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(channel, ipcHandler);
      resolve({ response: typeof index === 'number' ? index : cancelId });
    };

    const win = createDialogWindow({
      width: 480,
      height: detail ? 260 : 200,
      title
    });

    ipcHandler = (_, index) => {
      finish(index);
      if (!win.isDestroyed()) win.close();
    };
    ipcMain.once(channel, ipcHandler);

    win.on('closed', () => finish(cancelId));

    const html = getMessageBoxHTML({ type, title, message, detail, buttons, defaultId, cancelId, channel });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

function getMessageBoxHTML({ type, title, message, detail, buttons, defaultId, cancelId, channel }) {
  const th = subTheme();
  const ac = accent();
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const iconColor = type === 'error' ? '#e05e3e' : (type === 'warning' ? '#e0a93e' : ac.from);
  const iconSvg = {
    info:    '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    warning: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    error:   '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
  }[type] || '';
  const buttonsHtml = buttons.map((label, i) => {
    const primary = i === defaultId;
    return `<button class="btn${primary ? ' primary' : ''}" data-idx="${i}">${esc(label)}</button>`;
  }).join('');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  ${sharedDialogCSS()}
  .container { display: flex; flex-direction: column; height: 100%; padding: 22px; }
  .top { display: flex; gap: 16px; flex: 1; align-items: flex-start; min-height: 0; }
  .icon { color: ${iconColor}; flex: 0 0 auto; line-height: 0; }
  .content { flex: 1; min-width: 0; }
  .msg { font-weight: 500; margin: 0 0 8px; line-height: 1.4; word-wrap: break-word; }
  .detail { color: ${th.text}; font-size: 13px; line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; max-height: 120px; overflow-y: auto; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; flex: 0 0 auto; }
</style>
</head>
<body>
<div class="container">
  <div class="top">
    <div class="icon">${iconSvg}</div>
    <div class="content">
      <div class="msg">${esc(message)}</div>
      ${detail ? `<div class="detail">${esc(detail)}</div>` : ''}
    </div>
  </div>
  <div class="buttons">${buttonsHtml}</div>
</div>
<script>
(function(){
  const channel = ${JSON.stringify(channel)};
  const defaultIdx = ${defaultId};
  const cancelIdx = ${cancelId};
  const respond = (i) => { try { window.msgboxAPI.respond(channel, i); } catch (e) {} };
  document.querySelectorAll('.btn').forEach(b => {
    b.addEventListener('click', () => respond(parseInt(b.dataset.idx, 10)));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); respond(cancelIdx); }
    else if (e.key === 'Enter') { e.preventDefault(); respond(defaultIdx); }
  });
  setTimeout(() => {
    const primary = document.querySelector('.btn.primary') || document.querySelector('.btn');
    if (primary) primary.focus();
  }, 50);
})();
</script>
</body>
</html>`;
}

// Menü

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
        { label: t('Neuer Tab', 'New Tab', 'Nouvel onglet', 'Nuova scheda'), accelerator: 'CmdOrCtrl+T', click: () => createTab() },
        { label: t('Tab schlie\u00dfen', 'Close Tab', 'Fermer l’onglet', 'Chiudi scheda'), accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabIndex) },
        { type: 'separator' }, ...tabItems, { type: 'separator' },
        { label: t('Konversation als Markdown exportieren\u2026', 'Export conversation as Markdown\u2026', 'Exporter la conversation en Markdown…', 'Esporta la conversazione in Markdown…'), accelerator: 'CmdOrCtrl+Shift+E', click: () => exportActiveConversation() },
        { type: 'separator' },
        { label: t('Einstellungen', 'Settings', 'Paramètres', 'Impostazioni'), accelerator: 'CmdOrCtrl+,', click: () => {
          if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view))
            tabs[activeTabIndex].view.webContents.loadURL('https://claude.ai/settings');
        }},
        { label: t('App-Einstellungen\u2026', 'App Settings\u2026', 'Paramètres de l’application…', 'Impostazioni dell’app…'), click: () => openSettingsWindow() },
        { type: 'separator' },
        { label: `Design: ${customDesign ? 'Modern' : 'Classic'}`, click: toggleDesign },
        { label: t('Nach Updates suchen\u2026', 'Check for Updates\u2026', 'Rechercher des mises à jour…', 'Controlla aggiornamenti…'), click: () => triggerManualUpdateCheck() },
        { label: (bugReportStrings[sysLang] || bugReportStrings.en).title, click: showBugReportDialog },
        { type: 'separator' },
        { role: 'quit', label: t('Beenden', 'Quit', 'Quitter', 'Esci') }
      ]},
      { label: t('Bearbeiten', 'Edit', 'Édition', 'Modifica'), submenu: [
        { role: 'undo', label: t('R\u00fcckg\u00e4ngig', 'Undo', 'Annuler', 'Annulla') },
        { role: 'redo', label: t('Wiederholen', 'Redo', 'Rétablir', 'Ripeti') },
        { type: 'separator' },
        { role: 'cut', label: t('Ausschneiden', 'Cut', 'Couper', 'Taglia') },
        { role: 'copy', label: t('Kopieren', 'Copy', 'Copier', 'Copia') },
        { role: 'paste', label: t('Einf\u00fcgen', 'Paste', 'Coller', 'Incolla') },
        { role: 'selectAll', label: t('Alles ausw\u00e4hlen', 'Select All', 'Tout sélectionner', 'Seleziona tutto') }
      ]},
      { label: t('Ansicht', 'View', 'Affichage', 'Visualizza'), submenu: [
        { label: t('Neu laden', 'Reload', 'Recharger', 'Ricarica'), accelerator: 'CmdOrCtrl+R', click: () => { if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view)) tabs[activeTabIndex].view.webContents.reload(); } },
        { label: t('Erzwungen neu laden', 'Force Reload', 'Recharger de force', 'Ricarica forzata'), accelerator: 'CmdOrCtrl+Shift+R', click: () => { if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view)) tabs[activeTabIndex].view.webContents.reloadIgnoringCache(); } },
        { label: t('Neu zeichnen', 'Redraw', 'Redessiner', 'Ridisegna'), accelerator: 'CmdOrCtrl+Alt+R', click: () => repaintActiveView() },
        { type: 'separator' },
        { role: 'resetZoom', label: t('Zoom zur\u00fccksetzen', 'Reset Zoom', 'Réinitialiser le zoom', 'Reimposta zoom') },
        { role: 'zoomIn', label: t('Vergr\u00f6\u00dfern', 'Zoom In', 'Zoom avant', 'Aumenta zoom') },
        { role: 'zoomOut', label: t('Verkleinern', 'Zoom Out', 'Zoom arrière', 'Riduci zoom') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('Vollbild', 'Fullscreen', 'Plein écran', 'Schermo intero') },
        ...(isDev ? [{ type: 'separator' }, { label: 'DevTools', accelerator: 'F12', click: () => { if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view)) tabs[activeTabIndex].view.webContents.toggleDevTools(); } }] : [])
      ]},
      { label: 'Tabs', submenu: [
        { label: t('Neuer Tab', 'New Tab', 'Nouvel onglet', 'Nuova scheda'), accelerator: 'CmdOrCtrl+T', click: () => createTab() },
        { label: t('Tab schlie\u00dfen', 'Close Tab', 'Fermer l’onglet', 'Chiudi scheda'), accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabIndex) },
        { type: 'separator' },
        { label: t('N\u00e4chster Tab', 'Next Tab', 'Onglet suivant', 'Scheda successiva'), accelerator: 'CmdOrCtrl+Tab', click: () => switchToTab((activeTabIndex + 1) % tabs.length) },
        { label: t('Vorheriger Tab', 'Previous Tab', 'Onglet précédent', 'Scheda precedente'), accelerator: 'CmdOrCtrl+Shift+Tab', click: () => switchToTab((activeTabIndex - 1 + tabs.length) % tabs.length) },
        { type: 'separator' }, ...tabItems
      ]},
      { label: t('Fenster', 'Window', 'Fenêtre', 'Finestra'), submenu: [
        { role: 'minimize', label: t('Minimieren', 'Minimize', 'Réduire', 'Riduci a icona') },
        { role: 'close', label: t('Schlie\u00dfen', 'Close', 'Fermer', 'Chiudi') }
      ]}
    ]));
  });
}

// Offline-Handling

function handleOnlineChange(online) {
  if (online === isOnline) return;
  isOnline = online;
  updateTitle();
  if (!online) {
    showOfflinePage();
    notify({ title: 'Claude', body: t('Keine Internetverbindung.', 'No internet connection.', 'Pas de connexion Internet.', 'Nessuna connessione a Internet.') });
  } else {
    // Jeder Tab, der auf der Offline-Seite haengt, muss per loadURL zurueck auf seinen
    // echten Chat. reload() wuerde nur die data:-Seite neu laden. Inaktive Tabs bleiben
    // sonst dauerhaft dort haengen, weil showOfflinePage nur den aktiven Tab trifft.
    const active = tabs[activeTabIndex];
    for (const tab of tabs) {
      if (!alive(tab.view)) continue;
      if (tab.view.webContents.getURL().startsWith('data:'))
        tab.view.webContents.loadURL(tab.url || 'https://claude.ai');
      else if (tab === active) tab.view.webContents.reload();
    }
    notify({ title: 'Claude', body: t('Verbindung wiederhergestellt!', 'Connection restored!', 'Connexion rétablie !', 'Connessione ripristinata!') });
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
    <h1>${t('Keine Verbindung', 'No Connection', 'Pas de connexion', 'Nessuna connessione')}</h1>
    <p>${t('Prüfe deine Netzwerkverbindung.', 'Check your network connection.', 'Vérifiez votre connexion réseau.', 'Controlla la connessione di rete.')}</p>
    <p class="pulse" style="font-size:12px">${t('Automatische Wiederverbindung\u2026', 'Reconnecting automatically\u2026', 'Reconnexion automatique…', 'Riconnessione automatica…')}</p>
    <button onclick="if(window.claudeDesktop&amp;&amp;claudeDesktop.offlineRetry)claudeDesktop.offlineRetry();else location.href='https://claude.ai'">${t('Erneut versuchen', 'Try Again', 'Réessayer', 'Riprova')}</button>
    </body></html>`
  ));
}

// Download-Manager

function setupDownloadManager() {
  // Echo-Schutz: claude.ai feuert manche Download-Links 2x. event.preventDefault()
  // im will-download-Handler stoppt das Duplikat sauber, OHNE dass Chromiums
  // Auto-Save-Dialog erscheint (item.cancel() würde den trotzdem öffnen).
  const activeKeys = new Set();
  const cooldownUntil = new Map();
  const COOLDOWN_MS = 3000;

  function dropKey(key) {
    activeKeys.delete(key);
    cooldownUntil.set(key, Date.now() + COOLDOWN_MS);
    setTimeout(() => {
      const u = cooldownUntil.get(key);
      if (u && Date.now() >= u) cooldownUntil.delete(key);
    }, COOLDOWN_MS + 500);
  }

  session.fromPartition('persist:claude').on('will-download', (event, item) => {
    const fileName = item.getFilename();
    const url = item.getURL();
    const keys = [url, fileName].filter(Boolean);
    const now = Date.now();

    // Echo-Filter: Duplikat → Temp-Pfad + cancel (Auto-Dialog wird unterdrückt)
    for (const k of keys) {
      const u = cooldownUntil.get(k);
      if (u && now < u) {
        try { item.setSavePath(path.join(app.getPath('temp'), '.cd-discard-' + now)); } catch {}
        try { item.cancel(); } catch {}
        return;
      }
      if (activeKeys.has(k)) {
        try { item.setSavePath(path.join(app.getPath('temp'), '.cd-discard-' + now)); } catch {}
        try { item.cancel(); } catch {}
        return;
      }
    }

    keys.forEach(k => activeKeys.add(k));

    // SYNCHRON: Temp-Pfad setzen — sonst öffnet Chromium parallel seinen eigenen Save-Dialog!
    const safeName = fileName.replace(/[^\w.-]+/g, '_');
    const tmpPath = path.join(app.getPath('temp'), '.cd-pending-' + now + '-' + safeName);
    try { item.setSavePath(tmpPath); } catch {}

    let chosenPath = null;
    let dialogDone = false;
    let downloadDone = false;
    let downloadState = '';
    let cancelledByDialog = false;
    let released = false;

    const finalize = () => {
      if (!dialogDone || !downloadDone) return;
      if (released) return;
      released = true;
      if (downloadState === 'completed' && chosenPath) {
        let ok = false;
        try { fs.renameSync(tmpPath, chosenPath); ok = true; }
        catch (_) {
          try { fs.copyFileSync(tmpPath, chosenPath); fs.unlinkSync(tmpPath); ok = true; }
          catch (e2) { console.error(`[DL] move failed: ${e2.message}`); try { fs.unlinkSync(tmpPath); } catch {} }
        }
        notify({
          title: ok ? t('Download fertig', 'Download complete', 'Téléchargement terminé', 'Download completato') : t('Download fehlgeschlagen', 'Download failed', 'Échec du téléchargement', 'Download non riuscito'),
          body: fileName
        });
      } else {
        try { fs.unlinkSync(tmpPath); } catch {}
        if (!cancelledByDialog && downloadState !== 'cancelled' && downloadState !== '') {
          notify({ title: t('Download fehlgeschlagen', 'Download failed', 'Échec du téléchargement', 'Download non riuscito'), body: fileName });
        }
      }
      keys.forEach(dropKey);
    };

    dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: [{ name: t('Alle Dateien', 'All Files', 'Tous les fichiers', 'Tutti i file'), extensions: ['*'] }]
    }).then(result => {
      dialogDone = true;
      if (result.canceled || !result.filePath) {
        cancelledByDialog = true;
        try { item.cancel(); } catch {}
      } else {
        chosenPath = result.filePath;
      }
      finalize();
    }).catch(() => {
      dialogDone = true;
      cancelledByDialog = true;
      try { item.cancel(); } catch {}
      finalize();
    });

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
      downloadDone = true;
      downloadState = state;
      finalize();
    });
  });
}

// Auto-Updater

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
let manualUpdateCheck = false;

// Manuelle "Nach Updates suchen"-Aktion. Im Snap laeuft der electron-updater nicht
// (setupAutoUpdater bricht ab, kein Handler registriert), darum hier eigene Rueckmeldung
// statt eines stummen checkForUpdates() ohne sichtbares Ergebnis.
function triggerManualUpdateCheck() {
  if (isDev) {
    showCustomMessageBox({ type: 'info', title: 'Claude', message: t('Updates sind im Entwicklungsmodus deaktiviert.', 'Updates are disabled in development mode.', 'Les mises à jour sont désactivées en mode développement.', 'Gli aggiornamenti sono disattivati in modalità sviluppo.') });
    return;
  }
  if (isSnap) {
    showCustomMessageBox({ type: 'info', title: 'Claude', message: t('Updates werden über den Snap Store verwaltet und automatisch installiert.', 'Updates are managed by the Snap Store and installed automatically.', 'Les mises à jour sont gérées par le Snap Store et installées automatiquement.', 'Gli aggiornamenti sono gestiti dallo Snap Store e installati automaticamente.') });
    return;
  }
  manualUpdateCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}

function setupAutoUpdater() {
  if (isDev) return;
  if (isSnap) return; // Snap aktualisiert sich ueber den Store; der AppImage-Updater laeuft hier ins Leere
  let failures = 0;

  const dialogParent = () => (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;

  autoUpdater.on('update-available', (info) => {
    failures = 0;
    if (isQuitting) return;
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      showCustomMessageBox({ type: 'info', title: t('Update verf\u00fcgbar', 'Update available', 'Mise à jour disponible', 'Aggiornamento disponibile'), message: `v${info.version} ${t('wird heruntergeladen\u2026', 'is downloading\u2026', 'en cours de téléchargement…', 'in download…')}` });
    } else {
      new Notification({ title: t('Update verf\u00fcgbar', 'Update available', 'Mise à jour disponible', 'Aggiornamento disponibile'), body: `v${info.version} ${t('wird geladen\u2026', 'downloading\u2026', 'téléchargement…', 'download…')}` }).show();
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    failures = 0;
    if (isQuitting) return;
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      showCustomMessageBox({ type: 'info', title: t('Kein Update', 'No Update', 'Aucune mise à jour', 'Nessun aggiornamento'), message: t('Du verwendest bereits die neueste Version.', 'You are already on the latest version.', 'Vous utilisez déjà la dernière version.', 'Stai già usando l’ultima versione.'), detail: `v${app.getVersion()}` });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    if (isQuitting) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(`Claude \u2013 Update ${Math.round(p.percent)}%`);
      mainWindow.setProgressBar(p.percent / 100);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (isQuitting) return;
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.setTitle('Claude'); mainWindow.setProgressBar(-1); }
    showCustomMessageBox({
      type: 'info', title: t('Update bereit', 'Update ready', 'Mise à jour prête', 'Aggiornamento pronto'),
      message: `v${info.version} ${t('heruntergeladen. Jetzt neu starten?', 'downloaded. Restart now?', 'téléchargée. Redémarrer maintenant ?', 'scaricato. Riavviare ora?')}`,
      buttons: [t('Neu starten', 'Restart', 'Redémarrer', 'Riavvia'), t('Sp\u00e4ter', 'Later', 'Plus tard', 'Più tardi')], defaultId: 0, cancelId: 1
    }).then(r => { if (!isQuitting && r.response === 0) autoUpdater.quitAndInstall(); });
  });

  autoUpdater.on('error', (err) => {
    failures++;
    if (isDev) console.error(`Update-Fehler (${failures}x):`, err.message);
    if (isQuitting) return;
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      const short = (err.message || '').split('\n')[0].slice(0, 200);
      showCustomMessageBox({ type: 'error', title: t('Update-Fehler', 'Update Error', 'Erreur de mise à jour', 'Errore di aggiornamento'), message: t('Update-Pr\u00fcfung fehlgeschlagen.', 'Update check failed.', 'Échec de la vérification des mises à jour.', 'Controllo aggiornamenti non riuscito.'), detail: short });
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

// Session Security

// Snap-Befehl, den der User im Terminal ausführen kann, falls keine GUI greift.
const SNAP_CONNECT_CMD = 'sudo snap connect claude-ai-desktop:audio-record';

// Versucht in Reihenfolge: snap-store → gnome-software → plasma-discover → xdg-open.
// Umgeht den xdg-open-Chooser-Dialog auf Systemen mit mehreren snap://-Handlern.
function openSnapStorePage() {
  if (!isSnap) {
    openExternalSafe('snap://claude-ai-desktop');
    return;
  }
  const { execFile, spawn } = require('child_process');
  const candidates = [
    { bin: 'snap-store',      args: ['snap://claude-ai-desktop'] },
    { bin: 'gnome-software',  args: ['--details=claude-ai-desktop'] },
    { bin: 'plasma-discover', args: ['snap://claude-ai-desktop'] }
  ];
  const tryNext = (i) => {
    if (i >= candidates.length) {
      openExternalSafe('snap://claude-ai-desktop');
      return;
    }
    const c = candidates[i];
    execFile('which', [c.bin], { timeout: 1500 }, (err) => {
      if (err) return tryNext(i + 1);
      try {
        const child = spawn(c.bin, c.args, { detached: true, stdio: 'ignore' });
        child.on('error', () => tryNext(i + 1));
        child.unref();
      } catch { tryNext(i + 1); }
    });
  };
  tryNext(0);
}

// Liefert 'connected' | 'disconnected' | 'unknown' asynchron via callback.
// snapctl liegt fix unter /usr/bin/snapctl im Snap-Confinement; Exit-Code 0 = connected.
// Asynchron damit das 1.5s-Polling den Main-Thread nicht blockiert.
function checkSnapAudioRecordStatus(cb) {
  if (!isSnap) return cb('connected');
  const { execFile } = require('child_process');
  execFile('snapctl', ['is-connected', 'audio-record'], { timeout: 1500 }, (err) => {
    if (!err) return cb('connected');
    if (err && typeof err.code === 'number') return cb('disconnected');
    cb('unknown');
  });
}

// Defensives JSON-Embedding für Inline-<script>-Blöcke: </script>-Sequenzen
// in JSON-Strings escapen, damit der HTML-Parser sie nicht als Tag-Ende erkennt.
// Gemeinsames CSS für Dialog-Fenster (showCustomMessageBox + requestMicrophoneConsent).
function sharedDialogCSS() {
  const th = subTheme();
  const ac = accent();
  return `
    *{box-sizing:border-box}
    html,body{height:100%;margin:0;padding:0}
    body{background:${th.bg};color:${th.textActive};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;user-select:none;-webkit-user-select:none}
    .btn{background:${th.bgHover};color:${th.textActive};border:1px solid ${th.border};border-radius:6px;padding:7px 16px;font-size:13px;cursor:pointer;font-family:inherit;min-width:80px}
    .btn:hover:not(:disabled){background:${th.bgActive}}
    .btn.primary{background:linear-gradient(135deg,${ac.from},${ac.to});color:#fff;border-color:transparent;font-weight:500}
    .btn.primary:hover:not(:disabled){filter:brightness(1.08)}
    .btn:focus{outline:2px solid ${ac.from};outline-offset:2px}
    .btn:disabled{opacity:.5;cursor:not-allowed}
  `;
}

// Hol-oder-starte den Consent-Dialog. Mehrere parallele Aufrufer (Settings-Toggle
// + claude.ai-Mic-Click) bekommen denselben Promise; nur EIN Modal-Fenster oeffnet sich.
function getOrStartMicConsent() {
  if (consentInflight) return consentInflight;
  consentInflight = requestMicrophoneConsent()
    .finally(() => { consentInflight = null; });
  return consentInflight;
}

// Liefert 'granted' | 'denied' | 'dismissed'.
// 'dismissed' = User schloss Fenster ohne Klick → consentAsked NICHT setzen
// (d.h. nächste Mikrofon-Anfrage zeigt den Dialog wieder).
async function requestMicrophoneConsent() {
  const id = ++_msgboxCounter;
  const respondChannel = `msgbox-respond-${id}`;
  const snapOpenChannel = `mic-consent-open-snap-${id}`;
  const statusChannel = `mic-consent-status-${id}`;
  const snapNeeded = isSnap;
  const showSnapPanel = snapNeeded;
  const initialStatus = snapNeeded ? 'unknown' : 'connected';

  const copyCmdChannel = `mic-consent-copy-cmd-${id}`;

  return new Promise((resolve) => {
    let settled = false;
    let pollHandle = null;
    let respondHandler, snapOpenHandler, copyCmdHandler;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      ipcMain.removeListener(respondChannel, respondHandler);
      ipcMain.removeListener(snapOpenChannel, snapOpenHandler);
      ipcMain.removeListener(copyCmdChannel, copyCmdHandler);
      resolve(reason);
    };

    const win = createDialogWindow({
      width: 520,
      height: showSnapPanel ? 480 : 240,
      title: t('Mikrofon-Zugriff', 'Microphone access', 'Accès au microphone', 'Accesso al microfono')
    });

    respondHandler = (_, idx) => {
      finish(idx === 0 ? 'granted' : 'denied');
      if (!win.isDestroyed()) win.close();
    };
    snapOpenHandler = () => openSnapStorePage();
    copyCmdHandler = () => { try { clipboard.writeText(SNAP_CONNECT_CMD); } catch {} };
    ipcMain.once(respondChannel, respondHandler);
    ipcMain.on(snapOpenChannel, snapOpenHandler);
    ipcMain.on(copyCmdChannel, copyCmdHandler);

    win.on('closed', () => finish('dismissed'));

    const sendStatus = (s) => {
      if (win.isDestroyed()) return;
      try { win.webContents.send(statusChannel, s); } catch {}
    };

    if (showSnapPanel) {
      // Sofort einmal asynchron prüfen, dann alle 1.5s pollen.
      checkSnapAudioRecordStatus(sendStatus);
      pollHandle = setInterval(() => {
        if (win.isDestroyed()) return;
        checkSnapAudioRecordStatus(sendStatus);
      }, 1500);
    }

    const html = getMicConsentHTML({
      respondChannel, snapOpenChannel, statusChannel, copyCmdChannel,
      showSnapPanel, initialStatus
    });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

function getMicConsentHTML({ respondChannel, snapOpenChannel, statusChannel, copyCmdChannel, showSnapPanel, initialStatus }) {
  const th = subTheme();
  const ac = accent();
  const i18n = {
    title: t('Mikrofon-Zugriff', 'Microphone access', 'Accès au microphone', 'Accesso al microfono'),
    message: t(
      'Claude Desktop möchte auf dein Mikrofon zugreifen, um Spracheingaben zu ermöglichen.',
      'Claude Desktop wants to access your microphone to enable voice input.',
      'Claude Desktop souhaite accéder à votre microphone pour permettre la saisie vocale.',
      'Claude Desktop vuole accedere al microfono per consentire l\'input vocale.'
    ),
    hint: t(
      'Du kannst diese Erlaubnis jederzeit in den App-Einstellungen unter „Mikrofon" widerrufen.',
      'You can revoke this permission anytime in the app settings under “Microphone”.',
      'Vous pouvez révoquer cette autorisation à tout moment dans les paramètres de l\'application, sous « Microphone ».',
      'È possibile revocare questa autorizzazione in qualsiasi momento nelle impostazioni dell\'app, alla voce "Microfono".'
    ),
    snapTitle: t('Snap-Berechtigung', 'Snap permission', 'Autorisation Snap', 'Autorizzazione Snap'),
    snapConnected: t('Verbunden', 'Connected', 'Connecté', 'Connesso'),
    snapDisconnected: t('Nicht verbunden', 'Not connected', 'Non connecté', 'Non connesso'),
    snapUnknown: t('Status wird geprüft…', 'Checking status…', 'Vérification du statut…', 'Verifica dello stato…'),
    snapButton: t('Im Snap-Store öffnen', 'Open in Snap Store', 'Ouvrir dans le Snap Store', 'Apri nello Snap Store'),
    snapButtonHint: t(
      'Öffnet die Snap-Detailseite. Dort auf „Permissions" → „Audio Record" aktivieren – dieser Dialog erkennt es automatisch.',
      'Opens the Snap detail page. Go to “Permissions” → enable “Audio Record” – this dialog detects it automatically.',
      'Ouvre la page de détails du Snap. Activez-y « Permissions » → « Audio Record », cette fenêtre le détecte automatiquement.',
      'Apre la pagina dei dettagli dello Snap. Attiva "Permissions" → "Audio Record", questa finestra lo rileva automaticamente.'
    ),
    snapOrCmd: t('Oder im Terminal ausführen:', 'Or run in a terminal:', 'Ou exécuter dans un terminal :', 'Oppure esegui in un terminale:'),
    snapCmdCopy: t('Befehl kopieren', 'Copy command', 'Copier la commande', 'Copia comando'),
    snapCmdCopied: t('Kopiert ✓', 'Copied ✓', 'Copié ✓', 'Copiato ✓'),
    snapNeedConnect: t('Aktiviere zuerst die Snap-Berechtigung, um „Erlauben" auszuwählen.', 'Enable the Snap permission first to choose “Allow”.', 'Activez d’abord l’autorisation Snap pour choisir « Autoriser ».', 'Attiva prima l’autorizzazione Snap per scegliere "Consenti".'),
    allow: t('Erlauben', 'Allow', 'Autoriser', 'Consenti'),
    deny: t('Ablehnen', 'Deny', 'Refuser', 'Rifiuta')
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const snapPanel = showSnapPanel ? `
    <div class="snap" id="snap-panel" data-status="${esc(initialStatus)}">
      <div class="snap-head">
        <span class="dot"></span>
        <span class="snap-title">${i18n.snapTitle}</span>
        <span class="snap-status" id="snap-status-text"></span>
      </div>
      <div class="snap-body">
        <button class="btn-snap" id="open-snap">${i18n.snapButton}</button>
        <div class="snap-hint">${i18n.snapButtonHint}</div>
        <div class="snap-or">${i18n.snapOrCmd}</div>
        <div class="snap-cmd-row">
          <code class="snap-cmd" id="snap-cmd">${esc(SNAP_CONNECT_CMD)}</code>
          <button class="btn-snap snap-cmd-copy" id="snap-cmd-copy">${i18n.snapCmdCopy}</button>
        </div>
      </div>
    </div>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(i18n.title)}</title>
<style>
${sharedDialogCSS()}
body{font-size:13.5px;display:flex;flex-direction:column}
.container{padding:22px;flex:1;display:flex;flex-direction:column;gap:14px;overflow:hidden}
.head{display:flex;gap:14px;align-items:flex-start}
.icon{color:${ac.from};flex:0 0 auto;line-height:0}
.text .msg{font-weight:500;margin:0 0 6px;line-height:1.4}
.text .hint{color:${th.text};font-size:12.5px;line-height:1.5}
.snap{background:${th.bgHover};border:1px solid ${th.border};border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.snap-head{display:flex;align-items:center;gap:8px}
.snap-body{display:flex;flex-direction:column;gap:7px}
.snap[data-status="connected"] .snap-body{display:none}
.dot{width:9px;height:9px;border-radius:50%;background:${th.text};flex:0 0 auto;transition:background .2s}
.snap[data-status="connected"] .dot{background:#3fb96e}
.snap[data-status="disconnected"] .dot{background:#e05e3e}
.snap[data-status="unknown"] .dot{background:#e0a93e}
.snap-title{font-weight:600;font-size:12.5px}
.snap-status{color:${th.text};font-size:12px;flex:1}
.btn-snap{background:${th.bg};color:${th.textActive};border:1px solid ${th.border};border-radius:6px;padding:7px 12px;font-size:12.5px;font-family:inherit;cursor:pointer;font-weight:500;align-self:flex-start}
.btn-snap:hover{background:${th.bgActive}}
.snap-hint{color:${th.text};font-size:11.5px;line-height:1.4}
.snap-or{color:${th.text};font-size:11.5px;margin-top:2px;font-weight:500}
.snap-cmd-row{display:flex;gap:6px;align-items:center}
.snap-cmd{flex:1;background:${th.bg};border:1px solid ${th.border};border-radius:6px;padding:6px 9px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:${th.textActive};user-select:text;-webkit-user-select:text;overflow-x:auto;white-space:nowrap}
.snap-cmd-copy{padding:6px 10px;font-size:11.5px;flex:0 0 auto}
.allow-blocker{color:#e0a93e;font-size:11.5px;line-height:1.4;margin-top:2px;display:none}
.snap[data-status="disconnected"] ~ .allow-blocker{display:block}
.snap[data-status="unknown"] ~ .allow-blocker{display:block}
.buttons{padding:14px 22px;border-top:1px solid ${th.border};display:flex;gap:8px;justify-content:flex-end}
.btn{min-width:90px}
.btn.pulse{animation:btnpulse 1.6s ease-in-out 3;outline:0}
@keyframes btnpulse{0%{box-shadow:0 0 0 0 rgba(232,82,79,.55)}50%{box-shadow:0 0 0 10px rgba(232,82,79,0)}100%{box-shadow:0 0 0 0 rgba(232,82,79,0)}}
</style></head><body>
<div class="container">
  <div class="head">
    <div class="icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
    </div>
    <div class="text">
      <div class="msg">${i18n.message}</div>
      <div class="hint">${i18n.hint}</div>
    </div>
  </div>
  ${snapPanel}
  ${showSnapPanel ? `<div class="allow-blocker" id="allow-blocker">${i18n.snapNeedConnect}</div>` : ''}
</div>
<div class="buttons">
  <button class="btn" id="deny">${i18n.deny}</button>
  <button class="btn primary" id="allow">${i18n.allow}</button>
</div>
<script>
(function(){
  const respondChannel = ${safeJson(respondChannel)};
  const snapOpenChannel = ${safeJson(snapOpenChannel)};
  const statusChannel = ${safeJson(statusChannel)};
  const copyCmdChannel = ${safeJson(copyCmdChannel || '')};
  const respond = (i) => { try { window.msgboxAPI.respond(respondChannel, i); } catch {} };
  const allowBtn = document.getElementById('allow');
  const denyBtn = document.getElementById('deny');
  let allowEnabled = ${showSnapPanel ? 'false' : 'true'};

  const setAllowEnabled = (v) => {
    allowEnabled = !!v;
    allowBtn.disabled = !allowEnabled;
  };
  setAllowEnabled(allowEnabled);

  allowBtn.addEventListener('click', () => { if (allowEnabled) respond(0); });
  denyBtn.addEventListener('click', () => respond(1));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); window.close(); }
    else if (e.key === 'Enter' && allowEnabled) { e.preventDefault(); respond(0); }
  });
  setTimeout(() => (allowEnabled ? allowBtn : denyBtn).focus(), 50);

  const snapPanel = document.getElementById('snap-panel');
  if (snapPanel) {
    const statusText = document.getElementById('snap-status-text');
    const labels = ${safeJson({ connected: i18n.snapConnected, disconnected: i18n.snapDisconnected, unknown: i18n.snapUnknown })};
    let lastStatus = snapPanel.dataset.status || 'unknown';
    let pulseTimer = null;
    const apply = (s) => {
      snapPanel.dataset.status = s;
      statusText.textContent = labels[s] || labels.unknown;
      setAllowEnabled(s === 'connected');
      if (s === 'connected' && lastStatus !== 'connected') {
        allowBtn.classList.add('pulse');
        try { allowBtn.focus(); } catch {}
        clearTimeout(pulseTimer);
        pulseTimer = setTimeout(() => allowBtn.classList.remove('pulse'), 5000);
      }
      lastStatus = s;
    };
    apply(lastStatus);
    document.getElementById('open-snap').addEventListener('click', () => {
      try { window.msgboxAPI.openSnapPermissions(snapOpenChannel); } catch {}
    });
    const copyBtn = document.getElementById('snap-cmd-copy');
    const copyLabels = ${safeJson({ idle: i18n.snapCmdCopy, done: i18n.snapCmdCopied })};
    let copyResetTimer = null;
    if (copyBtn && copyCmdChannel) {
      copyBtn.addEventListener('click', () => {
        try { window.msgboxAPI.copySnapCmd(copyCmdChannel); } catch {}
        copyBtn.textContent = copyLabels.done;
        clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => { copyBtn.textContent = copyLabels.idle; }, 1800);
      });
    }
    if (window.msgboxAPI.onStatusUpdate) {
      window.msgboxAPI.onStatusUpdate(statusChannel, (s) => apply(s));
    }
  }
})();
</script>
</body></html>`;
}

// Live Notifications (GitHub-hosted JSON, polled + on-demand)

// Test-Override-Pfad für lokale Entwicklung. Hat Vorrang vor dem GitHub-Fetch.
// Setze CLAUDE_NOTIFICATIONS_OVERRIDE auf einen absoluten Pfad zu einer JSON-Datei.
// In dev (npm start, !app.isPackaged) wird zusätzlich automatisch ./notifications.json
// im Projektroot probiert, falls die ENV-Var nicht gesetzt ist.
function getNotificationsOverridePath() {
  if (process.env.CLAUDE_NOTIFICATIONS_OVERRIDE) return process.env.CLAUDE_NOTIFICATIONS_OVERRIDE;
  if (!app.isPackaged) {
    const local = path.join(__dirname, 'notifications.json');
    if (fs.existsSync(local)) return local;
  }
  return null;
}

function fetchNotificationsRemote() {
  return new Promise((resolve) => {
    const req = net.request({ method: 'GET', url: NOTIFICATIONS_URL, redirect: 'follow', cache: 'no-cache' });
    let body = '';
    let aborted = false;
    const timeout = setTimeout(() => { aborted = true; try { req.abort(); } catch {}; resolve(null); }, 10000);
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(timeout);
        try { req.abort(); } catch {}
        return resolve(null);
      }
      res.on('data', (chunk) => { body += chunk.toString('utf8'); if (body.length > 256 * 1024) { try { req.abort(); } catch {}; } });
      res.on('end', () => {
        clearTimeout(timeout);
        if (aborted) return resolve(null);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
      res.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
    req.end();
  });
}

function loadNotificationsLocal(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

// Validiert + filtert eine eingehende Notification-Liste gegen Version, Plattform,
// Ablauf-Datum und bereits dismissed-IDs. Gibt eine sicher-typisierte Liste zurück.
function filterNotifications(payload) {
  if (!payload || !Array.isArray(payload.notifications)) return [];
  const now = Date.now();
  const ALLOWED_SEVERITY = new Set(['info', 'warn', 'critical', 'success']);
  const out = [];
  for (const n of payload.notifications) {
    if (!n || typeof n !== 'object') continue;
    if (typeof n.id !== 'string' || n.id.length === 0 || n.id.length > 80) continue;
    if (typeof n.title !== 'string' || n.title.length === 0) continue;
    if (dismissedNotificationIds.includes(n.id)) continue;
    if (n.if === 'snap' && !isSnap) continue;
    if (n.if === 'appimage' && isSnap) continue;
    const versionRe = /^\d+(\.\d+)*(-\S+)?$/;
    if (typeof n.minVersion === 'string' && versionRe.test(n.minVersion) && compareVersions(version, n.minVersion) < 0) continue;
    if (typeof n.maxVersion === 'string' && versionRe.test(n.maxVersion) && compareVersions(version, n.maxVersion) > 0) continue;
    if (typeof n.expires === 'string') {
      const exp = Date.parse(n.expires);
      if (Number.isFinite(exp) && exp < now) continue;
    }
    const severity = ALLOWED_SEVERITY.has(n.severity) ? n.severity : 'info';
    const link = (typeof n.link === 'string' && /^https:\/\//i.test(n.link)) ? n.link : null;
    out.push({
      id: n.id,
      severity,
      title: String(n.title).slice(0, 200),
      body: typeof n.body === 'string' ? n.body.slice(0, 600) : '',
      link,
      linkLabel: typeof n.linkLabel === 'string' ? n.linkLabel.slice(0, 60) : null,
      dismissible: n.dismissible !== false
    });
  }
  return out.slice(0, 10);
}

function pushNotificationsToTabBar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('notifications-update', activeNotifications.slice(0, MAX_NOTIFICATIONS_VISIBLE));
  } catch {}
  // View neu positionieren, da der Banner-Bereich Höhe geändert haben könnte.
  lastViewBounds = '';
  resizeActiveView();
}

function getNotificationBarHeight() {
  if (!activeNotifications || activeNotifications.length === 0) return 0;
  return NOTIFICATION_BANNER_HEIGHT * Math.min(activeNotifications.length, MAX_NOTIFICATIONS_VISIBLE);
}

async function refreshNotifications() {
  const override = getNotificationsOverridePath();
  let payload = null;
  if (override) {
    payload = loadNotificationsLocal(override);
  } else {
    payload = await fetchNotificationsRemote();
  }
  activeNotifications = filterNotifications(payload);
  pushNotificationsToTabBar();
}

function setupNotifications() {
  // Override (Dev / lokale Datei): kürzer warten, Banner soll beim Testen schnell erscheinen.
  const delay = getNotificationsOverridePath() ? 1500 : NOTIFICATIONS_FIRST_FETCH_DELAY_MS;
  setTimeout(() => { refreshNotifications().catch(() => {}); }, delay);
  notificationsFetchInterval = setInterval(() => {
    refreshNotifications().catch(() => {});
  }, NOTIFICATIONS_FETCH_MS);
}

function dismissNotification(id) {
  if (typeof id !== 'string' || !id) return;
  if (!dismissedNotificationIds.includes(id)) {
    dismissedNotificationIds.push(id);
    if (dismissedNotificationIds.length > 200) dismissedNotificationIds = dismissedNotificationIds.slice(-200);
    saveWindowState();
  }
  activeNotifications = activeNotifications.filter(n => n.id !== id);
  pushNotificationsToTabBar();
}

function setupSession() {
  const ses = session.fromPartition('persist:claude');
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']);

  ses.setPermissionRequestHandler((_, perm, cb, details) => {
    if (perm === 'media') {
      // Mikrofon nur für claude.ai zulassen — claudeusercontent.com (Artifact-iframes)
      // explizit ausschließen, damit User-generierter Code keinen Mic-Zugriff erbt.
      if (!isClaudeAiOrigin(details && details.requestingUrl)) return cb(false);
      const wantsAudio = !details || !details.mediaTypes || details.mediaTypes.includes('audio');
      if (!wantsAudio) return cb(false);
      if (microphoneEnabled) return cb(true);
      if (microphoneConsentAsked) return cb(false);
      getOrStartMicConsent().then(reason => {
        if (reason !== 'dismissed') {
          microphoneConsentAsked = true;
          microphoneEnabled = reason === 'granted';
          saveWindowState();
        }
        cb(reason === 'granted');
      }).catch(() => cb(false));
      return;
    }
    cb(allowed.has(perm));
  });
  ses.setPermissionCheckHandler((_, perm, requestingOrigin) => {
    if (perm === 'media') {
      if (!isClaudeAiOrigin(requestingOrigin)) return false;
      return microphoneEnabled;
    }
    return allowed.has(perm);
  });

  ses.setUserAgent(chromeUA);

  const chromeFull = process.versions.chrome;
  const chromeMajor = chromeFull.split('.')[0];
  // Muss byte-genau dem entsprechen, was navigator.userAgentData im Renderer meldet,
  // sonst ist die Differenz (Header behauptet einen Brand, den die JS-API leugnet) ein
  // CF-Turnstile-Bot-Signal. Electron meldet [Not-A.Brand;v=24, Chromium;v=<major>] und
  // KEIN "Google Chrome". GREASE-Token/Reihenfolge bei Electron-Upgrades gegenchecken.
  const secChUa = `"Not-A.Brand";v="24", "Chromium";v="${chromeMajor}"`;
  const secChUaFullVersionList = `"Not-A.Brand";v="24.0.0.0", "Chromium";v="${chromeFull}"`;

  ses.webRequest.onBeforeSendHeaders({
    urls: [
      '*://*.claude.ai/*',
      '*://*.claudeusercontent.com/*',
      '*://*.claudemcpcontent.com/*',
      '*://*.claudemcp.com/*',
      '*://*.anthropic.com/*',
      '*://challenges.cloudflare.com/*'
    ]
  }, (details, cb) => {
    const h = details.requestHeaders;
    h['Sec-Ch-Ua'] = secChUa;
    h['Sec-Ch-Ua-Mobile'] = '?0';
    h['Sec-Ch-Ua-Platform'] = '"Linux"';
    h['Sec-Ch-Ua-Full-Version-List'] = secChUaFullVersionList;
    // Chrome on Linux always sends an empty platform version; the kernel string was a bot tell.
    h['Sec-Ch-Ua-Platform-Version'] = '""';
    cb({ requestHeaders: h });
  });

  // Preconnect (mehr Sockets für schnellere erste Requests)
  ses.preconnect({ url: 'https://claude.ai', numSockets: 6 });
  ses.preconnect({ url: 'https://cdn.claude.ai', numSockets: 2 });
  ses.preconnect({ url: 'https://api.claude.ai', numSockets: 2 });
}

// IPC-Handler

// Linux Autostart: schreibt eine .desktop-Datei.
// AppImage: ~/.config/autostart/claude-ai-desktop.desktop (echtes Home).
// Snap: $SNAP_USER_DATA/.config/autostart/claude-ai-desktop.desktop. snapd-userd
// liest die Datei beim Login und startet die App über den command-wrapper aus
// snapcraft.yaml (autostart-Direktive). Kein personal-files-Plug nötig.
const isSnap = !!(process.env.SNAP_NAME || process.env.SNAP);
const AUTOSTART_DIR = isSnap
  ? path.join(process.env.SNAP_USER_DATA, '.config', 'autostart')
  : path.join(app.getPath('home'), '.config', 'autostart');
const AUTOSTART_FILE = path.join(AUTOSTART_DIR, 'claude-ai-desktop.desktop');

function getAutostartExec() {
  if (process.env.APPIMAGE) return `"${process.env.APPIMAGE}" --no-sandbox`;
  if (isSnap) return '/snap/bin/claude-ai-desktop';
  return null;
}

function getAutostart() {
  if (process.platform !== 'linux') {
    try { return !!app.getLoginItemSettings().openAtLogin; } catch { return false; }
  }
  try { return fs.existsSync(AUTOSTART_FILE); } catch { return false; }
}

// Liefert eine der Konstanten:
//   'ok'       — Autostart-Status erfolgreich gesetzt
//   'denied'   — Schreibzugriff verweigert (sollte unter normalen Bedingungen nicht passieren)
//   'failed'   — sonstiger Fehler
function setAutostart(enabled) {
  enabled = !!enabled;
  if (process.platform !== 'linux') {
    try { app.setLoginItemSettings({ openAtLogin: enabled }); return 'ok'; }
    catch { return 'failed'; }
  }
  try {
    if (enabled) {
      const exec = getAutostartExec();
      if (!exec) return 'failed';
      fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
      fs.writeFileSync(AUTOSTART_FILE,
`[Desktop Entry]
Type=Application
Name=Claude
Comment=Claude AI Desktop
Exec=${exec}
Icon=claude-ai-desktop
Terminal=false
X-GNOME-Autostart-enabled=true
`, { mode: 0o644 });
    } else {
      try { fs.unlinkSync(AUTOSTART_FILE); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return 'ok';
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) return 'denied';
    return 'failed';
  }
}

// .desktop-Self-Heal: electron-updater ersetzt die AppImage durch eine mit neuer
// Versionsnummer im Dateinamen (~/Apps/Claude-Desktop-1.3.X.AppImage). Die im
// Installer geschriebene applications/.desktop-Datei zeigt aber weiter auf den
// alten Pfad und der Menü-Eintrag startet nach jedem Auto-Update ins Leere.
// Lösung: bei jedem Start prüfen, ob der Exec= im .desktop-File mit dem aktuellen
// process.env.APPIMAGE übereinstimmt; wenn nicht, beide Files (Menü + Autostart,
// falls aktiv) rewriten und update-desktop-database triggern.
function selfHealDesktopFiles() {
  if (process.platform !== 'linux') return;
  if (isSnap) return;
  const appImagePath = process.env.APPIMAGE;
  if (!appImagePath) return;

  const appsDesktop = path.join(app.getPath('home'), '.local', 'share', 'applications', 'claude-desktop.desktop');
  let appsChanged = false;

  try {
    if (fs.existsSync(appsDesktop)) {
      const content = fs.readFileSync(appsDesktop, 'utf8');
      const updated = content
        .replace(/^Exec=.*$/m, () => `Exec="${appImagePath}" --no-sandbox %U`)
        .replace(/^X-AppImage-Version=.*$/m, () => `X-AppImage-Version=${version}`);
      if (updated !== content) {
        fs.writeFileSync(appsDesktop, updated);
        appsChanged = true;
      }
    }
  } catch (_) {}

  try {
    if (fs.existsSync(AUTOSTART_FILE)) {
      const content = fs.readFileSync(AUTOSTART_FILE, 'utf8');
      const updated = content.replace(/^Exec=.*$/m, () => `Exec="${appImagePath}" --no-sandbox`);
      if (updated !== content) fs.writeFileSync(AUTOSTART_FILE, updated, { mode: 0o644 });
    }
  } catch (_) {}

  if (appsChanged) {
    try {
      const { execFile } = require('child_process');
      execFile('update-desktop-database', [path.dirname(appsDesktop)], { timeout: 5000 }, () => {});
    } catch (_) {}
  }
}

ipcMain.handle('settings-get', () => ({
  minimizeOnClose,
  hotkey: currentHotkey,
  clipboardHotkey: currentClipboardHotkey,
  bgNotifications: bgNotificationsEnabled,
  microphoneEnabled,
  isSnap,
  templates: promptTemplates.map(t => ({ id: t.id, name: t.name, prefix: t.prefix })),
  autostart: getAutostart()
}));
ipcMain.on('settings-minimize', (_, v) => {
  minimizeOnClose = v === true;
  saveWindowState();
});
ipcMain.handle('settings-autostart', (_, v) => setAutostart(v === true));

ipcMain.handle('settings-hotkey', (_, accel) => {
  const value = validateAccelerator(accel);
  const res = registerHotkey(value);
  if (res === 'ok') saveWindowState();
  return res;
});
ipcMain.handle('settings-clipboard-hotkey', (_, accel) => {
  const value = validateAccelerator(accel);
  const res = registerClipboardHotkey(value);
  if (res === 'ok') saveWindowState();
  return res;
});
ipcMain.on('settings-bg-notifications', (_, v) => {
  bgNotificationsEnabled = v === true;
  saveWindowState();
});

ipcMain.on('settings-microphone', (_, v) => {
  microphoneEnabled = v === true;
  microphoneConsentAsked = true;
  saveWindowState();
});

// Snap-aware Mic-Toggle: bei ON auf Snap mit disconnected Plug zeigt
// requestMicrophoneConsent() den Wizard. Bei !isSnap oder bereits connected
// verhaelt es sich wie der direkte Toggle.
ipcMain.handle('settings-microphone-with-consent', async (_, v) => {
  const want = v === true;
  if (!want) {
    microphoneEnabled = false;
    microphoneConsentAsked = true;
    saveWindowState();
    return { applied: false, status: 'connected' };
  }
  if (!isSnap) {
    microphoneEnabled = true;
    microphoneConsentAsked = true;
    saveWindowState();
    return { applied: true, status: 'connected' };
  }
  // Snap: Plug-Status pruefen
  const status = await new Promise(resolve => checkSnapAudioRecordStatus(resolve));
  if (status === 'connected') {
    microphoneEnabled = true;
    microphoneConsentAsked = true;
    saveWindowState();
    return { applied: true, status };
  }
  // Plug nicht verbunden -> Consent-Dialog mit Snap-Wizard.
  // Geht ueber den Modul-weiten Mutex, damit ein paralleler claude.ai-Mic-Trigger
  // nicht ein zweites Modal aufmacht.
  const reason = await getOrStartMicConsent();
  if (reason !== 'dismissed') microphoneConsentAsked = true;
  microphoneEnabled = reason === 'granted';
  saveWindowState();
  const newStatus = await new Promise(resolve => checkSnapAudioRecordStatus(resolve));
  return { applied: microphoneEnabled, status: newStatus };
});

ipcMain.handle('settings-mic-snap-status', () => {
  if (!isSnap) return Promise.resolve('connected');
  return new Promise(resolve => checkSnapAudioRecordStatus(resolve));
});

ipcMain.on('settings-microphone-reset', () => {
  microphoneEnabled = false;
  microphoneConsentAsked = false;
  saveWindowState();
});
ipcMain.on('settings-open-snap-permissions', () => openSnapStorePage());
ipcMain.on('settings-copy-snap-cmd', () => { try { clipboard.writeText(SNAP_CONNECT_CMD); } catch {} });

// Live-Notifications (Tab-Bar-Banner)
ipcMain.on('notification-dismiss', (_, id) => dismissNotification(id));
ipcMain.on('notification-link', (_, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const url = typeof payload.url === 'string' ? payload.url : '';
  if (!/^https:\/\//i.test(url)) return;
  openExternalSafe(url);
});
ipcMain.on('notifications-request', () => pushNotificationsToTabBar());

ipcMain.handle('settings-add-template', (_, tpl) => {
  if (!tpl || typeof tpl.name !== 'string' || typeof tpl.prefix !== 'string') return { error: 'invalid' };
  const name = tpl.name.trim().slice(0, 40);
  const prefix = tpl.prefix.slice(0, 2000);
  if (!name || !prefix.trim()) return { error: 'invalid' };
  if (promptTemplates.length >= 50) return { error: 'limit' };
  if (promptTemplates.some(t => t.name.toLowerCase() === name.toLowerCase())) return { error: 'dup' };
  const id = 'tpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  promptTemplates.push({ id, name, prefix });
  saveWindowState();
  return { templates: promptTemplates.slice() };
});
ipcMain.handle('settings-delete-template', (_, id) => {
  if (typeof id === 'string') {
    promptTemplates = promptTemplates.filter(t => t.id !== id);
    saveWindowState();
  }
  return { templates: promptTemplates.slice() };
});

ipcMain.on('settings-close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

// Background-Notification von der claude.ai-Seite (via preload-content.js)
ipcMain.on('claude-response-done', (event, payload) => {
  if (!bgNotificationsEnabled) return;
  // Senderview ermitteln
  const senderWc = event.sender;
  const idx = tabs.findIndex(tb => tb.view && tb.view.webContents === senderWc);
  if (idx < 0) return;
  // Nur Notification, wenn Tab nicht aktiv ODER Hauptfenster nicht sichtbar/fokussiert
  const mainVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized();
  if (idx === activeTabIndex && mainVisible) return;
  const tab = tabs[idx];
  const title = (tab.title || 'Claude').slice(0, 80);
  const body = typeof payload === 'object' && payload && typeof payload.preview === 'string'
    ? payload.preview.slice(0, 140)
    : t('Antwort fertig', 'Response ready', 'Réponse prête', 'Risposta pronta');
  try {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => {
      showMainWindow();
      if (idx >= 0 && idx < tabs.length) switchToTab(idx);
    });
    n.show();
  } catch {}
});

ipcMain.on('cd-offline-retry', (event) => {
  // Zurueck auf den Chat dieses Tabs, nicht auf einen neuen. Sender-Lookup, weil der
  // Nutzer waehrend der Offline-Seite den Tab gewechselt haben kann.
  const fromTab = tabs.find(tb => tb.view && tb.view.webContents === event.sender);
  if (!fromTab || !alive(fromTab.view)) return;
  fromTab.view.webContents.loadURL(fromTab.url || 'https://claude.ai');
});

ipcMain.on('claude-reset-verification', (event) => {
  // Nur aus einer echten Tab-View akzeptieren; den Reset auf genau diesen Tab anwenden,
  // nicht auf den aktiven (der Nutzer kann waehrend des Bestaetigungsdialogs wechseln).
  const fromTab = tabs.find(tb => tb.view && tb.view.webContents === event.sender);
  if (!fromTab) return;
  resetClaudeVerification(fromTab);
});

// Reset-Button in der Tab-Bar-Toolbar (eigener Kanal, da die Tab-Bar-View nicht in `tabs`
// steht und der Handler oben sie sonst verwirft). Wirkt auf den aktiven Tab.
ipcMain.on('tabbar-reset-verification', () => resetClaudeVerification());

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

ipcMain.on('about-close', () => {
  if (aboutWindow && !aboutWindow.isDestroyed()) aboutWindow.close();
});
ipcMain.on('about-open-whatsnew', () => {
  if (aboutWindow && !aboutWindow.isDestroyed()) aboutWindow.close();
  openWhatsNewWindow(true);
});
ipcMain.on('about-open-external', (_event, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) openExternalSafe(url);
});

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('win-state', { maximized: mainWindow.isMaximized() });
  } catch (_) {}
}
function fromMainWindow(event) {
  return mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}
ipcMain.on('win-minimize', (event) => { if (fromMainWindow(event)) mainWindow.minimize(); });
ipcMain.on('win-toggle-maximize', (event) => {
  if (!fromMainWindow(event)) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win-close', (event) => { if (fromMainWindow(event)) mainWindow.close(); });
ipcMain.on('win-state-request', (event) => { if (fromMainWindow(event)) sendWindowState(); });

ipcMain.on('tab-new', () => createTab());
ipcMain.on('tab-switch', (_, i) => {
  if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < tabs.length) switchToTab(i);
});
ipcMain.on('tab-close', (_, i) => {
  if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < tabs.length) closeTab(i);
});
ipcMain.on('design-toggle', toggleDesign);
ipcMain.on('bug-report', showBugReportDialog);
ipcMain.on('export-conversation', () => exportActiveConversation());
ipcMain.on('app-menu-popup', (_event, x, y) => {
  if (Date.now() - appMenuJustClosedAt < 250) return;
  openAppMenuWindow(x, y);
});
ipcMain.on('appmenu-action', (event, name) => {
  if (!appMenuWindow || appMenuWindow.isDestroyed() || event.sender !== appMenuWindow.webContents) return;
  appMenuWindow.close();
  switch (name) {
    case 'new-tab': createTab(); break;
    case 'close-tab': closeTab(activeTabIndex); break;
    case 'export': exportActiveConversation(); break;
    case 'reload':
      if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view)) tabs[activeTabIndex].view.webContents.reload();
      break;
    case 'design-toggle': toggleDesign(); break;
    case 'settings': openSettingsWindow(); break;
    case 'check-updates':
      triggerManualUpdateCheck();
      break;
    case 'bug-report': showBugReportDialog(); break;
    case 'copy-diagnostics': copyDiagnosticsInfo(); break;
    case 'reset-verification': resetClaudeVerification(); break;
    case 'whats-new': openWhatsNewWindow(true); break;
    case 'about': openAboutWindow(); break;
    case 'quit': isQuitting = true; app.quit(); break;
  }
});
ipcMain.on('appmenu-close', (event) => {
  if (appMenuWindow && !appMenuWindow.isDestroyed() && event.sender === appMenuWindow.webContents) {
    appMenuWindow.close();
  }
});
ipcMain.on('theme-toggle', () => {
  // Cycle: light -> dark -> oled -> light
  if (!isDarkMode) { isDarkMode = true; oledMode = false; }
  else if (!oledMode) { oledMode = true; }
  else { isDarkMode = false; oledMode = false; }
  drainPool();
  applyThemeToAllViews();

  const bg = theme().bg;
  const active = tabs[activeTabIndex]?.view;
  if (active && alive(active)) active.setBackgroundColor(bg);

  // claude.ai bleibt immer im dark-Modus; White entsteht per GPU-Invert im injizierten Theme
  // (data-cd-theme="light" -> filter:invert am Wurzelknoten, ~6ms statt ~480ms fuer claude.ais
  // prefers-color-scheme-Palettenwechsel). Deshalb kein Farbschema-Flip mehr.
  nativeTheme.themeSource = 'dark';
  sendThemeUpdate();

  for (const tab of tabs) {
    if (tab.view !== active && alive(tab.view)) tab.view.setBackgroundColor(bg);
  }

  setTimeout(fillPool, 3000);
  saveWindowState();
});

// Fenster erstellen

function createWindow() {
  const state = loadWindowState();
  // Immer dark: White laeuft ueber den Invert-Filter im injizierten Theme, nicht ueber
  // claude.ais prefers-color-scheme (siehe theme-toggle).
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    width: state.width, height: state.height, x: state.x, y: state.y,
    minWidth: 480, minHeight: 600, title: `Claude v${version}`,
    icon: icon(),
    backgroundColor: theme().bg,
    autoHideMenuBar: true,
    frame: false,
    show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, 'preload-tabbar.js'),
      backgroundThrottling: false,
      spellcheck: false,
    }
  });
  mainWindow.setMenuBarVisibility(false);

  if (state.isMaximized) mainWindow.maximize();

  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(getTabBarHTML()));
  mainWindow.setTitle(`Claude v${version}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 3000);

  mainWindow.on('resize', () => { saveWindowState(); resizeActiveView(); settleActiveView(); });
  mainWindow.on('move', saveWindowState);
  mainWindow.on('maximize', () => { saveWindowState(); lastViewBounds = ''; resizeActiveView(); sendWindowState(); });
  mainWindow.on('unmaximize', () => { saveWindowState(); lastViewBounds = ''; resizeActiveView(); sendWindowState(); });
  mainWindow.on('enter-full-screen', () => { lastViewBounds = ''; resizeActiveView(); });
  mainWindow.on('leave-full-screen', () => { lastViewBounds = ''; resizeActiveView(); });
  // settleActiveView auch hier: nach Restore/Show haelt die Compositor-Surface auf X11
  // gern veralteten Inhalt fest, und resizeActiveView allein ist bei gleicher Fenstergroesse
  // ein No-op. Debounced, kostet also nichts.
  mainWindow.on('show', () => { lastViewBounds = ''; resizeActiveView(); settleActiveView(); throttleActiveView(false); });
  mainWindow.on('restore', () => { throttleActiveView(false); focusActiveView(); settleActiveView(); });
  // Online-Status beim Zurueckwechseln sofort pruefen statt bis zu 60s auf den Poll zu
  // warten. handleOnlineChange ist flankengeguarded, also idempotent.
  mainWindow.on('focus', () => { throttleActiveView(false); focusActiveView(); handleOnlineChange(net.isOnline()); });
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

  // Erster Tab + Pool verzögert füllen. Weitere Tabs der letzten Sitzung werden
  // deferred angelegt und laden erst beim Anklicken.
  mainWindow.webContents.once('did-finish-load', () => {
    const restored = Array.isArray(windowState.tabs)
      ? windowState.tabs.filter(u => typeof u === 'string' && u.startsWith('https://')).slice(0, 20)
      : [];
    const tab = createTab(restored[0] || 'https://claude.ai');
    for (let i = 1; i < restored.length; i++) createTab(restored[i], true);
    if (tab) {
      tab.view.webContents.once('did-finish-load', () => {
        lastViewBounds = '';
        resizeActiveView();
        setTimeout(fillPool, 2000);
      });
    }
  });
}

// App Lifecycle

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) showMainWindow();
  else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

// Webview-Tags blockieren (Security)
app.on('web-contents-created', (_, wc) => {
  wc.on('will-attach-webview', (event) => event.preventDefault());
});

ipcMain.on('bug-report-open-support', () => {
  openExternalSafe('https://support.anthropic.com');
});

// Web3Forms erkennt Origin: null (unser data:-URL-Renderer) als "server-side"
// und antwortet mit 403/Pro-required. Mit einem echten Origin-Header laeuft der
// Submit als regulaerer Client-Call durch. localhost ist im Web3Forms-Dashboard
// als erlaubte Domain registriert.
function setupWeb3FormsHeaderRewrite() {
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['https://api.web3forms.com/*'] },
      (details, callback) => {
        const headers = { ...details.requestHeaders };
        headers['Origin'] = 'https://localhost';
        headers['Referer'] = 'https://localhost/';
        callback({ requestHeaders: headers });
      }
    );
  } catch (_) {}
}

app.whenReady().then(() => {
  selfHealDesktopFiles();
  setupSession();
  setupWeb3FormsHeaderRewrite();
  createWindow();
  updateMenu(true);
  setupDownloadManager();
  setupAutoUpdater();
  setupNotifications();
  setupTray();
  if (currentHotkey) registerHotkey(currentHotkey);
  if (currentClipboardHotkey) registerClipboardHotkey(currentClipboardHotkey);
  handleOnlineChange(net.isOnline());
  onlineCheckInterval = setInterval(() => handleOnlineChange(net.isOnline()), ONLINE_CHECK_MS);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  if (mainWindow && windowState.lastSeenVersion !== version && getFilteredNotes(version, windowState.lastSeenVersion).length > 0) {
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
  if (notificationsFetchInterval) { clearInterval(notificationsFetchInterval); notificationsFetchInterval = null; }
  saveWindowStateSync();
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
});
