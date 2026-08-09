'use strict';
// Pure utility functions, frei von Electron-Abhaengigkeiten.
// Werden von main.js requirt UND von node --test getestet.

// Vergleicht Semver-aehnliche Versionen mit optionalem Pre-Release-Suffix.
// 1.3.0-beta.1 < 1.3.0 < 1.3.1
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

// JSON.stringify mit Escape von </script-Sequenzen, damit der Output sicher
// inline in <script>...</script> einbettbar ist.
function safeJson(v) {
  return JSON.stringify(v).replace(/<\/(script)/gi, '<\\/$1');
}

// Strikte claude.ai-Origin-Validierung. claudeusercontent.com (Artifact-iframes)
// muss explizit AUSGESCHLOSSEN bleiben (z.B. fuer Mic-Permission).
function isClaudeAiOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'claude.ai' || u.hostname.endsWith('.claude.ai');
  } catch { return false; }
}

// Frames, die der Bezahlvorgang auf claude.ai braucht. Stripe rendert seine gesamte UI
// in eigene iframes; ohne diese Freigabe bricht der Subframe-Guard sie ab und das
// Kartenformular bleibt als pulsierender Platzhalter stehen. Alle bis auf hooks.stripe.com
// sind am echten Formular gemessen, hooks traegt die 3DS-Challenge nach dem Absenden.
// pay.google.com ist die Google-Pay-Option, ohne sie fehlt eine Zahlungsart.
// Exakter Hostname-Vergleich, kein endsWith: eine Subdomain-Regel wuerde hier auch
// angreiferkontrollierte Hosts unter denselben Domains einschliessen.
const PAYMENT_FRAME_HOSTS = new Set([
  'js.stripe.com', 'm.stripe.network', 'b.stripecdn.com',
  'newassets.hcaptcha.com', 'hooks.stripe.com', 'pay.google.com'
]);

function isPaymentFrameDomain(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && PAYMENT_FRAME_HOSTS.has(u.hostname);
  } catch { return false; }
}

const HOTKEY_RE = /^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\+)*[A-Za-z0-9]+$|^(?:(?:Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)\+)*(?:F1[0-9]?|F20|F[1-9]|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaPlayPause|PrintScreen|numdec|numadd|numsub|nummult|numdiv|num[0-9])$/;

function validateAccelerator(accel) {
  if (typeof accel !== 'string' || accel.length === 0 || accel.length >= 64) return null;
  return HOTKEY_RE.test(accel) ? accel : null;
}

module.exports = { compareVersions, safeJson, isClaudeAiOrigin, isPaymentFrameDomain, validateAccelerator, HOTKEY_RE };
