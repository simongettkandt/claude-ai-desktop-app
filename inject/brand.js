(function() {
  if (window._cdBrand) return;
  window._cdBrand = true;

  var MID = '#E8524F';

  // ── Farb-Erkennung ──

  function parseRGB(s) {
    if (!s || s.length < 10) return null;
    var i = s.indexOf('rgb');
    if (i < 0) return null;
    var a = s.indexOf('(', i);
    if (a < 0) return null;
    var b = s.indexOf(')', a);
    if (b < 0) return null;
    var p = s.substring(a + 1, b).split(',');
    return p.length >= 3 ? [parseInt(p[0]), parseInt(p[1]), parseInt(p[2])] : null;
  }

  function isOrange(c) {
    return c[0] >= 175 && c[0] <= 235 && c[1] >= 75 && c[1] <= 135
      && c[2] >= 40 && c[2] <= 105 && c[0] - c[1] >= 55 && c[0] - c[2] >= 85;
  }

  // ── CSS-Variable Override (einmalig) ──

  var varsDone = false;
  var varsFailed = false;

  function overrideVars() {
    if (varsDone || varsFailed) return;
    var sheet = document.getElementById('cd-vars');
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.id = 'cd-vars';
      document.head.appendChild(sheet);
    }
    var rules = ':root{';
    var found = false;
    try {
      for (var i = 0; i < document.styleSheets.length; i++) {
        try {
          var cr = document.styleSheets[i].cssRules;
          for (var j = 0; j < cr.length; j++) {
            if (!cr[j].style) continue;
            for (var k = 0; k < cr[j].style.length; k++) {
              var prop = cr[j].style[k];
              if (!prop.startsWith('--')) continue;
              var val = cr[j].style.getPropertyValue(prop);
              var c = parseRGB(val);
              if (c && isOrange(c)) {
                rules += prop + ':' + MID + ' !important;';
                found = true;
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
    if (found) {
      sheet.textContent = rules + '}';
      varsDone = true;
    } else {
      varsFailed = true;
      console.warn('[claude-desktop] Kein Orange-Recoloring möglich — claude.ai CSS hat sich möglicherweise geändert. Fallback: Classic-Design wählen.');
    }
  }

  // ── SVG-Recolor (nur einzelne Elemente, nicht den ganzen Body) ──

  function recolorEl(el) {
    if (el._cdDone) return;
    try {
      var cs = getComputedStyle(el);
      var f = parseRGB(cs.fill);
      if (f && isOrange(f)) el.style.fill = MID;
      var s = parseRGB(cs.stroke);
      if (s && isOrange(s)) el.style.stroke = MID;
      el._cdDone = true;
    } catch (e) {}
  }

  function recolorSVGs(root) {
    if (!root || root.nodeType !== 1) return;
    var svgs = (root.tagName === 'svg' || root.tagName === 'SVG') ? [root] : root.querySelectorAll('svg');
    for (var i = 0; i < svgs.length; i++) {
      recolorEl(svgs[i]);
      var ch = svgs[i].querySelectorAll('*');
      for (var j = 0; j < ch.length; j++) recolorEl(ch[j]);
    }
  }

  // ── Gradient-Overlay ──

  function createOverlay() {
    if (document.getElementById('cd-grad')) return;
    var ov = document.createElement('div');
    ov.id = 'cd-grad';

    function applyGrad(dark) {
      var o = dark ? '0.06' : '0.09';
      ov.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
        + 'background:radial-gradient(ellipse 70% 50% at 0% 0%,rgba(242,106,63,' + o + '),transparent),'
        + 'radial-gradient(ellipse 70% 50% at 100% 100%,rgba(232,59,110,' + o + '),transparent)';
    }

    applyGrad(window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.appendChild(ov);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
      applyGrad(e.matches);
      varsDone = false;
      overrideVars();
      styleInputs();
    });
  }

  // ── Input-Glow ──

  var cachedFieldset = null;

  function styleInputs() {
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (!cachedFieldset || !cachedFieldset.isConnected) {
      cachedFieldset = null;
      var all = document.querySelectorAll('fieldset');
      for (var i = 0; i < all.length; i++) {
        if (all[i].querySelector('[contenteditable], textarea, [role=textbox], .ProseMirror')) {
          cachedFieldset = all[i];
          break;
        }
      }
    }
    if (cachedFieldset) {
      cachedFieldset.style.boxShadow = dark
        ? '0 0 40px rgba(242,106,63,0.035), 0 0 80px rgba(232,59,110,0.025)'
        : '0 0 40px rgba(242,106,63,0.05), 0 0 80px rgba(232,59,110,0.035)';
    }
  }

  // ── MutationObserver (nur neue Nodes beobachten, kein periodischer Scan) ──

  var observer = null;
  var pendingNodes = [];
  var rafScheduled = false;

  function processPendingNodes() {
    rafScheduled = false;
    var nodes = pendingNodes;
    pendingNodes = [];
    for (var i = 0; i < nodes.length; i++) {
      recolorSVGs(nodes[i]);
    }
    // Fieldset-Cache invalidieren wenn neue Nodes reinkommen
    if (nodes.length > 0 && (!cachedFieldset || !cachedFieldset.isConnected)) {
      styleInputs();
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) pendingNodes.push(added[j]);
        }
      }
      if (pendingNodes.length > 0 && !rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(processPendingNodes);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Init ──

  function init() {
    overrideVars();
    createOverlay();
    styleInputs();
    recolorSVGs(document.body); // einmaliger Full-Scan beim Laden
    startObserver(); // danach nur noch neue Nodes beobachten
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})()
