(function() {
  if (window._cdOled) return;
  window._cdOled = true;

  function parseRGB(s) {
    if (!s) return null;
    s = s.trim();
    if (s[0] === '#') {
      var h = s.substring(1);
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      if (h.length !== 6) return null;
      var n = parseInt(h, 16);
      if (isNaN(n)) return null;
      return [(n>>16)&0xff, (n>>8)&0xff, n&0xff];
    }
    var i = s.indexOf('rgb');
    if (i >= 0) {
      var a = s.indexOf('(', i);
      var b = s.indexOf(')', a);
      if (a < 0 || b < 0) return null;
      var p = s.substring(a + 1, b).split(/[\s,/]+/).filter(Boolean);
      if (p.length < 3) return null;
      var r = parseInt(p[0]), g = parseInt(p[1]), bl = parseInt(p[2]);
      if (isNaN(r) || isNaN(g) || isNaN(bl)) return null;
      return [r, g, bl];
    }
    var hi = s.indexOf('hsl');
    if (hi >= 0) {
      var ha = s.indexOf('(', hi);
      var hb = s.indexOf(')', ha);
      if (ha < 0 || hb < 0) return null;
      var hp = s.substring(ha + 1, hb).split(/[\s,/]+/).filter(Boolean);
      if (hp.length < 3) return null;
      var hh = parseFloat(hp[0]);
      var hs = parseFloat(hp[1]) / 100;
      var hl = parseFloat(hp[2]) / 100;
      if (isNaN(hh) || isNaN(hs) || isNaN(hl)) return null;
      var c = (1 - Math.abs(2*hl - 1)) * hs;
      var hp6 = (hh / 60) % 6;
      var x = c * (1 - Math.abs(hp6 % 2 - 1));
      var m = hl - c/2;
      var rr=0, gg=0, bb=0;
      if (hp6 < 1)      { rr=c; gg=x; }
      else if (hp6 < 2) { rr=x; gg=c; }
      else if (hp6 < 3) { gg=c; bb=x; }
      else if (hp6 < 4) { gg=x; bb=c; }
      else if (hp6 < 5) { rr=x; bb=c; }
      else              { rr=c; bb=x; }
      return [Math.round((rr+m)*255), Math.round((gg+m)*255), Math.round((bb+m)*255)];
    }
    return null;
  }

  function mapDark(c) {
    if (!c) return null;
    var sum = c[0] + c[1] + c[2];
    if (sum < 30)  return '#030203';
    if (sum < 150) return '#050306';
    if (sum < 200) return '#120f12';
    if (sum < 260) return '#1c181b';
    if (sum < 330) return '#252023';
    if (sum < 400) return '#2c2528';
    return null;
  }

  function buildRules() {
    var rootRules = '';
    var seen = {};
    try {
      for (var i = 0; i < document.styleSheets.length; i++) {
        try {
          var cr = document.styleSheets[i].cssRules;
          if (!cr) continue;
          for (var j = 0; j < cr.length; j++) {
            if (!cr[j].style || !cr[j].selectorText) continue;
            var sel = cr[j].selectorText;
            var isRoot = sel.indexOf(':root') >= 0
                || sel.indexOf('.dark') >= 0
                || sel.indexOf('[data-theme') >= 0
                || sel === 'html'
                || sel === 'body'
                || sel === '*';
            if (!isRoot) continue;
            for (var k = 0; k < cr[j].style.length; k++) {
              var prop = cr[j].style[k];
              if (!prop.startsWith('--')) continue;
              if (seen[prop]) continue;
              var val = cr[j].style.getPropertyValue(prop);
              var c = parseRGB(val);
              var m = mapDark(c);
              if (m) {
                rootRules += prop + ':' + m + ' !important;';
                seen[prop] = true;
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
    return rootRules;
  }

  function findComposerFieldset() {
    var inputs = document.querySelectorAll('[contenteditable="true"], .ProseMirror, textarea');
    for (var i = 0; i < inputs.length; i++) {
      var node = inputs[i];
      for (var d = 0; d < 10 && node; d++) {
        node = node.parentElement;
        if (node && node.tagName === 'FIELDSET') {
          if (!node.querySelector('fieldset')) return node;
        }
      }
    }
    return null;
  }

  function tagComposer() {
    var fs = findComposerFieldset();
    var prev = document.querySelector('.cd-oled-composer');
    if (prev && prev !== fs) {
      prev.classList.remove('cd-oled-composer');
      prev.style.removeProperty('--cd-composer-radius');
    }
    if (fs && !fs.classList.contains('cd-oled-composer')) {
      fs.classList.add('cd-oled-composer');
    }
    if (fs) {
      try {
        var cs = getComputedStyle(fs);
        var br = parseFloat(cs.borderRadius) || 12;
        fs.style.setProperty('--cd-composer-radius', (br + 2) + 'px');
      } catch (e) {}
    }
  }

  function composerGradientCSS() {
    var brand = window._cdOledBrand || { from: '#F26A3F', to: '#E83B6E' };
    var f = brand.from, to = brand.to;
    return (
      '@keyframes cdGradShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}'
      + '.cd-oled-composer{position:relative;border-color:transparent !important;overflow:visible !important}'
      + '.cd-oled-composer::before{content:"";position:absolute;inset:-2px;border-radius:var(--cd-composer-radius,14px);padding:2px;'
      + 'background:linear-gradient(135deg,' + f + ',' + to + ',' + f + ',' + to + ');'
      + 'background-size:300% 300%;'
      + 'animation:cdGradShift 6s ease-in-out infinite;'
      + '-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);'
      + '-webkit-mask-composite:xor;'
      + 'mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);'
      + 'mask-composite:exclude;'
      + 'pointer-events:none;z-index:5}'
    );
  }

  function apply() {
    var rootRules = buildRules();
    var BG = '#050306';
    var BG_HI = '#120f12';
    var css =
      ':root,html,body,[data-theme="dark"],.dark,.dark *{' + rootRules + '}' +
      'html,body,#__next,#root,main,[role="main"]{background-color:'+BG+' !important;background:'+BG+' !important}' +
      'nav,aside,header,[class*="sidebar" i],[class*="Sidebar"],[class*="topbar" i],[class*="TopBar"]{background-color:'+BG+' !important;background:'+BG+' !important}' +
      '[class*="bg-bg-000"],[class*="bg-bg-100"],[class*="bg-bg-200"]{background-color:'+BG+' !important}' +
      '[class*="bg-bg-300"],[class*="bg-bg-400"]{background-color:'+BG_HI+' !important}' +
      '[class*="bg-bg-500"],[class*="bg-bg-600"]{background-color:#1a1517 !important}' +
      '[class*="bg-black"],[class*="bg-neutral-9"],[class*="bg-zinc-9"],[class*="bg-gray-9"],[class*="bg-stone-9"],[class*="bg-slate-9"]{background-color:'+BG+' !important}' +
      '[class*="from-bg-"],[class*="to-bg-"],[class*="via-bg-"]{background-image:none !important}' +
      'header[class*="bg-"],[class*="bg-bg-200"],[class*="bg-bg-100"]{background-color:'+BG+' !important;background-image:none !important}' +
      'input:focus,textarea:focus,[role="searchbox"]:focus,[role="textbox"]:focus,[contenteditable="true"]:focus,[role="combobox"]:focus{outline-color:rgba(232,82,79,0.45) !important}' +
      'nav a,nav button,aside a,aside button,[class*="sidebar" i] a,[class*="sidebar" i] button,[class*="Sidebar"] a,[class*="Sidebar"] button{background-color:transparent !important;border-color:transparent !important;box-shadow:none !important}' +
      'nav a:hover,nav button:hover,aside a:hover,aside button:hover,[class*="sidebar" i] a:hover,[class*="sidebar" i] button:hover{background-color:#181417 !important}' +
      'nav [aria-current="page"],nav [data-state="active"],nav [aria-selected="true"],aside [aria-current="page"],aside [data-state="active"],aside [aria-selected="true"]{background-color:#1c181b !important}' +
      '[role="menu"],[role="dialog"],[role="listbox"],[role="tooltip"],[class*="opover"],[class*="ropdown"],[class*="enuContent"],[data-radix-popper-content-wrapper]>*{background-color:'+BG_HI+' !important;background-image:none !important}' +
      '[role="menu"] [role="menuitem"],[role="menu"] button,[role="menu"] a,[role="listbox"] [role="option"]{background-color:transparent !important;border-color:transparent !important}' +
      '[role="menu"] [role="menuitem"]:hover,[role="menu"] button:hover,[role="menu"] a:hover,[role="listbox"] [role="option"]:hover,[role="menuitem"][data-highlighted]{background-color:#1c181b !important}' +
      composerGradientCSS();
    var sheet = document.getElementById('cd-oled-style');
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.id = 'cd-oled-style';
      document.head.appendChild(sheet);
    }
    sheet.textContent = css;
  }

  function applyGlow() {
    var ov = document.getElementById('cd-oled-glow');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'cd-oled-glow';
      if (document.body) document.body.appendChild(ov);
      else { document.addEventListener('DOMContentLoaded', function(){ if (document.body && !document.getElementById('cd-oled-glow')) document.body.appendChild(ov); }); }
    }
    var design = window._cdOledDesign || 'modern';
    var bg;
    if (design === 'classic') {
      bg = 'radial-gradient(ellipse 90% 65% at 0% 0%,rgba(212,115,76,0.15),transparent 65%),'
         + 'radial-gradient(ellipse 80% 55% at 100% 100%,rgba(212,115,76,0.10),transparent 65%),'
         + 'radial-gradient(ellipse 55% 40% at 50% 50%,rgba(212,115,76,0.05),transparent 70%)';
    } else {
      bg = 'radial-gradient(ellipse 85% 60% at 0% 0%,rgba(242,106,63,0.16),transparent 65%),'
         + 'radial-gradient(ellipse 85% 60% at 100% 100%,rgba(232,59,110,0.13),transparent 65%),'
         + 'radial-gradient(ellipse 60% 40% at 50% 50%,rgba(212,115,76,0.05),transparent 70%)';
    }
    ov.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;background:' + bg;
  }

  function patchInlineDarkBgs() {
    // No-op: das Scannen aller Elemente und Inline-Setzen von backgroundColor
    // hat in der claude.ai-Sidebar jedem Menüpunkt eine eigene Box gegeben.
    // CSS-Variablen-Override + Tailwind-Class-Selektoren reichen.
  }

  function init() {
    apply();
    applyGlow();
    tagComposer();
    if (!window._cdOledObs) {
      try {
        var pendingScan = false;
        var ob = new MutationObserver(function() {
          var sh = document.getElementById('cd-oled-style');
          if (!sh || !sh.isConnected) apply();
          var gl = document.getElementById('cd-oled-glow');
          if (!gl || !gl.isConnected) applyGlow();
          if (pendingScan) return;
          pendingScan = true;
          requestAnimationFrame(function() {
            pendingScan = false;
            tagComposer();
          });
        });
        ob.observe(document.documentElement, { childList: true, subtree: true });
        window._cdOledObs = ob;
      } catch (e) {}
    }
  }

  window._cdOledDisable = function() {
    var sheet = document.getElementById('cd-oled-style');
    if (sheet) sheet.remove();
    var glow = document.getElementById('cd-oled-glow');
    if (glow) glow.remove();
    var composer = document.querySelector('.cd-oled-composer');
    if (composer) composer.classList.remove('cd-oled-composer');
    if (window._cdOledObs) { try { window._cdOledObs.disconnect(); } catch (e) {} window._cdOledObs = null; }
    try {
      var all = document.querySelectorAll('[style*="background"]');
      for (var i = 0; i < all.length; i++) {
        if (all[i]._cdOledChecked) {
          all[i].style.backgroundColor = '';
          all[i]._cdOledChecked = false;
        }
      }
    } catch (e) {}
    window._cdOled = false;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
