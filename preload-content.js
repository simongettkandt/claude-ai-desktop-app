// Preload für claude.ai-Tab-Views.
// Stellt eine schmale Bridge bereit, über die das injected notify.js den Main-Process
// über fertige Antworten informieren kann.
const { contextBridge, ipcRenderer } = require('electron');

// Frame-Heartbeat fuer den Surface-Watchdog in main.js: requestAnimationFrame feuert nur,
// solange der Compositor BeginFrames liefert. Haengt die Surface, bleibt die Antwort aus,
// waehrend IPC und Timer normal weiterlaufen.
// Zwei Antworten: 'alive' sofort (der Renderer lebt), 'raf' nur wenn auch Frames laufen.
ipcRenderer.on('cd-frame-ping', () => {
  ipcRenderer.send('cd-frame-pong', 'alive');
  requestAnimationFrame(() => ipcRenderer.send('cd-frame-pong', 'raf'));
});

contextBridge.exposeInMainWorld('claudeDesktop', {
  responseDone: (payload) => {
    let preview = '';
    if (payload && typeof payload === 'object' && typeof payload.preview === 'string') {
      preview = payload.preview.slice(0, 200);
    }
    ipcRenderer.send('claude-response-done', { preview });
  },
  resetVerification: () => ipcRenderer.send('claude-reset-verification'),
  offlineRetry: () => ipcRenderer.send('cd-offline-retry')
});

// Anti-FOUC: OLED-Schwarz schon bei document-start setzen (laeuft vor dem ersten Paint),
// damit beim kalten Start/Tab nicht claude.ais eigenes Grau aufblitzt, bis der Theme-Controller
// bei dom-ready greift. Nur auf claude.ai, nur im OLED-Mode. Der Controller raeumt das
// cd-theme-preload-Sheet beim Uebernehmen wieder weg (sonst stoert es einen spaeteren Light-Switch).
(function () {
  try {
    if (!/(^|\.)claude\.ai$/.test(location.hostname)) return;
    var st = ipcRenderer.sendSync('cd-theme-mode') || {};
    if (st.mode !== 'oled') return;
    var BG = '#050306';
    // Sternenfeld identisch zu theme.js sparkleBg(); muss mit theme.js synchron bleiben,
    // damit beim Uebergang Preload -> Controller kein Sprung sichtbar ist.
    function spark() {
      var ac = st.accent || {}, f = ac.from || '#F26A3F', t = ac.to || '#E83B6E';
      function u(x, y, sc, op) { return "<use href='#s' transform='translate(" + x + "," + y + ") scale(" + sc + ")' opacity='" + op + "'/>"; }
      var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='620' height='620' viewBox='0 0 620 620'>"
        + "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='" + f + "'/><stop offset='1' stop-color='" + t + "'/></linearGradient>"
        + "<path id='s' d='M0,-1 L.2245,-.309 L.951,-.309 L.363,.118 L.588,.809 L0,.382 L-.588,.809 L-.363,.118 L-.951,-.309 L-.2245,-.309 Z'/></defs>"
        + "<g fill='url(#g)'>"
        + u(110, 140, 11, .3) + u(430, 95, 7, .2) + u(540, 400, 9, .26)
        + u(230, 500, 6, .18) + u(580, 580, 5, .16) + u(300, 280, 8, .22)
        + "</g></svg>";
      return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
    }
    function apply() {
      var de = document.documentElement;
      if (!de) return false;
      de.style.backgroundColor = BG;
      de.setAttribute('data-cd-theme', 'oled');
      de.setAttribute('data-cd-surface', 'dark');
      if (!document.getElementById('cd-theme-preload')) {
        var s = document.createElement('style');
        s.id = 'cd-theme-preload';
        // Das VOLLE statische Theme schon hier (vor dem ersten Paint), damit der Inhalt
        // sofort gethemt erscheint statt ~1.7s claude.ai-Styling zu zeigen und dann sichtbar
        // umzuspringen (der Controller haengt per executeJavaScript hinter Reacts Hydration).
        // staticCSS kommt aus derselben Quelle wie der Controller (main -> theme-static.js).
        // Fallback (Subset) nur, falls staticCSS mal leer ist, damit dieses Sheet allein traegt.
        s.textContent = (st.staticCSS && st.staticCSS.length) ? st.staticCSS
          : ('html{background-color:' + BG + ' !important}'
          + 'body{background-color:' + BG + ' !important;background-image:' + spark() + ' !important;background-size:620px 620px}'
          + '[class*="bg-bg-"],[class*="bg-black"],[class*="bg-neutral-9"],[class*="bg-zinc-9"],[class*="bg-gray-9"],[class*="bg-stone-9"],[class*="bg-slate-9"]{background-color:' + BG + ' !important}'
          + 'nav,aside,header,[class*="sidebar" i],[class*="Sidebar"],[class*="topbar" i],[class*="TopBar"]{background-color:' + BG + ' !important;background-image:none !important}'
          + 'nav,aside,[class*="sidebar" i],[class*="Sidebar"]{border-right:1px solid rgba(255,255,255,0.07) !important}');
        (document.head || de).appendChild(s);
      }
      return true;
    }
    if (!apply()) {
      var iv = setInterval(function () { if (apply()) clearInterval(iv); }, 0);
      document.addEventListener('readystatechange', apply);
    }
  } catch (e) {}
})();
