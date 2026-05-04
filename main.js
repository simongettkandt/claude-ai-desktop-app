const { app, BrowserWindow, WebContentsView, shell, Menu, Tray, globalShortcut, nativeImage, nativeTheme, dialog, Notification, session, ipcMain, net, screen, clipboard } = require('electron');
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

// Live-Notification-System (GitHub-hosted JSON)
const NOTIFICATIONS_URL = 'https://raw.githubusercontent.com/simonlinuxcraft/claude-ai-desktop-app/main/notifications.json';
const NOTIFICATIONS_FETCH_MS = 6 * 60 * 60 * 1000;        // alle 6h
const NOTIFICATIONS_FIRST_FETCH_DELAY_MS = 8 * 1000;       // nach App-Start 8s warten
const NOTIFICATION_BANNER_HEIGHT = 38;
const MAX_NOTIFICATIONS_VISIBLE = 1;                        // ein Banner gleichzeitig

// ═══════════════════════════════════════════════════════════════════
//  Injected Scripts (aus Dateien geladen)
// ═══════════════════════════════════════════════════════════════════

const BRAND_SCRIPT = fs.readFileSync(path.join(__dirname, 'inject', 'brand.js'), 'utf8');
const NOTIFY_SCRIPT = fs.readFileSync(path.join(__dirname, 'inject', 'notify.js'), 'utf8');

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
  en: {
    title: 'Report a Bug',
    intro: 'Found a bug or have a suggestion? Send us a message — your feedback helps improve the app.',
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
let appMenuWindow = null;
let appMenuJustClosedAt = 0;
let minimizeOnClose = false;
let currentHotkey = null;
let currentClipboardHotkey = null;
let promptTemplates = [];      // [{ id, name, prefix }]
let bgNotificationsEnabled = false;
let microphoneEnabled = false;
let microphoneConsentAsked = false;
let lastActiveTabIndex = -1;   // für Background-Notifications
let updateCheckInterval = null;
let onlineCheckInterval = null;
let waitForFirstTabInterval = null;
let notificationsFetchInterval = null;
let activeNotifications = [];                    // gefilterte, aktuell sichtbare Notifications
let dismissedNotificationIds = [];                // persistiert in windowState

const RELEASE_NOTES = {
  '1.3.0': [
    { icon: 'tray', title: 'Systemtray & Hintergrund-Modus', text: 'Claude l\u00e4uft jetzt im Hintergrund weiter und ist \u00fcber das Tray-Symbol erreichbar.' },
    { icon: 'bolt', title: 'Globaler Quick-Prompt', text: 'Ein frei w\u00e4hlbarer Hotkey \u00f6ffnet ein Eingabefenster f\u00fcr neue Chats \u2013 direkt aus jeder App.' },
    { icon: 'check', title: 'Update-Check mit Feedback', text: 'Das Men\u00fc zeigt jetzt klar an, ob ein Update bereitsteht oder die App aktuell ist.' },
    { icon: 'settings', title: 'App-Einstellungen', text: 'Neuer Dialog f\u00fcr Tray-Verhalten und Hotkey \u2013 jederzeit \u00fcber das Men\u00fc erreichbar.' }
  ],
  '1.3.1': [
    { icon: 'check', title: 'Download-Dialog nicht mehr doppelt', text: 'Beim Speichern von Dateien aus Chats erscheint der Dialog jetzt zuverl\u00e4ssig nur einmal \u2013 auch bei Blob- und Redirect-Downloads.' },
    { icon: 'bolt', title: 'Quick-Prompt sendet nicht mehr automatisch', text: 'Der Text wird ins Eingabefeld \u00fcbernommen und der Cursor ans Ende gesetzt. Du dr\u00fcckst selbst Enter zum Absenden.' },
    { icon: 'settings', title: 'Dialoge zentriert \u00fcber der App', text: 'Update- und Hinweis-Dialoge \u00f6ffnen sich jetzt zuverl\u00e4ssig zentriert \u00fcber dem App-Fenster \u2013 auch auf Multi-Monitor-Setups.' },
    { icon: 'check', title: 'Code-Tab in der Sidebar funktioniert', text: 'Der Klick auf \u201eCode\u201c in der Sidebar \u00f6ffnet die Seite jetzt korrekt in einem neuen Fenster, statt sich sofort wieder zu schlie\u00dfen.' },
    { icon: 'tray', title: 'Tray-Icon besser erkennbar', text: 'Das Symbol in der Systemleiste zeigt jetzt das Sparkle-Logo gr\u00f6\u00dfer und transparent \u2013 deutlich sichtbar auf hellen wie dunklen Tray-Hintergr\u00fcnden.' },
    { icon: 'bolt', title: 'Autostart beim Anmelden', text: 'Optional kann Claude jetzt automatisch beim Hochfahren des Systems starten \u2013 ein- und ausschaltbar in den App-Einstellungen.' }
  ],
  '1.3.3': [
    { icon: 'check', title: 'Artifact-Vorschauen werden wieder angezeigt', text: 'HTML-, React- und Wireframe-Vorschauen aus Chats erscheinen jetzt wieder im Vorschau-Panel \u2013 vorher blieb es leer, weil die App den separaten Anzeige-Server (claudeusercontent.com) blockiert hat.' }
  ],
  '1.3.4': [
    {
      icon: 'bolt',
      title: 'Direkt aus der App Fehler melden',
      text: 'Statt eine E-Mail zu schreiben kannst du jetzt einen kurzen Bericht direkt im Fenster ausf\u00fcllen \u2013 mit optionalen Fehlercodes und Kontakt-Mail. App-Version, OS und Sprache werden auf Wunsch automatisch mitgesendet.'
    },
    {
      icon: 'settings',
      title: 'Dialoge erscheinen \u00fcber der App',
      text: 'App-Einstellungen, Bug-Report und Update-Hinweise zentrieren sich jetzt auf dem Hauptfenster \u2013 egal wo du die App auf dem Bildschirm hast.'
    },
    {
      icon: 'check',
      title: 'Autostart funktioniert jetzt automatisch',
      text: 'Der Autostart-Schalter in den App-Einstellungen funktioniert ab sofort ohne manuellen Setup-Schritt \u2013 einfach umlegen, fertig.',
      if: 'snap'
    }
  ],
  '1.3.5': [
    {
      icon: 'settings',
      title: 'Neue Tab-Leiste mit App-Men\u00fc',
      text: 'Das Men\u00fc-Icon ganz links (\u2261) \u00f6ffnet ein eigenes App-Men\u00fc mit allen wichtigen Funktionen. Zus\u00e4tzlich hat die Tab-Leiste jetzt direkten Zugriff auf Konversations-Export und Bug-Report.'
    },
    {
      icon: 'bolt',
      title: 'Konversation als Markdown exportieren',
      text: 'Mit Strg+Shift+E (oder \u00fcber das Men\u00fc) speicherst du den aktuellen Chat als .md-Datei \u2013 inklusive Code-Bl\u00f6cken, Listen und \u00dcberschriften.'
    },
    {
      icon: 'bolt',
      title: 'Prompt-Templates f\u00fcr den Quick-Prompt',
      text: 'In den App-Einstellungen legst du eigene Prefix-Texte an (z.B. \u201e\u00dcbersetze ins Englische:"). Im Quick-Prompt-Fenster w\u00e4hlst du sie per Tab aus und tippst nur noch deinen Inhalt.'
    },
    {
      icon: 'tray',
      title: 'Benachrichtigung f\u00fcr Hintergrund-Tabs',
      text: 'Optional schickt Claude eine native Notification, sobald die Antwort in einem nicht aktiven Tab fertig ist. Aktivierbar in den App-Einstellungen.'
    },
    {
      icon: 'bolt',
      title: 'Zwischenablage als neuer Chat',
      text: 'Ein eigener globaler Hotkey \u00f6ffnet einen frischen Chat und f\u00fcgt automatisch den Text aus der Zwischenablage als Prompt ein.'
    },
    {
      icon: 'check',
      title: 'Copy & Paste im Snap funktioniert wieder',
      text: 'Auf Wayland-Sessions konnte die Snap-Version Inhalte nicht zuverl\u00e4ssig zwischen Apps kopieren. Mit dem neuen Launch-Pfad (native Wayland-Clipboard) klappt Kopieren und Einf\u00fcgen jetzt sauber.',
      if: 'snap'
    },
    {
      icon: 'heart',
      title: 'Danke f\u00fcrs Nutzen!',
      text: 'St\u00f6\u00dft du auf einen Fehler? Bitte \u00fcber das K\u00e4fer-Symbol oben in der Tab-Leiste melden \u2013 jeder Bericht hilft mir, die App zu verbessern. Vielen Dank f\u00fcr deinen Support.'
    }
  ],
  '1.3.6': [
    {
      icon: 'bolt',
      title: 'Spracheingabe per Mikrofon',
      text: 'Beim ersten Klick auf das Mikrofon-Symbol in claude.ai fragt die App einmal um Erlaubnis. Du kannst die Berechtigung jederzeit in den App-Einstellungen unter \u201eMikrofon" wieder ausschalten.'
    },
    {
      icon: 'settings',
      title: 'Snap: Mikrofon mit einem Klick freigeben',
      text: 'Im Hinweis-Dialog zeigt dir die App den Snap-Berechtigungs-Status live. \u201eIm Snap-Store \u00f6ffnen" springt direkt in den Store \u2013 oder du kopierst den Terminal-Befehl mit einem Klick. Der Dialog erkennt die Aktivierung automatisch, egal welchen Weg du nimmst.',
      if: 'snap'
    },
    {
      icon: 'bolt',
      title: 'Live-Hinweise direkt in der App',
      text: 'Wichtige Hinweise (z.B. zu bekannten Problemen oder Updates) erscheinen jetzt als Banner \u00fcber der Tab-Leiste. Sie kommen direkt vom Projekt-Repo und k\u00f6nnen jederzeit per Klick auf das \u00d7 weggeschoben werden.'
    }
  ]
};

function compareVersions(a, b) {
  const parse = v => {
    const [main, pre] = String(v).split('-');
    return { nums: main.split('.').map(n => parseInt(n, 10) || 0), pre: pre || null };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) {
    const da = A.nums[i] || 0, db = B.nums[i] || 0;
    if (da !== db) return da - db;
  }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  if (A.pre && B.pre) return A.pre.localeCompare(B.pre);
  return 0;
}

function getFilteredNotes(currentVersion, lastSeenVersion) {
  const all = Object.keys(RELEASE_NOTES);
  let versionsToShow;
  if (!lastSeenVersion) {
    versionsToShow = all.includes(currentVersion) ? [currentVersion] : [];
  } else {
    versionsToShow = all
      .filter(v => compareVersions(v, lastSeenVersion) > 0 && compareVersions(v, currentVersion) <= 0)
      .sort(compareVersions);
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
  if (windowState.customDesign !== undefined) customDesign = windowState.customDesign;
  if (windowState.isDarkMode !== undefined) isDarkMode = windowState.isDarkMode;
  minimizeOnClose = windowState.minimizeOnClose === true;
  currentHotkey = typeof windowState.hotkey === 'string' && windowState.hotkey.length > 0 ? windowState.hotkey : null;
  currentClipboardHotkey = typeof windowState.clipboardHotkey === 'string' && windowState.clipboardHotkey.length > 0 ? windowState.clipboardHotkey : null;
  promptTemplates = Array.isArray(windowState.promptTemplates) ? windowState.promptTemplates.filter(tpl =>
    tpl && typeof tpl.name === 'string' && typeof tpl.prefix === 'string'
  ).slice(0, 50) : [];
  bgNotificationsEnabled = windowState.bgNotificationsEnabled === true;
  microphoneEnabled = windowState.microphoneEnabled === true;
  microphoneConsentAsked = windowState.microphoneConsentAsked === true;
  dismissedNotificationIds = Array.isArray(windowState.dismissedNotificationIds)
    ? windowState.dismissedNotificationIds.filter(id => typeof id === 'string').slice(0, 200)
    : [];

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
    clipboardHotkey: currentClipboardHotkey,
    promptTemplates,
    bgNotificationsEnabled,
    microphoneEnabled,
    microphoneConsentAsked,
    dismissedNotificationIds: dismissedNotificationIds.slice(0, 200),
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
  try {
    const h = new URL(url).hostname;
    r = h === 'claude.ai' || h.endsWith('.claude.ai')
      || h === 'claudeusercontent.com' || h.endsWith('.claudeusercontent.com');
  } catch { r = false; }
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

// Beta-Build erkennen — eigene Icons (BETA-Badge) zur visuellen Unterscheidung von Stable
const isBeta = process.env.CLAUDE_BETA === '1'
            || (process.env.APPIMAGE || '').toLowerCase().includes('beta');

function theme()  { return isDarkMode ? THEME.dark : THEME.light; }
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
<style>
:root{--bg:${th.bg};--bgh:${th.bgHover};--bga:${th.bgActive};--t:${th.text};--ta:${th.textActive};--bd:${th.border};
  --ac-from:${a.from};--ac-to:${a.to}}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{background:var(--bg);font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  color:var(--t);overflow:hidden;user-select:none;
  display:flex;flex-direction:column;contain:layout style}
#notif-bar{display:flex;flex-direction:column;flex-shrink:0;-webkit-app-region:no-drag}
#notif-bar:empty{display:none}
.notif{display:flex;align-items:center;gap:10px;height:${NOTIFICATION_BANNER_HEIGHT}px;padding:0 12px;font-size:12px;line-height:1.3;color:var(--ta);border-bottom:1px solid var(--bd);background:var(--bgh)}
.notif[data-sev="info"]{background:linear-gradient(90deg,color-mix(in srgb,var(--ac-from) 14%,var(--bgh)),var(--bgh))}
.notif[data-sev="warn"]{background:linear-gradient(90deg,color-mix(in srgb,#e0a93e 22%,var(--bgh)),var(--bgh))}
.notif[data-sev="critical"]{background:linear-gradient(90deg,color-mix(in srgb,#e05e3e 28%,var(--bgh)),var(--bgh))}
.notif[data-sev="success"]{background:linear-gradient(90deg,color-mix(in srgb,#3fb96e 22%,var(--bgh)),var(--bgh))}
.notif-dot{width:8px;height:8px;border-radius:50%;background:var(--ac-from);flex:0 0 auto}
.notif[data-sev="warn"] .notif-dot{background:#e0a93e}
.notif[data-sev="critical"] .notif-dot{background:#e05e3e}
.notif[data-sev="success"] .notif-dot{background:#3fb96e}
.notif-text{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.notif-text strong{font-weight:600;color:var(--ta);margin-right:6px}
.notif-text span{color:var(--t);font-weight:400}
.notif-link{flex:0 0 auto;background:transparent;color:var(--ac-from);border:1px solid color-mix(in srgb,var(--ac-from) 35%,transparent);border-radius:5px;padding:3px 9px;font-size:11.5px;font-family:inherit;font-weight:500;cursor:pointer}
.notif-link:hover{background:color-mix(in srgb,var(--ac-from) 12%,transparent)}
.notif-x{flex:0 0 auto;width:22px;height:22px;border-radius:5px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--t);font-size:15px;line-height:1;border:none;background:transparent;font-family:inherit}
.notif-x:hover{background:var(--bga);color:var(--ta)}
#tab-row{display:flex;align-items:flex-end;height:${TAB_BAR_HEIGHT}px;flex:0 0 ${TAB_BAR_HEIGHT}px;border-bottom:1px solid var(--bd);-webkit-app-region:drag}
.menu-btn{-webkit-app-region:no-drag;width:30px;height:30px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;color:var(--ta);border-radius:8px;margin:0 2px 6px 6px;flex-shrink:0;
  transition:background .15s,color .15s,border-color .15s;border:1px solid transparent;opacity:.85}
.menu-btn:hover{background:color-mix(in srgb,var(--ac-from) 12%,transparent);
  border-color:color-mix(in srgb,var(--ac-from) 35%,transparent);color:var(--ac-from);opacity:1}
.menu-btn svg{width:16px;height:16px}
#tabs{display:flex;align-items:flex-end;height:100%;flex:1;padding:0 4px;gap:2px;
  -webkit-app-region:no-drag;overflow-x:auto;min-width:0}
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
<div id="notif-bar"></div>
<div id="tab-row">
<div class="menu-btn" id="app-menu" title="${t('Menü', 'Menu')}">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
</div>
<div id="tabs"></div>
<div class="controls">
  <div class="design-pill" id="design-toggle" title="${t('Design wechseln', 'Toggle design')}">${customDesign ? 'Modern' : 'Classic'}</div>
  <div class="ctrl-btn" id="export-btn" title="${t('Konversation als Markdown exportieren', 'Export conversation as Markdown')}">
    <svg viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </div>
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
</div>
<script>
const tabsEl=document.getElementById('tabs');
let tabEls=[];
document.getElementById('new-tab').addEventListener('click',()=>window.tabAPI.newTab());
document.getElementById('theme-toggle').addEventListener('click',()=>window.tabAPI.toggleTheme());
document.getElementById('design-toggle').addEventListener('click',()=>window.tabAPI.toggleDesign());
document.getElementById('bug-report').addEventListener('click',()=>window.tabAPI.bugReport());
document.getElementById('export-btn').addEventListener('click',()=>window.tabAPI.exportConversation());
document.getElementById('app-menu').addEventListener('click',(e)=>{
  const r=e.currentTarget.getBoundingClientRect();
  window.tabAPI.openAppMenu(Math.round(r.left),Math.round(r.bottom));
});

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
  document.body.style.background='';
  document.getElementById('theme-icon-dark').style.display=dark?'':'none';
  document.getElementById('theme-icon-light').style.display=dark?'none':'';
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
      (n.link?'<button class="notif-link" data-act="link">'+escTxt(n.linkLabel||'Mehr')+'</button>':'')+
      (n.dismissible!==false?'<button class="notif-x" data-act="dismiss" title="Schließen">×</button>':'');
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
  wc.executeJavaScript(NOTIFY_SCRIPT).catch(() => {});
}

function reinjectScripts(wc) {
  if (!alive(wc)) return;
  // Brand-Script nur bei custom design re-injecten
  if (customDesign) {
    wc.executeJavaScript('!!window._cdBrand').then(active => {
      if (!active) wc.executeJavaScript(BRAND_SCRIPT).catch(() => {});
    }).catch(() => {});
  }
  // Notify-Script: idempotent, einfach prüfen
  wc.executeJavaScript('!!window._cdNotify').then(active => {
    if (!active) wc.executeJavaScript(NOTIFY_SCRIPT).catch(() => {});
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

  // ── OAuth-Popup Lifecycle (nur wenn das neue Fenster wirklich OAuth ist) ──
  wc.on('did-create-window', (childWindow, details) => {
    const initialUrl = details && details.url ? details.url : '';
    if (!isOAuthDomain(initialUrl)) return;

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
    if (!isAllowedDomain(navUrl) && !isOAuthDomain(navUrl)) {
      event.preventDefault();
      try {
        const p = new URL(navUrl).protocol;
        if (p === 'https:' || p === 'http:') shell.openExternal(navUrl);
      } catch {}
    }
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
  const nh = getNotificationBarHeight();
  const topInset = TAB_BAR_HEIGHT + nh;
  const key = `${b.width}:${b.height}:${nh}`;
  if (key === lastViewBounds) return;
  lastViewBounds = key;
  tabs[activeTabIndex].view.setBounds({ x: 0, y: topInset, width: b.width, height: Math.max(0, b.height - topInset) });
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
      const img = nativeImage.createFromPath(trayIcon());
      tray.setImage(img.isEmpty() ? trayIcon() : img);
    } catch {}
  }
  try { fs.copyFileSync(icon(), path.join(app.getPath('home'), 'Apps', 'claude-desktop-icon.png')); } catch {}

  // Pinned-Icon im Dock/Taskleiste mit-switchen (Linux: GNOME/Plasma lesen aus icon-theme)
  // Beta-Build überschreibt nur claude-desktop-beta.png, nicht das Stable-Icon
  if (process.platform === 'linux') {
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

// ═══════════════════════════════════════════════════════════════════
//  Bug-Report-Dialog
// ═══════════════════════════════════════════════════════════════════

const BUG_EMAIL = 'claudeai.desktop.linux@gmail.com';
const WEB3FORMS_ACCESS_KEY = '269ca388-8c7d-41e9-9063-2b6429a81b6b';
const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit';

function getAppMode() {
  if (process.env.APPIMAGE) return 'AppImage';
  if (process.env.SNAP) return 'Snap';
  if (!app.isPackaged) return 'Development';
  return 'Packaged';
}

function showBugReportDialog() {
  const s = { ...bugReportStrings.en, ...(bugReportStrings[sysLang] || {}) };
  const dark = isDarkMode;
  const bg = dark ? '#1a1a18' : '#faf8f6';
  const fg = dark ? '#e8e0d8' : '#2a2420';
  const sub = dark ? '#9a9a96' : '#8a7e72';
  const inputBg = dark ? '#252522' : '#ffffff';
  const inputBorder = dark ? '#3a3a36' : '#d8d0c8';
  const inputFocus = '#E8524F';
  const btnBg = '#E8524F';
  const btnHover = '#F0635C';
  const btnDisabled = dark ? '#3a3a36' : '#c8bfb6';
  const successColor = '#3da66a';

  const meta = {
    version: app.getVersion(),
    os: `${process.platform} ${process.arch} (${require('os').release()})`,
    locale: app.getLocale() || sysLang || 'unknown',
    mode: getAppMode()
  };

  const brSize = { width: 500, height: 660 };
  const brPos = centerOnMainWindow(brSize.width, brSize.height);
  const win = new BrowserWindow({
    ...brSize, ...brPos, resizable: false,
    parent: mainWindow, modal: true,
    title: s.title, icon: icon(),
    backgroundColor: bg,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  win.setMenuBarVisibility(false);

  const cfg = JSON.stringify({
    accessKey: WEB3FORMS_ACCESS_KEY,
    endpoint: WEB3FORMS_ENDPOINT,
    bugEmail: BUG_EMAIL,
    meta,
    strings: s
  });

  const html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https://api.web3forms.com;">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:${bg};color:${fg};font-family:system-ui,-apple-system,sans-serif;font-size:14px;
  display:flex;flex-direction:column;height:100vh;padding:24px;overflow:hidden}
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
.actions{display:flex;gap:10px;justify-content:flex-end;margin-top:auto;padding-top:8px}
button{border:none;padding:10px 20px;border-radius:9px;font-size:13.5px;cursor:pointer;
  font-weight:500;font-family:inherit;transition:background .15s,opacity .15s}
button.primary{background:${btnBg};color:#fff}
button.primary:hover:not(:disabled){background:${btnHover}}
button.primary:disabled{background:${btnDisabled};cursor:not-allowed}
button.secondary{background:transparent;color:${sub};border:1px solid ${inputBorder}}
button.secondary:hover{background:${inputBg};color:${fg}}
.honeypot{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.status{display:none;flex-direction:column;align-items:center;justify-content:center;
  height:100%;text-align:center;padding:20px}
.status.visible{display:flex}
.status .icon{font-size:42px;margin-bottom:14px;line-height:1}
.status h3{font-size:17px;font-weight:600;margin-bottom:8px}
.status p{color:${sub};font-size:13px;line-height:1.5;margin-bottom:18px;max-width:380px}
.status.success .icon{color:${successColor}}
.status .email{font-size:14px;font-weight:600;color:${fg};margin-bottom:14px;word-break:break-all;
  background:${inputBg};padding:8px 14px;border-radius:6px;border:1px solid ${inputBorder}}
.error-row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
</style></head><body>

<div id="form-view">
  <h2>${s.title}</h2>
  <p class="intro">${s.intro}</p>

  <form id="bugform" novalidate>
    <div class="field">
      <label for="desc">${s.descLabel}</label>
      <textarea id="desc" class="desc" required placeholder="${s.descPlaceholder}"></textarea>
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

    <div class="actions">
      <button type="button" class="secondary" id="cancel-btn">${s.cancelBtn}</button>
      <button type="submit" class="primary" id="send-btn">${s.sendBtn}</button>
    </div>
  </form>
</div>

<div class="status success" id="success-view">
  <div class="icon">✓</div>
  <h3>${s.successTitle}</h3>
  <p>${s.successMsg}</p>
  <button class="primary" onclick="window.close()">${s.closeBtn}</button>
</div>

<div class="status" id="error-view">
  <div class="icon" style="color:${btnBg}">✕</div>
  <h3>${s.errorTitle}</h3>
  <p>${s.errorHint}</p>
  <div class="email" id="err-email"></div>
  <div class="error-row">
    <button class="secondary" onclick="window.close()">${s.closeBtn}</button>
    <button class="primary" id="copy-btn"></button>
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

  function showView(which) {
    formView.style.display = which === 'form' ? '' : 'none';
    successView.classList.toggle('visible', which === 'success');
    errorView.classList.toggle('visible', which === 'error');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const description = desc.value.trim();
    if (!description) { desc.focus(); return; }
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
      access_key: cfg.accessKey,
      subject: 'Claude Desktop Bug Report v' + meta.version,
      from_name: 'Claude Desktop App',
      message: bodyMessage,
      botcheck: ''
    };
    if (userEmail) payload.email = userEmail;

    try {
      const res = await fetch(cfg.endpoint, {
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
      sendBtn.disabled = false;
      sendBtn.textContent = cfg.strings.sendBtn;
    }
  });

  setTimeout(() => desc.focus(), 50);
})();
</script>
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
    hint: t('Enter zum Senden \u00b7 Shift+Enter neue Zeile \u00b7 Esc abbrechen \u00b7 Tab Template', 'Enter to send \u00b7 Shift+Enter new line \u00b7 Esc to cancel \u00b7 Tab template'),
    noTemplate: t('Kein Template', 'No template'),
    templates: t('Template', 'Template')
  };
  const logoUrl = iconDataUrl();
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
  return 'failed';
}

// ── Feature 6: Clipboard → Chat ──────────────────────────────────
function openClipboardChat() {
  let text = '';
  try { text = clipboard.readText() || ''; } catch {}
  text = text.trim();
  if (!text) {
    new Notification({
      title: 'Claude',
      body: t('Zwischenablage ist leer.', 'Clipboard is empty.')
    }).show();
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
  return 'failed';
}

// ── Feature 4: Markdown-Export ───────────────────────────────────
async function exportActiveConversation() {
  const tab = tabs[activeTabIndex];
  if (!tab || !alive(tab.view)) return;
  const wc = tab.view.webContents;
  const url = wc.getURL();
  if (!/^https:\/\/(?:[a-z0-9-]+\.)?claude\.ai\//i.test(url)) {
    showCustomMessageBox({
      type: 'info', title: 'Claude',
      message: t('Export nur in claude.ai-Tabs verfügbar.', 'Export only available in claude.ai tabs.')
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
      message: t('Konnte keine Konversation finden.', 'Could not find a conversation on this page.'),
      detail: t('Stelle sicher, dass du in einem Chat bist (nicht auf der Übersicht).', 'Make sure you are inside a chat (not on the overview).')
    });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  let md = `# ${payload.title}\n\n`;
  md += `_${t('Quelle', 'Source')}: ${payload.url}_\n`;
  md += `_${t('Exportiert', 'Exported')}: ${today}_\n\n---\n\n`;
  for (const b of payload.blocks) {
    md += `## ${b.role === 'User' ? t('Du', 'You') : 'Claude'}\n\n${b.md}\n\n---\n\n`;
  }

  const safeName = payload.title.replace(/[^\w\s.-]+/g, '_').slice(0, 80) || 'claude-chat';
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('documents'), `${safeName}-${today}.md`),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: t('Alle Dateien', 'All Files'), extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return;
  fs.writeFile(result.filePath, md, 'utf8', (err) => {
    if (err) {
      showCustomMessageBox({
        type: 'error', title: t('Export fehlgeschlagen', 'Export failed'),
        message: err.message || String(err)
      });
      return;
    }
    new Notification({
      title: t('Konversation exportiert', 'Conversation exported'),
      body: path.basename(result.filePath)
    }).show();
  });
}


function getSettingsHTML() {
  const th = theme();
  const ac = accent();
  const i18n = {
    title: t('Einstellungen', 'Settings'),
    subtitle: t('Hintergrund, Hotkeys, Templates', 'Background, hotkeys, templates'),
    secBackground: t('Hintergrund', 'Background'),
    secMicrophone: t('Mikrofon', 'Microphone'),
    secHotkeys: t('Globale Hotkeys', 'Global hotkeys'),
    secTemplates: t('Prompt-Templates', 'Prompt templates'),
    minimizeLabel: t('Beim Schlie\u00dfen in den Hintergrund minimieren', 'Minimize to tray on close'),
    minimizeHint: t('Claude bleibt im Hintergrund erreichbar \u2013 \u00fcber das Tray-Symbol oder die Hotkeys unten.', 'Claude stays reachable in the background \u2013 via the tray icon or the hotkeys below.'),
    autostartLabel: t('Beim Anmelden automatisch starten', 'Start automatically at login'),
    autostartHint: t('Claude startet beim Hochfahren des Systems automatisch.', 'Claude launches automatically when the system starts.'),
    autostartFailed: t('Autostart konnte nicht aktiviert werden.', 'Could not enable autostart.'),
    bgNotifLabel: t('Antwort-Benachrichtigung f\u00fcr Hintergrund-Tabs', 'Notify when a background tab finishes a response'),
    bgNotifHint: t('Native Notification, sobald Claude in einem nicht aktiven Tab fertig geantwortet hat.', 'Native notification once Claude finishes a response in a tab you\u2019re not currently looking at.'),
    micLabel: t('Mikrofon-Zugriff erlauben', 'Allow microphone access'),
    micHint: t('Erlaubt Claude, dein Mikrofon f\u00fcr Spracheingaben zu nutzen. Beim ersten Klick auf das Mikrofon-Symbol fragt die App einmal nach \u2013 die Auswahl kannst du hier jederzeit \u00e4ndern.', 'Lets Claude use your microphone for voice input. The app asks once the first time you click the microphone icon \u2013 you can change your choice here at any time.'),
    micSnapHint: t('Auf Snap muss das Mikrofon einmalig freigegeben werden. Entweder im Snap-Store \u00f6ffnen und \u201eAudio Record" aktivieren \u2013 oder den Befehl unten im Terminal ausf\u00fchren.', 'On Snap the microphone must be enabled once. Either open the Snap Store and enable \u201cAudio Record\u201d \u2013 or run the command below in a terminal.'),
    micSnapButton: t('Im Snap-Store \u00f6ffnen', 'Open in Snap Store'),
    micSnapCmdLabel: t('Oder im Terminal:', 'Or in a terminal:'),
    micSnapCmdCopy: t('Befehl kopieren', 'Copy command'),
    micSnapCmdCopied: t('Kopiert \u2713', 'Copied \u2713'),
    micResetLabel: t('Erneut fragen beim n\u00e4chsten Mikrofon-Klick', 'Ask again on next microphone click'),
    micResetDone: t('Erledigt \u2013 Dialog erscheint beim n\u00e4chsten Mikrofon-Klick wieder.', 'Done \u2013 dialog will appear again on next microphone click.'),
    micResetHint: t('Verwirft die letzte Auswahl, sodass der Hinweis-Dialog beim n\u00e4chsten Mikrofon-Zugriff wieder erscheint.', 'Discards the last choice so the consent dialog appears again on the next microphone request.'),
    hotkeyQp: t('Neuer Chat (Quick-Prompt)', 'New chat (Quick-Prompt)'),
    hotkeyClip: t('Zwischenablage als Prompt einf\u00fcgen', 'Send clipboard text as new prompt'),
    press: t('Klick hier und dr\u00fccke eine Tastenkombination', 'Click here and press a key combination'),
    pressing: t('Dr\u00fccke die gew\u00fcnschte Tastenkombination\u2026', 'Press your key combination\u2026'),
    clear: t('L\u00f6schen', 'Clear'),
    close: t('Schlie\u00dfen', 'Close'),
    registered: t('Hotkey registriert.', 'Hotkey registered.'),
    failed: t('Diese Kombination konnte nicht registriert werden – evtl. systemweit belegt.', 'Could not register this combination — likely already in use system-wide.'),
    conflictQp: t('Diese Kombination ist bereits dem Quick-Prompt-Hotkey zugewiesen.', 'This combination is already assigned to the Quick-Prompt hotkey.'),
    conflictClip: t('Diese Kombination ist bereits dem Clipboard-Hotkey zugewiesen.', 'This combination is already assigned to the Clipboard hotkey.'),
    removed: t('Hotkey entfernt.', 'Hotkey removed.'),
    needMod: t('Bitte mindestens eine Modifikator-Taste (Strg/Alt/Shift) verwenden.', 'Please use at least one modifier key (Ctrl/Alt/Shift).'),
    tplEmpty: t('Noch keine Templates. F\u00fcgst du eines hinzu, erscheint es im Quick-Prompt-Fenster als Auswahl.', 'No templates yet. Once added, they appear as a picker in the Quick-Prompt window.'),
    tplName: t('Name (z.B. \u201e\u00dcbersetze")', 'Name (e.g. \u201eTranslate")'),
    tplPrefix: t('Prefix-Text (wird vor deinem Input eingef\u00fcgt)', 'Prefix text (prepended to your input)'),
    tplAdd: t('Hinzuf\u00fcgen', 'Add'),
    tplDelete: t('L\u00f6schen', 'Delete'),
    tplLimit: t('Maximal 50 Templates.', 'Maximum 50 templates.'),
    tplDup: t('Name existiert bereits.', 'A template with that name already exists.')
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
button{background:linear-gradient(135deg,${ac.from},${ac.to});color:#fff;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:12.5px;font-weight:500;font-family:inherit}
button.secondary{background:${th.bgHover};color:${th.textActive};border:1px solid ${th.border}}
button.danger{background:transparent;color:${th.text};border:1px solid ${th.border};padding:5px 10px;font-size:11.5px}
button.danger:hover{color:#e05e3e;border-color:#e05e3e}
button:hover{filter:brightness(1.05)}
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
</style></head><body>
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
const micSnapOpen = document.getElementById('mic-snap-open');
const micSnapCopy = document.getElementById('mic-snap-copy');
let micSnapCopyTimer = null;
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
mic.addEventListener('change', () => api.setMicrophone(mic.checked));
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
  if (s.isSnap) {
    micSnapHint.style.display = '';
    micSnapActions.style.display = '';
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !listeningKey && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') api.close();
});
</script>
</body></html>`;
}

function getWhatsNewHTML() {
  const th = theme();
  const ac = accent();
  const notes = getFilteredNotes(version, windowState.lastSeenVersion);
  const icons = {
    tray: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="3"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 2 4 14 12 14 11 22 20 10 12 10 13 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
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
.ix code{display:inline-block;margin:4px 0;padding:3px 7px;background:${th.bgHover};border:1px solid ${th.border};border-radius:4px;font-family:monospace;font-size:11px;color:${th.textActive};user-select:text}
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
  const pos = centerOnMainWindow(size.width, size.height);
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
  const swSize = { width: 540, height: 480 };
  const swPos = centerOnMainWindow(swSize.width, swSize.height);
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
//  Custom App-Menü (HTML-Popup statt OS-nativ)
// ═══════════════════════════════════════════════════════════════════

function getAppMenuItems() {
  const designLabel = `Design: ${customDesign ? 'Modern' : 'Classic'}`;
  return [
    { type: 'item', action: 'new-tab', label: t('Neuer Tab', 'New Tab'), accel: 'Ctrl+T', icon: 'plus' },
    { type: 'item', action: 'close-tab', label: t('Tab schließen', 'Close Tab'), accel: 'Ctrl+W', icon: 'x' },
    { type: 'sep' },
    { type: 'item', action: 'export', label: t('Konversation exportieren…', 'Export conversation…'), accel: 'Ctrl+Shift+E', icon: 'download' },
    { type: 'item', action: 'reload', label: t('Neu laden', 'Reload'), accel: 'Ctrl+R', icon: 'refresh' },
    { type: 'sep' },
    { type: 'item', action: 'design-toggle', label: designLabel, icon: 'palette' },
    { type: 'item', action: 'settings', label: t('App-Einstellungen…', 'App Settings…'), accel: 'Ctrl+,', icon: 'cog' },
    { type: 'sep' },
    { type: 'item', action: 'check-updates', label: t('Nach Updates suchen…', 'Check for Updates…'), icon: 'refresh' },
    { type: 'item', action: 'bug-report', label: (bugReportStrings[sysLang] || bugReportStrings.en).title, icon: 'bug' },
    { type: 'sep' },
    { type: 'item', action: 'quit', label: t('Beenden', 'Quit'), accel: 'Ctrl+Q', icon: 'power' }
  ];
}

function getAppMenuHTML() {
  const th = theme();
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
  border-bottom:1px solid ${th.border};
  background:linear-gradient(180deg,color-mix(in srgb,${ac.from} 6%,transparent),transparent)}
.head .logo{width:28px;height:28px;flex-shrink:0;border-radius:7px;object-fit:contain;
  filter:drop-shadow(0 1px 4px color-mix(in srgb,${ac.from} 40%,transparent))}
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
    <img class="logo" src="${iconDataUrl()}" alt="Claude" draggable="false"/>
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
    appMenuWindow.close();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const items = getAppMenuItems();
  // Höhe: Header ~52px + Items 30px + Separators 11px + 18px card-padding/border + 16px body-padding
  const itemH = 30, sepH = 11, headerH = 52;
  let height = 18 + 16 + headerH;
  for (const it of items) height += (it.type === 'sep' ? sepH : itemH);
  const width = 280;

  const cb = mainWindow.getContentBounds();
  const screenX = cb.x + (Number.isFinite(rendererX) ? Math.round(rendererX) : 0);
  const screenY = cb.y + (Number.isFinite(rendererY) ? Math.round(rendererY) : TAB_BAR_HEIGHT);

  appMenuWindow = new BrowserWindow({
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
  });
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

// ═══════════════════════════════════════════════════════════════════
//  Custom MessageBox – zentriert über der App statt GTK-nativ
// ═══════════════════════════════════════════════════════════════════

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
    const finish = (index) => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners(channel);
      resolve({ response: typeof index === 'number' ? index : cancelId });
    };

    const size = { width: 480, height: detail ? 260 : 200 };
    const pos = centerOnMainWindow(size.width, size.height);
    const parentWin = (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) ? mainWindow : undefined;

    const win = new BrowserWindow({
      ...size, ...pos,
      parent: parentWin,
      modal: !!parentWin,
      resizable: false, minimizable: false, maximizable: false,
      title,
      backgroundColor: theme().bg,
      icon: icon(),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload-messagebox.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        spellcheck: false
      }
    });
    win.setMenu(null);

    ipcMain.once(channel, (_, index) => {
      finish(index);
      if (!win.isDestroyed()) win.close();
    });

    win.on('closed', () => finish(cancelId));

    const html = getMessageBoxHTML({ type, title, message, detail, buttons, defaultId, cancelId, channel });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

function getMessageBoxHTML({ type, title, message, detail, buttons, defaultId, cancelId, channel }) {
  const th = theme();
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
        { label: t('Konversation als Markdown exportieren\u2026', 'Export conversation as Markdown\u2026'), accelerator: 'CmdOrCtrl+Shift+E', click: () => exportActiveConversation() },
        { type: 'separator' },
        { label: t('Einstellungen', 'Settings'), accelerator: 'CmdOrCtrl+,', click: () => {
          if (tabs[activeTabIndex] && alive(tabs[activeTabIndex].view))
            tabs[activeTabIndex].view.webContents.loadURL('https://claude.ai/settings');
        }},
        { label: t('App-Einstellungen\u2026', 'App Settings\u2026'), click: () => openSettingsWindow() },
        { type: 'separator' },
        { label: `Design: ${customDesign ? 'Modern' : 'Classic'}`, click: toggleDesign },
        { label: t('Nach Updates suchen\u2026', 'Check for Updates\u2026'), click: () => {
          if (isDev) {
            showCustomMessageBox({ type: 'info', title: 'Claude', message: t('Updates sind im Entwicklungsmodus deaktiviert.', 'Updates are disabled in development mode.') });
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
          catch (e2) { console.error(`[DL] move failed: ${e2.message}`); }
        }
        new Notification({
          title: ok ? t('Download fertig', 'Download complete') : t('Download fehlgeschlagen', 'Download failed'),
          body: fileName
        }).show();
      } else {
        try { fs.unlinkSync(tmpPath); } catch {}
        if (!cancelledByDialog && downloadState !== 'cancelled' && downloadState !== '') {
          new Notification({ title: t('Download fehlgeschlagen', 'Download failed'), body: fileName }).show();
        }
      }
      keys.forEach(dropKey);
    };

    dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: [{ name: t('Alle Dateien', 'All Files'), extensions: ['*'] }]
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
    if (isQuitting) return;
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      showCustomMessageBox({ type: 'info', title: t('Update verf\u00fcgbar', 'Update available'), message: `v${info.version} ${t('wird heruntergeladen\u2026', 'is downloading\u2026')}` });
    } else {
      new Notification({ title: t('Update verf\u00fcgbar', 'Update available'), body: `v${info.version} ${t('wird geladen\u2026', 'downloading\u2026')}` }).show();
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    failures = 0;
    if (isQuitting) return;
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      showCustomMessageBox({ type: 'info', title: t('Kein Update', 'No Update'), message: t('Du verwendest bereits die neueste Version.', 'You are already on the latest version.'), detail: `v${app.getVersion()}` });
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
      type: 'info', title: t('Update bereit', 'Update ready'),
      message: `v${info.version} ${t('heruntergeladen. Jetzt neu starten?', 'downloaded. Restart now?')}`,
      buttons: [t('Neu starten', 'Restart'), t('Sp\u00e4ter', 'Later')], defaultId: 0, cancelId: 1
    }).then(r => { if (!isQuitting && r.response === 0) autoUpdater.quitAndInstall(); });
  });

  autoUpdater.on('error', (err) => {
    failures++;
    if (isDev) console.error(`Update-Fehler (${failures}x):`, err.message);
    if (isQuitting) return;
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      const short = (err.message || '').split('\n')[0].slice(0, 200);
      showCustomMessageBox({ type: 'error', title: t('Update-Fehler', 'Update Error'), message: t('Update-Pr\u00fcfung fehlgeschlagen.', 'Update check failed.'), detail: short });
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

// Snap-Befehl, den der User im Terminal ausführen kann, falls keine GUI greift.
const SNAP_CONNECT_CMD = 'sudo snap connect claude-ai-desktop:audio-record';

// Versucht in Reihenfolge: snap-store → gnome-software → plasma-discover → xdg-open.
// Umgeht den xdg-open-Chooser-Dialog auf Systemen mit mehreren snap://-Handlern.
function openSnapStorePage() {
  if (!isSnap) {
    try { shell.openExternal('snap://claude-ai-desktop'); } catch {}
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
      try { shell.openExternal('snap://claude-ai-desktop'); } catch {}
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
function safeJson(v) {
  return JSON.stringify(v).replace(/<\/(script)/gi, '<\\/$1');
}

// Strikte claude.ai-Origin-Validierung — claudeusercontent.com (Artifact-iframes)
// soll für Mikrofon-Zugriff explizit AUSGESCHLOSSEN bleiben.
function isClaudeAiOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'claude.ai' || u.hostname.endsWith('.claude.ai');
  } catch { return false; }
}

// Gemeinsames CSS für Dialog-Fenster (showCustomMessageBox + requestMicrophoneConsent).
function sharedDialogCSS() {
  const th = theme();
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

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      ipcMain.removeAllListeners(respondChannel);
      ipcMain.removeAllListeners(snapOpenChannel);
      ipcMain.removeAllListeners(copyCmdChannel);
      resolve(reason);
    };

    const size = { width: 520, height: showSnapPanel ? 480 : 240 };
    const pos = centerOnMainWindow(size.width, size.height);
    const parentWin = (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) ? mainWindow : undefined;

    const win = new BrowserWindow({
      ...size, ...pos,
      parent: parentWin,
      modal: !!parentWin,
      resizable: false, minimizable: false, maximizable: false,
      title: t('Mikrofon-Zugriff', 'Microphone access'),
      backgroundColor: theme().bg,
      icon: icon(),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload-messagebox.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        spellcheck: false
      }
    });
    win.setMenu(null);

    ipcMain.once(respondChannel, (_, idx) => {
      finish(idx === 0 ? 'granted' : 'denied');
      if (!win.isDestroyed()) win.close();
    });

    ipcMain.on(snapOpenChannel, () => openSnapStorePage());
    ipcMain.on(copyCmdChannel, () => { try { clipboard.writeText(SNAP_CONNECT_CMD); } catch {} });

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
  const th = theme();
  const ac = accent();
  const i18n = {
    title: t('Mikrofon-Zugriff', 'Microphone access'),
    message: t(
      'Claude Desktop möchte auf dein Mikrofon zugreifen, um Spracheingaben zu ermöglichen.',
      'Claude Desktop wants to access your microphone to enable voice input.'
    ),
    hint: t(
      'Du kannst diese Erlaubnis jederzeit in den App-Einstellungen unter „Mikrofon" widerrufen.',
      'You can revoke this permission anytime in the app settings under “Microphone”.'
    ),
    snapTitle: t('Snap-Berechtigung', 'Snap permission'),
    snapConnected: t('Verbunden', 'Connected'),
    snapDisconnected: t('Nicht verbunden', 'Not connected'),
    snapUnknown: t('Status wird geprüft…', 'Checking status…'),
    snapButton: t('Im Snap-Store öffnen', 'Open in Snap Store'),
    snapButtonHint: t(
      'Öffnet die Snap-Detailseite. Dort auf „Permissions" → „Audio Record" aktivieren – dieser Dialog erkennt es automatisch.',
      'Opens the Snap detail page. Go to “Permissions” → enable “Audio Record” – this dialog detects it automatically.'
    ),
    snapOrCmd: t('Oder im Terminal ausführen:', 'Or run in a terminal:'),
    snapCmdCopy: t('Befehl kopieren', 'Copy command'),
    snapCmdCopied: t('Kopiert ✓', 'Copied ✓'),
    snapNeedConnect: t('Aktiviere zuerst die Snap-Berechtigung, um „Erlauben" auszuwählen.', 'Enable the Snap permission first to choose “Allow”.'),
    allow: t('Erlauben', 'Allow'),
    deny: t('Ablehnen', 'Deny')
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
    const apply = (s) => {
      snapPanel.dataset.status = s;
      statusText.textContent = labels[s] || labels.unknown;
      setAllowEnabled(s === 'connected');
    };
    apply(snapPanel.dataset.status || 'unknown');
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

// ═══════════════════════════════════════════════════════════════════
//  Live Notifications (GitHub-hosted JSON, polled + on-demand)
// ═══════════════════════════════════════════════════════════════════

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
    if (typeof n.minVersion === 'string' && compareVersions(version, n.minVersion) < 0) continue;
    if (typeof n.maxVersion === 'string' && compareVersions(version, n.maxVersion) > 0) continue;
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

  let consentInflight = null;
  ses.setPermissionRequestHandler((_, perm, cb, details) => {
    if (perm === 'media') {
      // Mikrofon nur für claude.ai zulassen — claudeusercontent.com (Artifact-iframes)
      // explizit ausschließen, damit User-generierter Code keinen Mic-Zugriff erbt.
      if (!isClaudeAiOrigin(details && details.requestingUrl)) return cb(false);
      const wantsAudio = !details || !details.mediaTypes || details.mediaTypes.includes('audio');
      if (!wantsAudio) return cb(false);
      if (microphoneEnabled) return cb(true);
      if (microphoneConsentAsked) return cb(false);
      if (consentInflight) { consentInflight.then(v => cb(v)); return; }
      consentInflight = requestMicrophoneConsent().then(reason => {
        if (reason !== 'dismissed') {
          microphoneConsentAsked = true;
          microphoneEnabled = reason === 'granted';
          saveWindowState();
        }
        return reason === 'granted';
      }).catch(() => false).finally(() => { consentInflight = null; });
      consentInflight.then(v => cb(v));
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
const HOTKEY_RE = /^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\+)*[A-Za-z0-9]+$|^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\+)*(?:F1[0-9]?|F20|F[1-9]|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaPlayPause|PrintScreen|numdec|numadd|numsub|nummult|numdiv|num[0-9])$/;

function validateAccelerator(accel) {
  if (typeof accel !== 'string' || accel.length === 0 || accel.length >= 64) return null;
  return HOTKEY_RE.test(accel) ? accel : null;
}

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
  try { shell.openExternal(url); } catch {}
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
    : t('Antwort fertig', 'Response ready');
  try {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => {
      showMainWindow();
      if (idx >= 0 && idx < tabs.length) switchToTab(idx);
    });
    n.show();
  } catch {}
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
ipcMain.on('export-conversation', () => exportActiveConversation());
ipcMain.on('app-menu-popup', (_event, x, y) => {
  if (Date.now() - appMenuJustClosedAt < 250) return;
  openAppMenuWindow(x, y);
});
ipcMain.on('appmenu-action', (event, name) => {
  if (appMenuWindow && !appMenuWindow.isDestroyed() && event.sender === appMenuWindow.webContents) {
    appMenuWindow.close();
  }
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
      if (isDev) {
        showCustomMessageBox({ type: 'info', title: 'Claude', message: t('Updates sind im Entwicklungsmodus deaktiviert.', 'Updates are disabled in development mode.') });
      } else {
        manualUpdateCheck = true;
        autoUpdater.checkForUpdates().catch(() => {});
      }
      break;
    case 'bug-report': showBugReportDialog(); break;
    case 'quit': isQuitting = true; app.quit(); break;
  }
});
ipcMain.on('appmenu-close', (event) => {
  if (appMenuWindow && !appMenuWindow.isDestroyed() && event.sender === appMenuWindow.webContents) {
    appMenuWindow.close();
  }
});
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
    autoHideMenuBar: true,
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

// Web3Forms blockiert Requests ohne Browser-Origin (data:-URLs senden Origin: null,
// was Web3Forms als "Server-Side"-Aufruf einstuft und mit "Pro plan required" ablehnt).
// Fix: für api.web3forms.com setzen wir Origin/Referer auf die im Dashboard registrierte Domain.
function setupWeb3FormsHeaderRewrite() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://api.web3forms.com/*'] },
    (details, cb) => {
      const h = details.requestHeaders;
      h['Origin'] = 'https://localhost';
      h['Referer'] = 'https://localhost/';
      cb({ requestHeaders: h });
    }
  );
}

app.whenReady().then(() => {
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
