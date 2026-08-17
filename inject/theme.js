(function () {
  // Zentraler Theme-Controller. Loest brand.js + oled.js ab. Alle Theme-Regeln liegen
  // gescoped in EINEM Stylesheet, gesteuert ueber data-cd-* Attribute am <html>.
  // Umschalten = Attribut wechseln (window._cdSetTheme), kein Disable/Re-Inject.

  var st = window._cdTheme || { mode: 'dark', design: 'modern', accent: { from: '#F26A3F', to: '#E83B6E', mid: '#E8524F' } };

  // ---------- Farb-Helfer ----------

  function parseRGB(s) {
    if (!s) return null;
    s = s.trim();
    if (s[0] === '#') {
      var h = s.substring(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (h.length !== 6) return null;
      var n = parseInt(h, 16);
      if (isNaN(n)) return null;
      return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    }
    var i = s.indexOf('rgb');
    if (i >= 0) {
      var a = s.indexOf('(', i), b = s.indexOf(')', a);
      if (a < 0 || b < 0) return null;
      var p = s.substring(a + 1, b).split(/[\s,/]+/).filter(Boolean);
      if (p.length < 3) return null;
      var r = parseInt(p[0]), g = parseInt(p[1]), bl = parseInt(p[2]);
      if (isNaN(r) || isNaN(g) || isNaN(bl)) return null;
      return [r, g, bl];
    }
    var hi = s.indexOf('hsl');
    if (hi >= 0) {
      var ha = s.indexOf('(', hi), hb = s.indexOf(')', ha);
      if (ha < 0 || hb < 0) return null;
      var hp = s.substring(ha + 1, hb).split(/[\s,/]+/).filter(Boolean);
      if (hp.length < 3) return null;
      var hh = parseFloat(hp[0]), hs = parseFloat(hp[1]) / 100, hl = parseFloat(hp[2]) / 100;
      if (isNaN(hh) || isNaN(hs) || isNaN(hl)) return null;
      var c = (1 - Math.abs(2 * hl - 1)) * hs;
      var hp6 = (hh / 60) % 6;
      var x = c * (1 - Math.abs(hp6 % 2 - 1));
      var m = hl - c / 2, rr = 0, gg = 0, bb = 0;
      if (hp6 < 1) { rr = c; gg = x; }
      else if (hp6 < 2) { rr = x; gg = c; }
      else if (hp6 < 3) { gg = c; bb = x; }
      else if (hp6 < 4) { gg = x; bb = c; }
      else if (hp6 < 5) { rr = x; bb = c; }
      else { rr = c; bb = x; }
      return [Math.round((rr + m) * 255), Math.round((gg + m) * 255), Math.round((bb + m) * 255)];
    }
    return null;
  }

  // parseRGB versteht nur Hex/rgb()/hsl(). Modernere Syntax (oklch(), lab(), color-mix() usw.,
  // Tailwind-v4-Standard fuer Custom Properties) waere sonst nie als Orange erkennbar. Ueber
  // getComputedStyle liesse sich das nicht robust normalisieren: neuere Chromium-Versionen geben
  // oklch()/color-mix() unveraendert zurueck statt auf rgb() zu normalisieren (empirisch geprueft,
  // Electron 41 / Chromium 146). Ein 1x1-Canvas rendert dagegen immer als sRGB-Pixel, unabhaengig
  // vom verwendeten Farbraum. Nur als Fallback genutzt (teurer als parseRGB), daher erst wenn die
  // schnelle Regex-Pruefung nichts findet.
  var _colorCtx = null;
  var COLOR_SENTINEL = [1, 2, 3];
  // Moderne Farbfunktionen, die parseRGB (nur Hex/rgb/hsl) nicht kann und die den
  // Canvas-Fallback rechtfertigen. color-mix vor color, damit die Alternation greift.
  var CD_COLORFN = /^\s*(oklch|oklab|lab|lch|hwb|color-mix|color)\(/i;
  function normalizeColor(v) {
    if (!_colorCtx) {
      var canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      _colorCtx = canvas.getContext('2d');
    }
    _colorCtx.fillStyle = '#' + COLOR_SENTINEL.map(function (n) { return ('0' + n.toString(16)).slice(-2); }).join('');
    _colorCtx.fillStyle = v;
    _colorCtx.fillRect(0, 0, 1, 1);
    var d = _colorCtx.getImageData(0, 0, 1, 1).data;
    if (d[0] === COLOR_SENTINEL[0] && d[1] === COLOR_SENTINEL[1] && d[2] === COLOR_SENTINEL[2]) return null;
    return 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')';
  }

  function hexA(hex, alpha) {
    var c = parseRGB(hex);
    if (!c) return hex;
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
  }

  function isOrange(c) {
    return c[0] >= 175 && c[0] <= 235 && c[1] >= 75 && c[1] <= 135
      && c[2] >= 40 && c[2] <= 105 && c[0] - c[1] >= 55 && c[0] - c[2] >= 85;
  }

  function mapDark(c) {
    if (!c) return null;
    var sum = c[0] + c[1] + c[2];
    if (sum < 30) return '#030203';
    if (sum < 150) return '#050306';
    if (sum < 200) return '#120f12';
    if (sum < 260) return '#1c181b';
    if (sum < 330) return '#252023';
    if (sum < 400) return '#2c2528';
    return null;
  }

  // Gleiche Treppe wie mapDark, nur in Blau: dunkle Variablen der Seite auf die
  // Mitternachtsblau-Stufen ziehen, damit Tokens die das statische Sheet nicht erwischt
  // (Schatten, Raender, Inline-Flaechen) nicht als graue Inseln stehenbleiben.
  function mapMidnight(c) {
    if (!c) return null;
    var sum = c[0] + c[1] + c[2];
    if (sum < 30) return '#04070f';
    if (sum < 150) return '#070c18';
    if (sum < 200) return '#0d1526';
    if (sum < 260) return '#151f36';
    if (sum < 330) return '#1c2844';
    if (sum < 400) return '#233052';
    return null;
  }

  // Modi mit eigener Flaechenpalette. dark und light bekommen null: dark laeuft auf
  // claude.ais nativer Palette, light auf dem Invert-Filter, beide brauchen kein Remap.
  function surfaceMap(mode) {
    if (mode === 'oled') return mapDark;
    if (mode === 'midnight') return mapMidnight;
    return null;
  }

  // ---------- Surface-Luminanz (gegen Durchschlagen auf helle Sub-Apps) ----------
  // Misst die native Hintergrundhelligkeit, BEVOR OLED seinen eigenen bg setzt. Auf
  // hellen Seiten wird nie geschwaerzt -> Messung bleibt gueltig, keine Zirkularitaet.
  function measureSurface() {
    try {
      var el = document.body || document.documentElement;
      var c = parseRGB(getComputedStyle(el).backgroundColor);
      if (c) return (c[0] + c[1] + c[2]) < 360 ? 'dark' : 'light';
    } catch (e) {}
    return 'dark';
  }

  // ---------- Stylesheet-Helfer ----------

  function setSheet(id, css) {
    var sheet = document.getElementById(id);
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.id = id;
      (document.head || document.documentElement).appendChild(sheet);
    } else if (!sheet.isConnected) {
      (document.head || document.documentElement).appendChild(sheet);
    }
    // Identisches CSS nicht neu setzen: textContent-Rewrite reparst das Sheet und
    // erzwingt einen vollen Style-Recalc. Bei Reinject/SPA-Nav ist das Sheet meist
    // unveraendert, der Guard spart den Recalc.
    if (sheet.textContent === css) return;
    sheet.textContent = css;
  }

  // ---------- Attribute + Accent-Variablen ----------

  function applyAttrs() {
    var de = document.documentElement;
    // Das Anti-FOUC-Sheet aus dem Preload (preload-content.js) hat im OLED-Mode body schon
    // geschwaerzt. Es ENTFERNEN, bevor wir die Surface messen, sonst misst der Luminanz-Gate
    // das geschwaerzte body und OLED schlaegt faelschlich auf helle Sub-Apps durch. Der
    // Controller uebernimmt ab hier per cd-theme-static (gleicher synchroner Lauf, kein Repaint).
    var pre = document.getElementById('cd-theme-preload');
    if (pre && pre.parentNode) pre.parentNode.removeChild(pre);
    de.style.removeProperty('background-color');
    de.setAttribute('data-cd-surface', measureSurface());
    de.setAttribute('data-cd-theme', st.mode);
    de.setAttribute('data-cd-design', st.design);
    var ac = st.accent || {};
    de.style.setProperty('--cd-accent-from', ac.from || '#F26A3F');
    de.style.setProperty('--cd-accent-to', ac.to || '#E83B6E');
    // claude.ais eigener Brand-Ton faerbt unter anderem den Sende-Pfeil im Composer. Er muss
    // dem Theme folgen und beim Zurueckschalten wieder verschwinden, darum inline statt im
    // gecachten Variablen-Sheet. Nur als HSL-Komponenten schreiben: die Seite konsumiert das
    // als hsl(var(--accent-brand)), ein Hex-Wert macht die Deklaration ungueltig und die
    // Brand-Icons fallen auf Grau (deshalb steht die Variable auch in VAR_SKIP).
    var brand = ac.brandHsl;
    if (brand && /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(brand)) de.style.setProperty('--accent-brand', brand, 'important');
    else de.style.removeProperty('--accent-brand');
  }

  // ---------- Statisches Stylesheet (aus gemeinsamer Quelle) ----------
  // buildStaticCSS + sparkleBg liegen in inject/theme-static.js (window.cdThemeStatic),
  // damit main.js dasselbe Sheet fuer den document-start-Preload erzeugen kann und beide
  // nicht auseinanderlaufen. main prependet theme-static.js vor diesem Script.
  function buildStaticCSS() {
    return (window.cdThemeStatic && window.cdThemeStatic.buildStaticCSS)
      ? window.cdThemeStatic.buildStaticCSS(st) : '';
  }

  // ---------- Dynamische CSS-Variablen-Remaps (gescoped) ----------
  // Modern: orange Variablen -> Brand-Mid. OLED: dunkle Variablen -> dunkler (mapDark).
  var _varsKey = '';
  // Variablen, die claude.ai nicht als fertige Farbe konsumiert. Ein Hex-Wert macht dort
  // die Deklaration ungueltig, die Farbe faellt auf inherit zurueck und Brand-Icons
  // (z.B. der Stern im Greeting, .text-accent-brand + fill-current) werden grau statt
  // umgefaerbt. Gemessen: mit Override rgb(195,194,183), ohne rgb(217,119,87).
  // Diese Variablen daher nicht anfassen, das Recoloring laeuft ueber ACCENT_CLASS_CSS.
  var VAR_SKIP = { '--accent-brand': 1 };

  // Nummerierte Stufen einer Farbskala (--cds-red-350, --cds-orange-350, ...). Das
  // Brand-Recoloring ersetzt jede orange Variable durch EINEN Wert; bei einer Skala
  // faellt damit Stufe auf Stufe und benachbarte Toene werden ununterscheidbar. Im
  // Design-Feature, das eine eigene abgestufte Palette faehrt, sah man genau das.
  // Semantische Akzente (--om-accent-primary, --cds-clay, --qk-send-bg) haben keine
  // Stufennummer und werden weiterhin umgefaerbt.
  var VAR_SCALE_RE = /-\d{2,4}$/;

  function buildVarsCSS() {
    // Cache: nur neu scannen, wenn sich Design/Mode oder die Anzahl Stylesheets aendert
    // (Letzteres faengt nachgeladenes claude.ai-CSS ab). Spart teure Rescans.
    var key = st.design + '|' + st.mode + '|' + document.styleSheets.length;
    if (key === _varsKey && document.getElementById('cd-theme-vars')) return;
    _varsKey = key;
    var modern = '', oled = '', seenM = {}, mid = st.accent.mid || '#E8524F';
    var mapSurface = surfaceMap(st.mode);
    // Ein Token kann mehrfach definiert sein, hell unter :root und dunkel unter
    // [data-theme="dark"]. Die dunkle Definition ist die, die unter OLED wirklich gilt,
    // also muss sie gewinnen. Wert und Rang getrennt merken, damit eine dark-Definition
    // ein frueheres Mapping auch dann verdraengt, wenn mapDark sie gar nicht mappt.
    var oledVal = {}, oledRank = {};
    try {
      for (var i = 0; i < document.styleSheets.length; i++) {
        var cr;
        try { cr = document.styleSheets[i].cssRules; } catch (e) { continue; }
        if (!cr) continue;
        for (var j = 0; j < cr.length; j++) {
          var rule = cr[j];
          if (!rule.style || !rule.selectorText) continue;
          var sel = rule.selectorText;
          var isRoot = sel.indexOf(':root') >= 0 || sel.indexOf('.dark') >= 0
            || sel.indexOf('[data-theme') >= 0 || sel === 'html' || sel === 'body' || sel === '*';
          // Rang 1 = gilt nur im Dark-Kontext, Rang 0 = Basis. Unter OLED faehrt claude.ai
          // immer data-theme="dark", die Dark-Definition ist dort also die massgebliche.
          var rank = (sel.indexOf('.dark') >= 0 || sel.indexOf('data-theme="dark"') >= 0
            || sel.indexOf("data-theme='dark'") >= 0) ? 1 : 0;
          for (var k = 0; k < rule.style.length; k++) {
            var prop = rule.style[k];
            if (prop.indexOf('--') !== 0) continue;
            var val = rule.style.getPropertyValue(prop);
            var c = parseRGB(val);
            // Canvas-Fallback (GPU-Readback) nur fuer moderne Farbfunktionen, die parseRGB
            // nicht kennt. var()/calc()/cubic-bezier()/gradient/url() liefern ohnehin kein
            // Pixel (ungueltiges fillStyle -> null); frueher liefen dafuer hunderte
            // verschwendete Readbacks pro Scan.
            if (!c && CD_COLORFN.test(val)) c = parseRGB(normalizeColor(val));
            if (!c) continue;
            // Brand-Recoloring (orange -> Brand-Rot) im Light-Mode NICHT anwenden,
            // sonst wirkt das warme Weiss roetlich. Nur Dark/OLED.
            if (st.design === 'modern' && st.mode !== 'light' && !seenM[prop] && isOrange(c)
                && !VAR_SKIP[prop] && !VAR_SCALE_RE.test(prop)) {
              modern += prop + ':' + mid + ' !important;';
              seenM[prop] = true;
            }
            if (mapSurface && isRoot && (oledRank[prop] === undefined || rank >= oledRank[prop])) {
              oledVal[prop] = mapSurface(c);
              oledRank[prop] = rank;
            }
          }
        }
      }
    } catch (e) {}
    for (var p in oledVal) if (oledVal[p]) oled += p + ':' + oledVal[p] + ' !important;';
    var css = '';
    if (modern) css += 'html[data-cd-design="modern"]{' + modern + '}';
    // Ersatz fuer das ausgelassene --accent-brand: die Utility-Klasse direkt einfaerben.
    // color statt fill, weil die Icons per fill-current/currentColor erben.
    // Anders als der Variablen-Scan darueber gilt das auch im Hell-Modus: hier faerbt sich
    // nur eine Icon-Utility, keine Flaeche, das warme Weiss bleibt also warm.
    if (st.design === 'modern')
      css += 'html[data-cd-design="modern"] .text-accent-brand{color:' + mid + ' !important}';
    if (oled) css += 'html[data-cd-theme="' + st.mode + '"][data-cd-surface="dark"]{' + oled + '}';
    setSheet('cd-theme-vars', css);
    // Im OLED/Modern leeres Scan-Ergebnis = claude.ai-CSS war noch nicht (ganz) geladen.
    // Cache-Key nicht festschreiben, damit der naechste applyAll/_cdSetTheme neu scannt.
    // Auf die Scan-Treffer pruefen, nicht auf css: die .text-accent-brand-Regel wird
    // unabhaengig vom Scan emittiert und wuerde den Rescan sonst faelschlich unterdruecken.
    if (!modern && !oled && (mapSurface || (st.design === 'modern' && st.mode !== 'light'))) _varsKey = '';
  }

  // ---------- Composer taggen ----------

  function findComposerFieldset() {
    var inputs = document.querySelectorAll('[contenteditable="true"], .ProseMirror, textarea');
    for (var i = 0; i < inputs.length; i++) {
      var node = inputs[i];
      for (var d = 0; d < 10 && node; d++) {
        node = node.parentElement;
        if (node && node.tagName === 'FIELDSET' && !node.querySelector('fieldset')) return node;
      }
    }
    return null;
  }
  function tagComposer() {
    var fs = findComposerFieldset();
    var prev = document.querySelector('.cd-composer');
    if (prev && prev !== fs) { prev.classList.remove('cd-composer'); prev.style.removeProperty('--cd-composer-radius'); }
    if (fs) {
      if (!fs.classList.contains('cd-composer')) fs.classList.add('cd-composer');
      try {
        var br = parseFloat(getComputedStyle(fs).borderRadius) || 0;
        // claude.ai legt die sichtbare Rundung auf ein inneres DIV, das Fieldset selbst hat
        // 0 (gemessen: aussen 0px, innen 20px). Ohne diese Suche faellt der Ring auf den
        // 12px-Default und sitzt sichtbar neben den Ecken der Eingabe.
        if (!br) {
          var kids = fs.querySelectorAll('*');
          for (var i = 0; i < kids.length; i++) {
            if (kids[i].offsetWidth < fs.offsetWidth - 4) continue;
            var kb = parseFloat(getComputedStyle(kids[i]).borderRadius) || 0;
            if (kb) { br = kb; break; }
          }
        }
        fs.style.setProperty('--cd-composer-radius', ((br || 12) + 2) + 'px');
      } catch (e) {}
    }
  }

  // Ersetzt die frueheren body:has(...)-Regeln: ein einziges querySelector pro
  // gedrosseltem Mutations-Batch (nur OLED) statt :has()-Auswertung bei jedem
  // Style-Recalc. Setzt data-cd-modal am <html>, worauf das statische Sheet reagiert.
  function updateModalFlag() {
    var de = document.documentElement;
    if (st.mode !== 'oled') { if (de.hasAttribute('data-cd-modal')) de.removeAttribute('data-cd-modal'); return; }
    var open = !!document.querySelector('[role="dialog"],[aria-modal="true"]');
    if (open === de.hasAttribute('data-cd-modal')) return;
    if (open) de.setAttribute('data-cd-modal', ''); else de.removeAttribute('data-cd-modal');
  }

  // ---------- Modern: orange SVGs recoloren ----------

  function recolorEl(el) {
    if (el._cdDone) return;
    try {
      var cs = getComputedStyle(el), mid = st.accent.mid || '#E8524F';
      var f = parseRGB(cs.fill);
      var s = parseRGB(cs.stroke);
      if ((f && isOrange(f)) || (s && isOrange(s))) {
        if (f && isOrange(f)) el.style.fill = mid;
        if (s && isOrange(s)) el.style.stroke = mid;
        // Merken, damit der naechste Themewechsel die Inline-Farbe wieder loswird.
        el.setAttribute('data-cd-recolored', '');
      }
      el._cdDone = true;
    } catch (e) {}
  }

  // Der Recolor schreibt fill/stroke inline und markiert das Element als erledigt. Ohne
  // Ruecknahme behaelt ein Brand-Icon beim Themewechsel die alte Farbe: gemessen blieb der
  // Stern im Greeting nach OLED -> Mitternachtsblau rot, obwohl der Akzent blau ist.
  function clearRecolor() {
    var done = document.querySelectorAll('[data-cd-recolored]');
    for (var i = 0; i < done.length; i++) {
      done[i].style.removeProperty('fill');
      done[i].style.removeProperty('stroke');
      done[i].removeAttribute('data-cd-recolored');
      done[i]._cdDone = false;
    }
  }
  function recolorSVGs(root) {
    if (st.design !== 'modern' || !root || root.nodeType !== 1) return;
    var svgs = (root.tagName === 'svg' || root.tagName === 'SVG') ? [root] : root.querySelectorAll('svg');
    for (var i = 0; i < svgs.length; i++) {
      recolorEl(svgs[i]);
      var ch = svgs[i].querySelectorAll('*');
      for (var j = 0; j < ch.length; j++) recolorEl(ch[j]);
    }
  }

  // ---------- Anwenden / Umschalten ----------

  function idle(cb, ms) {
    if (window.requestIdleCallback) return window.requestIdleCallback(cb, { timeout: ms || 200 });
    return setTimeout(cb, 0);
  }
  // buildVarsCSS MUSS synchron laufen: gemessen kostet der Scan nur ~3ms, aber deferred
  // erscheint das Umfaerbe-Sheet erst ~1.5s nach dem Paint -> sichtbares Nachladen (Regression).
  // Nur recolorSVGs bleibt deferred (minderprioritaer: claude.ai hat praktisch keine
  // hardcoded-orange SVGs, gemessen orangeFound=0) und nur im Modern-Dark/OLED-Fall.
  function deferHeavy() {
    if (st.design !== 'modern') return;
    idle(function () { recolorSVGs(document.body); }, 200);
  }

  function applyAll() {
    applyAttrs();
    setSheet('cd-theme-static', buildStaticCSS());
    buildVarsCSS();
    tagComposer();
    updateModalFlag();
    deferHeavy();
  }

  window._cdSetTheme = function (next) {
    var changed = !next || !window._cdTheme || JSON.stringify(next) !== JSON.stringify(window._cdTheme);
    if (next && typeof next === 'object') {
      st = next;
      window._cdTheme = next;
    }
    if (changed) clearRecolor();
    applyAttrs();
    setSheet('cd-theme-static', buildStaticCSS());
    buildVarsCSS();
    tagComposer();
    updateModalFlag();
    deferHeavy();
  };

  function startObserver() {
    if (window._cdThemeObs) return;
    var pending = false;
    // SVG-Recolor (getComputedStyle, teuer) NICHT synchron im Mutations-Callback ausfuehren,
    // sonst Dauer-Recalc-Sturm waehrend ein Tab laedt. Stattdessen neue Subtrees sammeln und
    // gedrosselt im Idle abarbeiten. recolorEl ist via _cdDone idempotent.
    var svgRoots = [], svgScheduled = false;
    function flushSVG() {
      svgScheduled = false;
      var batch = svgRoots; svgRoots = [];
      for (var i = 0; i < batch.length; i++) {
        if (batch[i].isConnected) recolorSVGs(batch[i]);
      }
    }
    var ob = new MutationObserver(function (muts) {
      var wantSVG = (st.design === 'modern');
      var wantVars = (!!surfaceMap(st.mode) || wantSVG);
      var sheetsAdded = false;
      if (wantSVG || wantVars) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (wantSVG) {
              if (n.tagName === 'svg' || n.tagName === 'SVG') svgRoots.push(n);
              else if (n.querySelector && n.querySelector('svg')) svgRoots.push(n);
            }
            // claude.ai laedt CSS-Bundles lazy nach dom-ready nach. Neues STYLE/LINK ->
            // Variablen-Remap nachziehen, statt bis window.load zu warten (Kaltstart-Nachladen).
            if (wantVars && (n.tagName === 'STYLE' || n.tagName === 'LINK')) sheetsAdded = true;
          }
        }
        if (wantSVG && svgRoots.length && !svgScheduled) { svgScheduled = true; idle(flushSVG, 500); }
        // buildVarsCSS ist ueber styleSheets.length gecacht, rescant also nur bei echtem Zuwachs.
        if (sheetsAdded) buildVarsCSS();
      }
      // unsere Artefakte wiederherstellen, falls claude.ai sie entfernt
      if (!document.getElementById('cd-theme-static') || !document.getElementById('cd-theme-static').isConnected) setSheet('cd-theme-static', buildStaticCSS());
      // Modal-Flag direkt im Observer, NICHT im rAF: requestAnimationFrame pausiert bei
      // verdecktem/unsichtbarem Fenster, dann bliebe das Sternenfeld-Ausblenden aus. Der
      // MutationObserver laeuft dagegen auch dann. Frueher hielt die CSS-:has()-Regel das
      // immer, jetzt uebernimmt das dieser Aufruf. Billig: ein querySelector pro Batch, nur OLED.
      updateModalFlag();
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; tagComposer(); });
    });
    ob.observe(document.documentElement, { childList: true, subtree: true });
    window._cdThemeObs = ob;
  }

  function init() {
    if (window._cdThemeCtl) { window._cdSetTheme(st); return; }
    window._cdThemeCtl = true;
    applyAll();
    startObserver();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
