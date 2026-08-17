(function() {
  if (window._cdThanks) return;
  window._cdThanks = true;

  var I18N = __THANKS_I18N__;
  var KEY = '_cdThanksDismissed';
  var ID = 'cd-thanks-badge';

  // localStorage, nicht sessionStorage: einmal weggeklickt soll es weg bleiben.
  // Ueberlebt einen Verify-Full-Wipe nicht, das ist fuer einen Dank verkraftbar.
  function dismissed() {
    try { return window.localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }

  function show() {
    if (document.getElementById(ID) || !document.body) return;

    var box = document.createElement('div');
    box.id = ID;
    box.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483646;' +
      'display:flex;align-items:center;gap:10px;max-width:320px;' +
      'padding:10px 12px 10px 14px;border-radius:14px;' +
      'background:rgba(24,28,38,.92);color:#e9eff8;border:1px solid rgba(120,150,200,.28);' +
      'box-shadow:0 6px 24px rgba(0,0,0,.38);backdrop-filter:blur(6px);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'font-size:12.5px;line-height:1.4;opacity:0;transition:opacity .35s ease;';

    var txt = document.createElement('div');
    txt.textContent = I18N.msg;
    txt.style.cssText = 'flex:1;';

    var x = document.createElement('button');
    x.setAttribute('aria-label', I18N.close);
    x.title = I18N.close;
    x.textContent = '×';
    x.style.cssText = 'flex-shrink:0;width:22px;height:22px;border:0;border-radius:8px;' +
      'background:transparent;color:#9fb0c8;font-size:17px;line-height:1;cursor:pointer;padding:0;';
    x.addEventListener('mouseenter', function() { x.style.background = 'rgba(255,255,255,.08)'; });
    x.addEventListener('mouseleave', function() { x.style.background = 'transparent'; });
    x.addEventListener('click', function() {
      try { window.localStorage.setItem(KEY, '1'); } catch (e) {}
      if (box.parentNode) box.parentNode.removeChild(box);
    });

    box.appendChild(txt);
    box.appendChild(x);
    document.body.appendChild(box);
    requestAnimationFrame(function() { box.style.opacity = '1'; });
  }

  function evaluate() {
    if (dismissed()) return;
    // Nicht ueber ein Cloudflare-Interstitial legen, dort zaehlt nur das Verify-Banner.
    try {
      if ((document.title || '').toLowerCase().indexOf('just a moment') === 0) return;
      if (document.getElementById('challenge-stage')) return;
    } catch (e) {}
    show();
  }

  if (document.body) evaluate();
  else document.addEventListener('DOMContentLoaded', evaluate, { once: true });
})();
