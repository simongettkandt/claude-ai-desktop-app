(function() {
  if (window._cdVerify) return;
  window._cdVerify = true;

  var I18N = __VERIFY_I18N__;
  var DELAY = 8000;
  var KEY_SINCE = '_cdVerifyStuckSince';
  var KEY_DISMISS = '_cdVerifyDismissed';
  var BANNER_ID = 'cd-verify-banner';
  var pendingTimer = null;

  function ss(get, key, val) {
    try {
      if (get) return window.sessionStorage.getItem(key);
      if (val === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, val);
    } catch (e) {}
    return null;
  }

  // Cloudflare-Vollseiten-Interstitial erkennen. Bewusst eng gehalten, damit das
  // Turnstile-Widget auf der normalen Login-Seite kein Banner ausloest.
  function isChallenge() {
    try {
      if ((document.title || '').toLowerCase().indexOf('just a moment') === 0) return true;
      if (document.getElementById('challenge-stage')) return true;
      if (document.getElementById('challenge-running')) return true;
      if (document.getElementById('cf-challenge-running')) return true;
    } catch (e) {}
    return false;
  }

  function removeBanner() {
    var el = document.getElementById(BANNER_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function showBanner() {
    if (document.getElementById(BANNER_ID)) return;
    if (!document.body) return;

    var bar = document.createElement('div');
    bar.id = BANNER_ID;
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'background:#1f1e1c;color:#e8e0d8;font-family:-apple-system,BlinkMacSystemFont,' +
      '"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.45;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.35);padding:12px 16px;' +
      'display:flex;align-items:center;gap:14px;flex-wrap:wrap;';

    var msg = document.createElement('div');
    msg.textContent = I18N.msg;
    msg.style.cssText = 'flex:1;min-width:240px;';

    var btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'display:flex;gap:8px;flex-shrink:0;';

    var reset = document.createElement('button');
    reset.textContent = I18N.reset;
    reset.style.cssText = 'background:#E8524F;color:#fff;border:0;border-radius:6px;' +
      'padding:7px 16px;font-size:14px;font-weight:600;cursor:pointer;';
    reset.addEventListener('click', function() {
      try {
        if (window.claudeDesktop && typeof window.claudeDesktop.resetVerification === 'function') {
          window.claudeDesktop.resetVerification();
        }
      } catch (e) {}
    });

    var dismiss = document.createElement('button');
    dismiss.textContent = I18N.dismiss;
    dismiss.style.cssText = 'background:transparent;color:#c8c0b8;border:1px solid #4a4844;' +
      'border-radius:6px;padding:7px 16px;font-size:14px;cursor:pointer;';
    dismiss.addEventListener('click', function() {
      ss(false, KEY_DISMISS, '1');
      removeBanner();
    });

    btnWrap.appendChild(reset);
    btnWrap.appendChild(dismiss);
    bar.appendChild(msg);
    bar.appendChild(btnWrap);
    document.body.appendChild(bar);
  }

  function evaluate() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }

    if (!isChallenge()) {
      ss(false, KEY_SINCE, null);
      ss(false, KEY_DISMISS, null);
      removeBanner();
      return;
    }
    if (ss(true, KEY_DISMISS)) return;

    var since = parseInt(ss(true, KEY_SINCE) || '0', 10);
    if (!since) { since = Date.now(); ss(false, KEY_SINCE, String(since)); }

    var elapsed = Date.now() - since;
    if (elapsed >= DELAY) {
      showBanner();
    } else {
      pendingTimer = setTimeout(function() {
        if (isChallenge() && !ss(true, KEY_DISMISS)) showBanner();
      }, DELAY - elapsed);
    }
  }

  if (document.body) evaluate();
  else document.addEventListener('DOMContentLoaded', evaluate, { once: true });
})();
