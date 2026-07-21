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
  }

  // ---------- Sternenfeld ----------
  // Fixe Positionen, damit Sterne beim Reload nicht springen. Reine radial-gradient-Dots.
  // Klassische 5-Punkt-Sterne in den Brand-Farben (passend zum Spark-Logo), als
  // gekacheltes SVG-Hintergrundbild. Hauch-duenn ueber niedrige Deckkraft. Nur OLED.
  function sparkUse(x, y, sc, op) {
    return "<use href='#s' transform='translate(" + x + "," + y + ") scale(" + sc + ")' opacity='" + op + "'/>";
  }
  function sparkleBg() {
    var f = (st.accent && st.accent.from) || '#F26A3F', t = (st.accent && st.accent.to) || '#E83B6E';
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='620' height='620' viewBox='0 0 620 620'>"
      + "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='" + f + "'/><stop offset='1' stop-color='" + t + "'/></linearGradient>"
      + "<path id='s' d='M0,-1 L.2245,-.309 L.951,-.309 L.363,.118 L.588,.809 L0,.382 L-.588,.809 L-.363,.118 L-.951,-.309 L-.2245,-.309 Z'/></defs>"
      + "<g fill='url(#g)'>"
      + sparkUse(110, 140, 11, .3) + sparkUse(430, 95, 7, .2) + sparkUse(540, 400, 9, .26)
      + sparkUse(230, 500, 6, .18) + sparkUse(580, 580, 5, .16) + sparkUse(300, 280, 8, .22)
      + "</g></svg>";
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  // ---------- Statisches Stylesheet (einmal, gescoped) ----------

  function buildStaticCSS() {
    var BG = '#050306', BG_HI = '#120f12';
    // OLED: Flaechen liegen alle unter 1.2:1 Kontrast -> auf near-black crush unsichtbar.
    // Trennung laeuft daher ueber 1px-Hairlines (Kante triggert, nicht Flaechenhelligkeit).
    var MENU_EDGE = 'rgba(232,82,79,0.12)', HAIR_DIM = 'rgba(255,255,255,0.07)', FOCUS = 'rgba(232,82,79,0.45)';
    var O = 'html[data-cd-theme="oled"][data-cd-surface="dark"]';
    var SPARK = sparkleBg();

    // [class*="X"] matcht auch Tailwinds Opacity-Modifier "X/NN" (z.B. eine helle 5%-Toenung
    // fuer einen Preis-Chip), die sonst faelschlich volldeckend geschwaerzt wird und ihren
    // eigenen (auf hell gedachten) Text unsichtbar macht. :not() schliesst genau diese Variante aus.
    function safeBg(tokens, color) {
      return tokens.map(function (t) {
        return O + ' [class*="' + t + '"]:not([class*="' + t + '/"])';
      }).join(',') + '{background-color:' + color + ' !important}';
    }

    return [
      // --- OLED: html schwarz (Fallback) ---
      O + '{background-color:' + BG + ' !important}',
      // body traegt das Sternen-Hintergrundbild (claude.ais Container darueber sind
      // transparent, scheinen also durch). Composer/Sidebar/Panels haben eigenen opaken
      // Hintergrund und decken die Sterne ab -> Sterne nur in leeren Flaechen sichtbar.
      O + ' body{background-color:' + BG + ' !important;background-image:' + SPARK + ' !important;background-size:620px 620px;background-attachment:fixed}',
      // Sterne ausblenden solange ein Modal offen ist, sonst schimmern sie unruhig durch den Backdrop.
      O + ' body:has([role="dialog"]),' + O + ' body:has([aria-modal="true"]){background-image:none !important}',
      O + ' #__next,' + O + ' #root,' + O + ' main,' + O + ' [role="main"]{background-color:transparent !important;background-image:none !important}',
      // undurchsichtige Flaechen decken die Sterne ab
      O + ' nav,' + O + ' aside,' + O + ' header,' + O + ' [class*="sidebar" i],' + O + ' [class*="Sidebar"],' + O + ' [class*="topbar" i],' + O + ' [class*="TopBar"]{background-color:' + BG + ' !important;background-image:none !important}',
      // Sidebar gegen den gleich-schwarzen Chatbereich abgrenzen (sonst Kante 1.0:1 = unsichtbar).
      O + ' nav,' + O + ' aside,' + O + ' [class*="sidebar" i],' + O + ' [class*="Sidebar"]{border-right:1px solid ' + HAIR_DIM + ' !important}',
      safeBg(['bg-bg-000', 'bg-bg-100', 'bg-bg-200'], BG),
      safeBg(['bg-bg-300', 'bg-bg-400'], BG_HI),
      safeBg(['bg-bg-500', 'bg-bg-600'], '#1a1517'),
      // claude.ais neuere surface-Tokens (z.B. Settings-Content bg-surface-2 = grau) ebenfalls schwaerzen.
      safeBg(['bg-surface-0', 'bg-surface-1'], BG),
      safeBg(['bg-surface-2', 'bg-surface-3'], BG_HI),
      safeBg(['bg-black', 'bg-neutral-900', 'bg-neutral-950', 'bg-zinc-900', 'bg-zinc-950', 'bg-gray-900', 'bg-gray-950', 'bg-stone-900', 'bg-stone-950', 'bg-slate-900', 'bg-slate-950'], BG),
      O + ' [class*="from-bg-"],' + O + ' [class*="to-bg-"],' + O + ' [class*="via-bg-"]{background-image:none !important}',
      O + ' header[class*="bg-"]{background-color:' + BG + ' !important;background-image:none !important}',
      // --- OLED: Navigation / Menues ---
      O + ' nav a,' + O + ' nav button,' + O + ' aside a,' + O + ' aside button,' + O + ' [class*="sidebar" i] a,' + O + ' [class*="sidebar" i] button,' + O + ' [class*="Sidebar"] a,' + O + ' [class*="Sidebar"] button{background-color:transparent !important;border-color:transparent !important;box-shadow:none !important}',
      O + ' nav a:hover,' + O + ' nav button:hover,' + O + ' aside a:hover,' + O + ' aside button:hover,' + O + ' [class*="sidebar" i] a:hover,' + O + ' [class*="sidebar" i] button:hover{background-color:#181417 !important}',
      O + ' nav [aria-current="page"],' + O + ' nav [data-state="active"],' + O + ' nav [aria-selected="true"],' + O + ' aside [aria-current="page"],' + O + ' aside [data-state="active"],' + O + ' aside [aria-selected="true"]{background-color:#1c181b !important}',
      O + ' [role="menu"],' + O + ' [role="dialog"],' + O + ' [role="listbox"],' + O + ' [role="tooltip"],' + O + ' [class*="opover"],' + O + ' [class*="ropdown"],' + O + ' [class*="enuContent"],' + O + ' [data-radix-popper-content-wrapper]>*{background-color:' + BG_HI + ' !important;background-image:none !important;border:1px solid ' + MENU_EDGE + ' !important;box-shadow:0 8px 28px rgba(0,0,0,0.6) !important}',
      O + ' [role="menu"] [role="menuitem"],' + O + ' [role="menu"] button,' + O + ' [role="menu"] a,' + O + ' [role="listbox"] [role="option"]{background-color:transparent !important;border-color:transparent !important}',
      O + ' [role="menu"] [role="menuitem"]:hover,' + O + ' [role="menu"] button:hover,' + O + ' [role="menu"] a:hover,' + O + ' [role="listbox"] [role="option"]:hover,' + O + ' [role="menuitem"][data-highlighted]{background-color:#1c181b !important}',
      O + ' input:focus,' + O + ' textarea:focus,' + O + ' [role="searchbox"]:focus,' + O + ' [role="combobox"]:focus{outline:1.5px solid ' + FOCUS + ' !important;outline-offset:2px !important}',
      // --- OLED: Composer-Gradient-Rand ---
      '@keyframes cdGradShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}',
      O + ' .cd-composer{position:relative;border-color:transparent !important;overflow:visible !important;background-color:' + BG + ' !important}',
      O + ' .cd-composer::before{content:"";position:absolute;inset:-2px;border-radius:var(--cd-composer-radius,14px);padding:2px;background:linear-gradient(135deg,var(--cd-accent-from),var(--cd-accent-to),var(--cd-accent-from),var(--cd-accent-to));background-size:300% 300%;animation:cdGradShift 6s ease-in-out infinite;-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;pointer-events:none;z-index:5}',
      ''
    ].join('');
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

  function buildVarsCSS() {
    // Cache: nur neu scannen, wenn sich Design/Mode oder die Anzahl Stylesheets aendert
    // (Letzteres faengt nachgeladenes claude.ai-CSS ab). Spart teure Rescans.
    var key = st.design + '|' + st.mode + '|' + document.styleSheets.length;
    if (key === _varsKey && document.getElementById('cd-theme-vars')) return;
    _varsKey = key;
    var modern = '', oled = '', seenM = {}, seenO = {}, mid = st.accent.mid || '#E8524F';
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
          for (var k = 0; k < rule.style.length; k++) {
            var prop = rule.style[k];
            if (prop.indexOf('--') !== 0) continue;
            var val = rule.style.getPropertyValue(prop);
            var c = parseRGB(val);
            if (!c && val.indexOf('(') >= 0) c = parseRGB(normalizeColor(val));
            if (!c) continue;
            // Brand-Recoloring (orange -> Brand-Rot) im Light-Mode NICHT anwenden,
            // sonst wirkt das warme Weiss roetlich. Nur Dark/OLED.
            if (st.design === 'modern' && st.mode !== 'light' && !seenM[prop] && isOrange(c) && !VAR_SKIP[prop]) {
              modern += prop + ':' + mid + ' !important;';
              seenM[prop] = true;
            }
            if (st.mode === 'oled' && isRoot && !seenO[prop]) {
              var m = mapDark(c);
              if (m) { oled += prop + ':' + m + ' !important;'; seenO[prop] = true; }
            }
          }
        }
      }
    } catch (e) {}
    var css = '';
    if (modern) css += 'html[data-cd-design="modern"]{' + modern + '}';
    // Ersatz fuer das ausgelassene --accent-brand: die Utility-Klasse direkt einfaerben.
    // color statt fill, weil die Icons per fill-current/currentColor erben.
    if (st.design === 'modern' && st.mode !== 'light')
      css += 'html[data-cd-design="modern"] .text-accent-brand{color:' + mid + ' !important}';
    if (oled) css += 'html[data-cd-theme="oled"][data-cd-surface="dark"]{' + oled + '}';
    setSheet('cd-theme-vars', css);
    // Im OLED/Modern leeres Scan-Ergebnis = claude.ai-CSS war noch nicht (ganz) geladen.
    // Cache-Key nicht festschreiben, damit der naechste applyAll/_cdSetTheme neu scannt.
    // Auf die Scan-Treffer pruefen, nicht auf css: die .text-accent-brand-Regel wird
    // unabhaengig vom Scan emittiert und wuerde den Rescan sonst faelschlich unterdruecken.
    if (!modern && !oled && (st.mode === 'oled' || st.design === 'modern')) _varsKey = '';
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
        var br = parseFloat(getComputedStyle(fs).borderRadius) || 12;
        fs.style.setProperty('--cd-composer-radius', (br + 2) + 'px');
      } catch (e) {}
    }
  }

  // ---------- Modern: orange SVGs recoloren ----------

  function recolorEl(el) {
    if (el._cdDone) return;
    try {
      var cs = getComputedStyle(el), mid = st.accent.mid || '#E8524F';
      var f = parseRGB(cs.fill); if (f && isOrange(f)) el.style.fill = mid;
      var s = parseRGB(cs.stroke); if (s && isOrange(s)) el.style.stroke = mid;
      el._cdDone = true;
    } catch (e) {}
  }
  function recolorSVGs(root) {
    if (st.design !== 'modern' || st.mode === 'light' || !root || root.nodeType !== 1) return;
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
    if (st.mode === 'light' || st.design !== 'modern') return;
    idle(function () { recolorSVGs(document.body); }, 200);
  }

  function applyAll() {
    applyAttrs();
    setSheet('cd-theme-static', buildStaticCSS());
    buildVarsCSS();
    tagComposer();
    deferHeavy();
  }

  window._cdSetTheme = function (next) {
    if (next && typeof next === 'object') {
      st = next;
      window._cdTheme = next;
    }
    applyAttrs();
    setSheet('cd-theme-static', buildStaticCSS());
    buildVarsCSS();
    tagComposer();
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
      if (st.design === 'modern' && st.mode !== 'light') {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'svg' || n.tagName === 'SVG') svgRoots.push(n);
            else if (n.querySelector && n.querySelector('svg')) svgRoots.push(n);
          }
        }
        if (svgRoots.length && !svgScheduled) { svgScheduled = true; idle(flushSVG, 500); }
      }
      // unsere Artefakte wiederherstellen, falls claude.ai sie entfernt
      if (!document.getElementById('cd-theme-static') || !document.getElementById('cd-theme-static').isConnected) setSheet('cd-theme-static', buildStaticCSS());
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
