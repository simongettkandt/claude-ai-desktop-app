(function() {
  if (window._cdNotify) return;
  window._cdNotify = true;

  // Heuristik: claude.ai zeigt während Generation einen Stop-Button und tauscht ihn
  // gegen einen Send-Button, sobald Claude fertig ist. Wir beobachten Buttons im
  // Composer-Bereich und feuern ein Event, wenn der Stop-Button verschwindet
  // (Wechsel von "generierend" → "fertig"). Zusätzlich ein Cooldown von 2s.

  var STOP_RE = /stop|abbrechen|abbreche|abbruch/i;
  var lastFire = 0;
  var COOLDOWN = 2000;
  var wasGenerating = false;

  function findStopButton() {
    // Bevorzugt: aria-label oder data-testid mit "stop"
    var byAria = document.querySelector('button[aria-label*="stop" i], button[aria-label*="abbrechen" i]');
    if (byAria) return byAria;
    var byTest = document.querySelector('button[data-testid*="stop" i]');
    if (byTest) return byTest;
    // Fallback: alle Buttons mit STOP-Wort prüfen
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var l = (b.getAttribute('aria-label') || b.textContent || '').trim();
      if (l && STOP_RE.test(l) && b.offsetParent !== null) return b;
    }
    return null;
  }

  function getLastAssistantPreview() {
    try {
      var msgs = document.querySelectorAll('[data-testid="assistant-message"], div.font-claude-message');
      var last = msgs[msgs.length - 1];
      if (!last) return '';
      var text = (last.innerText || '').replace(/\s+/g, ' ').trim();
      return text.slice(0, 200);
    } catch (e) { return ''; }
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

  // Polling reicht aus — DOM-Mutationen sind häufig, aber wir wollen nur den
  // Übergang erkennen. 700ms ist ein Kompromiss aus Latenz und CPU.
  setInterval(tick, 700);
})();
