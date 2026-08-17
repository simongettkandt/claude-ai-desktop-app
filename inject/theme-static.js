// Gemeinsame Quelle fuer das statische OLED-Stylesheet. Reine Funktion des Theme-States
// (nur st.accent), keine DOM-Zugriffe. Genutzt von main.js (fuettert das document-start-
// Preload per IPC) UND vom injizierten Controller (inject/theme.js). Eine Quelle, damit
// Preload und Controller nicht auseinanderlaufen.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.cdThemeStatic = api;
})(this, function () {
  function sparkUse(x, y, sc, op) {
    return "<use href='#s' transform='translate(" + x + "," + y + ") scale(" + sc + ")' opacity='" + op + "'/>";
  }
  function sparkleBg(st) {
    var ac = (st && st.accent) || {}, f = ac.from || '#F26A3F', t = ac.to || '#E83B6E';
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='620' height='620' viewBox='0 0 620 620'>"
      + "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='" + f + "'/><stop offset='1' stop-color='" + t + "'/></linearGradient>"
      + "<path id='s' d='M0,-1 L.2245,-.309 L.951,-.309 L.363,.118 L.588,.809 L0,.382 L-.588,.809 L-.363,.118 L-.951,-.309 L-.2245,-.309 Z'/></defs>"
      + "<g fill='url(#g)'>"
      + sparkUse(110, 140, 11, .3) + sparkUse(430, 95, 7, .2) + sparkUse(540, 400, 9, .26)
      + sparkUse(230, 500, 6, .18) + sparkUse(580, 580, 5, .16) + sparkUse(300, 280, 8, .22)
      + "</g></svg>";
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  function buildStaticCSS(st) {
    var BG = '#050306', BG_HI = '#120f12';
    // OLED: Flaechen liegen alle unter 1.2:1 Kontrast -> auf near-black crush unsichtbar.
    // Trennung laeuft daher ueber 1px-Hairlines (Kante triggert, nicht Flaechenhelligkeit).
    var MENU_EDGE = 'rgba(232,82,79,0.12)', HAIR_DIM = 'rgba(255,255,255,0.07)', FOCUS = 'rgba(232,82,79,0.45)';
    var O = 'html[data-cd-theme="oled"][data-cd-surface="dark"]';
    var W = 'html[data-cd-theme="light"]';
    var SPARK = sparkleBg(st);

    // Mitternachtsblau. Die drei Stufen entsprechen bg/bgHover/bgActive des THEME-Objekts
    // in main.js, damit App-Fenster und Seite dieselbe Treppe zeigen. Kanten und Fokus in
    // kuehlem Blau; der Fokus-Ring nimmt das Neon-Cyan des Theme-Akzents auf.
    var MBG = '#070c18', MBG_HI = '#0d1526', MBG_TOP = '#151f36';
    var M_EDGE = 'rgba(47,127,255,0.20)', M_HAIR = 'rgba(138,154,181,0.20)', M_FOCUS = 'rgba(0,229,255,0.55)';
    var M = 'html[data-cd-theme="midnight"][data-cd-surface="dark"]';

    // [class*="X"] matcht auch Tailwinds Opacity-Modifier "X/NN" (z.B. eine helle 5%-Toenung
    // fuer einen Preis-Chip), die sonst faelschlich volldeckend geschwaerzt wird und ihren
    // eigenen (auf hell gedachten) Text unsichtbar macht. :not() schliesst genau diese Variante aus.
    function safeBg(scope, tokens, color) {
      return tokens.map(function (t) {
        return scope + ' [class*="' + t + '"]:not([class*="' + t + '/"])';
      }).join(',') + '{background-color:' + color + ' !important}';
    }

    return [
      // --- White: claude.ai bleibt technisch dark, wird per GPU-Invert hell. Beim Umschalten
      // aendert sich nur die filter-Property am Wurzelknoten -> ~6ms Recalc (der Compositor
      // faerbt um, kein Main-Thread-Repaint), statt ~480ms fuer claude.ais eigenen
      // prefers-color-scheme-Palettenwechsel. hue-rotate(180) haelt die Farbtoene nah am
      // Original (Rot bleibt Rot). Echte Medien (Fotos/Avatare/Thumbnails) zurueck-invertieren,
      // damit sie nicht negativ erscheinen.
      W + '{filter:invert(1) hue-rotate(180deg) !important;background-color:#fff !important}',
      // iframe gehoert dazu: Artefakte, das Design-Feature und der Stripe-Bezahlvorgang
      // laufen cross-origin und bringen ihr eigenes Farbschema mit. Ohne Rueck-Invertierung
      // erscheint ihr Inhalt als Negativ (gemessen am Design-Feature: gelb wurde oliv,
      // Hauttoene kippten). Unser Filter darf nur claude.ais eigene Oberflaeche umdrehen.
      W + ' img,' + W + ' video,' + W + ' canvas,' + W + ' image,' + W + ' iframe,' + W + ' [style*="background-image"]{filter:invert(1) hue-rotate(180deg)}',
      // --- OLED: html schwarz (Fallback) ---
      O + '{background-color:' + BG + ' !important}',
      // body traegt das Sternen-Hintergrundbild (claude.ais Container darueber sind
      // transparent, scheinen also durch). KEIN background-attachment:fixed: das nimmt dem
      // body die Compositor-Faehigkeit und erzwingt bei jeder Aenderung/jedem Scroll einen
      // Vollbild-Repaint -> zaeher "alles hakt / 1 fps"-Effekt beim Streamen, Scrollen und
      // Theme-Wechsel. Ohne fixed bleiben die Sterne trotzdem stehen, weil claude.ai in einem
      // inneren Container scrollt (der body selbst scrollt nicht), aber ohne die Repaint-Strafe.
      O + ' body{background-color:' + BG + ' !important;background-image:' + SPARK + ' !important;background-size:620px 620px}',
      // Sterne ausblenden solange ein Modal offen ist, sonst schimmern sie unruhig durch den Backdrop.
      // Geschaltet ueber data-cd-modal am <html> (updateModalFlag im Observer), nicht ueber body:has(),
      // weil :has() bei jedem Style-Recalc den Subtree scannt und den Recalc massiv verteuert.
      O + '[data-cd-modal] body{background-image:none !important}',
      O + ' #__next,' + O + ' #root,' + O + ' main,' + O + ' [role="main"]{background-color:transparent !important;background-image:none !important}',
      // undurchsichtige Flaechen decken die Sterne ab
      O + ' nav,' + O + ' aside,' + O + ' header,' + O + ' [class*="sidebar" i],' + O + ' [class*="Sidebar"],' + O + ' [class*="topbar" i],' + O + ' [class*="TopBar"]{background-color:' + BG + ' !important;background-image:none !important}',
      // Sidebar gegen den gleich-schwarzen Chatbereich abgrenzen (sonst Kante 1.0:1 = unsichtbar).
      O + ' nav,' + O + ' aside,' + O + ' [class*="sidebar" i],' + O + ' [class*="Sidebar"]{border-right:1px solid ' + HAIR_DIM + ' !important}',
      safeBg(O, ['bg-bg-000', 'bg-bg-100', 'bg-bg-200'], BG),
      safeBg(O, ['bg-bg-300', 'bg-bg-400'], BG_HI),
      safeBg(O, ['bg-bg-500', 'bg-bg-600'], '#1a1517'),
      // claude.ais neuere surface-Tokens (z.B. Settings-Content bg-surface-2 = grau) ebenfalls schwaerzen.
      safeBg(O, ['bg-surface-0', 'bg-surface-1'], BG),
      safeBg(O, ['bg-surface-2', 'bg-surface-3'], BG_HI),
      safeBg(O, ['bg-black', 'bg-neutral-900', 'bg-neutral-950', 'bg-zinc-900', 'bg-zinc-950', 'bg-gray-900', 'bg-gray-950', 'bg-stone-900', 'bg-stone-950', 'bg-slate-900', 'bg-slate-950'], BG),
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
      // --- Mitternachtsblau: gleiche Token-Gruppen wie OLED, nur auf drei Blaustufen statt
      // near-black. Kein Sternenfeld: das bleibt die Signatur von OLED. Die Stufen liegen
      // ebenfalls dicht beieinander (unter 1.5:1), Trennung laeuft darum wie dort ueber
      // Hairlines, hier in einem kuehlen Blau statt dem Rot-Ton.
      M + '{background-color:' + MBG + ' !important}',
      M + ' body{background-color:' + MBG + ' !important;background-image:none !important}',
      M + ' #__next,' + M + ' #root,' + M + ' main,' + M + ' [role="main"]{background-color:transparent !important;background-image:none !important}',
      M + ' nav,' + M + ' aside,' + M + ' header,' + M + ' [class*="sidebar" i],' + M + ' [class*="Sidebar"],' + M + ' [class*="topbar" i],' + M + ' [class*="TopBar"]{background-color:' + MBG + ' !important;background-image:none !important}',
      M + ' nav,' + M + ' aside,' + M + ' [class*="sidebar" i],' + M + ' [class*="Sidebar"]{border-right:1px solid ' + M_HAIR + ' !important}',
      safeBg(M, ['bg-bg-000', 'bg-bg-100', 'bg-bg-200'], MBG),
      safeBg(M, ['bg-bg-300', 'bg-bg-400'], MBG_HI),
      safeBg(M, ['bg-bg-500', 'bg-bg-600'], MBG_TOP),
      safeBg(M, ['bg-surface-0', 'bg-surface-1'], MBG),
      safeBg(M, ['bg-surface-2', 'bg-surface-3'], MBG_HI),
      safeBg(M, ['bg-black', 'bg-neutral-900', 'bg-neutral-950', 'bg-zinc-900', 'bg-zinc-950', 'bg-gray-900', 'bg-gray-950', 'bg-stone-900', 'bg-stone-950', 'bg-slate-900', 'bg-slate-950'], MBG),
      // Das Design-Feature bringt eigene Controls mit fest verdrahtetem Grau mit (gemessen
      // rgb(107,107,107) am Auswahlfeld), die keiner der Surface-Tokens erwischt.
      M + ' .om-dc-select,' + M + ' [class*="om-dc-select"]{background-color:' + MBG_TOP + ' !important}',
      M + ' [class*="from-bg-"],' + M + ' [class*="to-bg-"],' + M + ' [class*="via-bg-"]{background-image:none !important}',
      M + ' header[class*="bg-"]{background-color:' + MBG + ' !important;background-image:none !important}',
      M + ' nav a,' + M + ' nav button,' + M + ' aside a,' + M + ' aside button,' + M + ' [class*="sidebar" i] a,' + M + ' [class*="sidebar" i] button,' + M + ' [class*="Sidebar"] a,' + M + ' [class*="Sidebar"] button{background-color:transparent !important;border-color:transparent !important;box-shadow:none !important}',
      M + ' nav a:hover,' + M + ' nav button:hover,' + M + ' aside a:hover,' + M + ' aside button:hover,' + M + ' [class*="sidebar" i] a:hover,' + M + ' [class*="sidebar" i] button:hover{background-color:' + MBG_HI + ' !important}',
      M + ' nav [aria-current="page"],' + M + ' nav [data-state="active"],' + M + ' nav [aria-selected="true"],' + M + ' aside [aria-current="page"],' + M + ' aside [data-state="active"],' + M + ' aside [aria-selected="true"]{background-color:' + MBG_TOP + ' !important}',
      M + ' [role="menu"],' + M + ' [role="dialog"],' + M + ' [role="listbox"],' + M + ' [role="tooltip"],' + M + ' [class*="opover"],' + M + ' [class*="ropdown"],' + M + ' [class*="enuContent"],' + M + ' [data-radix-popper-content-wrapper]>*{background-color:' + MBG_HI + ' !important;background-image:none !important;border:1px solid ' + M_EDGE + ' !important;box-shadow:0 8px 28px rgba(0,0,0,0.6) !important}',
      M + ' [role="menu"] [role="menuitem"],' + M + ' [role="menu"] button,' + M + ' [role="menu"] a,' + M + ' [role="listbox"] [role="option"]{background-color:transparent !important;border-color:transparent !important}',
      M + ' [role="menu"] [role="menuitem"]:hover,' + M + ' [role="menu"] button:hover,' + M + ' [role="menu"] a:hover,' + M + ' [role="listbox"] [role="option"]:hover,' + M + ' [role="menuitem"][data-highlighted]{background-color:' + MBG_TOP + ' !important}',
      M + ' input:focus,' + M + ' textarea:focus,' + M + ' [role="searchbox"]:focus,' + M + ' [role="combobox"]:focus{outline:1.5px solid ' + M_FOCUS + ' !important;outline-offset:2px !important}',
      M + ' .cd-composer{position:relative;border-color:transparent !important;overflow:visible !important;background-color:' + MBG + ' !important}',
      M + ' .cd-composer::before{content:"";position:absolute;inset:-2px;border-radius:var(--cd-composer-radius,14px);padding:2px;background:linear-gradient(135deg,var(--cd-accent-from),var(--cd-accent-to),var(--cd-accent-from),var(--cd-accent-to));background-size:300% 300%;animation:cdGradShift 6s ease-in-out infinite;-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;pointer-events:none;z-index:5}',
      ''
    ].join('');
  }

  return { buildStaticCSS: buildStaticCSS, sparkleBg: sparkleBg };
});
