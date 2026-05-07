(function() {
  if (window._cdNotify) return;
  window._cdNotify = true;
  if (window._cdNotifyInterval) { clearInterval(window._cdNotifyInterval); window._cdNotifyInterval = null; }

  // Heuristik: claude.ai zeigt waehrend Generation einen Stop-Button und tauscht ihn
  // gegen einen Send-Button, sobald Claude fertig ist. Wir beobachten den Stop-Button
  // im Composer und feuern ein Event, wenn er verschwindet.
  //
  // Mehrere Selektor-Strategien als Fallback-Stack: wenn claude.ai eine Strategie
  // bricht, greifen die anderen. Bei Erst-Match jeder Strategie loggen wir einmal,
  // damit man bei Regressionen in DevTools sieht welche noch greift.

  var STOP_RE = /stop|abbrechen|abbreche|abbruch|halt/i;
  var lastFire = 0;
  var COOLDOWN = 2000;
  var wasGenerating = false;
  var strategiesUsed = {};

  function logStrategy(id, name) {
    if (strategiesUsed[id]) return;
    strategiesUsed[id] = true;
    try { console.info('[claudeDesktop.notify] stop-button via strategy', id, name); } catch (e) {}
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    try {
      var st = getComputedStyle(el);
      if (st.position === 'fixed' && st.display !== 'none' && st.visibility !== 'hidden') return true;
    } catch (e) {}
    return false;
  }

  function findStopButton() {
    // 1. aria-label (DE+EN)
    var byAria = document.querySelector('button[aria-label*="stop" i], button[aria-label*="abbrechen" i], button[aria-label*="halt" i]');
    if (byAria && isVisible(byAria)) { logStrategy(1, 'aria-label'); return byAria; }
    // 2. data-testid
    var byTest = document.querySelector('button[data-testid*="stop" i]');
    if (byTest && isVisible(byTest)) { logStrategy(2, 'data-testid'); return byTest; }
    // 3. SVG-Icon mit data-icon oder ueber svg-rect (Stop-Symbol = Quadrat)
    var byDataIcon = document.querySelector('button [data-icon="stop" i], button [data-icon="square" i]');
    if (byDataIcon) {
      var btn = byDataIcon.closest('button');
      if (btn && isVisible(btn)) { logStrategy(3, 'data-icon'); return btn; }
    }
    // 4. Textinhalt-Fallback
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var l = (b.getAttribute('aria-label') || b.textContent || '').trim();
      if (l && STOP_RE.test(l) && isVisible(b)) {
        logStrategy(4, 'text-content');
        return b;
      }
    }
    return null;
  }

  function getLastAssistantPreview() {
    try {
      var selectors = [
        '[data-testid="assistant-message"]',
        'div.font-claude-message',
        '[class*="assistant"][class*="message"]'
      ];
      for (var s = 0; s < selectors.length; s++) {
        var msgs = document.querySelectorAll(selectors[s]);
        if (msgs.length === 0) continue;
        var last = msgs[msgs.length - 1];
        if (!last) continue;
        var text = (last.innerText || '').replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, 200);
      }
    } catch (e) {}
    return '';
  }

  function tick() {
    var stopBtn = findStopButton();
    var generating = !!stopBtn;
    if (wasGenerating && !generating) {
      var now = Date.now();
      if (now - lastFire >= COOLDOWN) {
        lastFire = now;
        try {
          if (window.claudeDesktop && typeof window.claudeDesktop.responseDone === 'function') {
            window.claudeDesktop.responseDone({ preview: getLastAssistantPreview() });
          }
        } catch (e) {}
      }
    }
    wasGenerating = generating;
  }

  // Polling reicht aus — DOM-Mutationen sind haeufig, aber wir wollen nur den
  // Uebergang erkennen. 700ms ist ein Kompromiss aus Latenz und CPU.
  window._cdNotifyInterval = setInterval(tick, 700);
})();
