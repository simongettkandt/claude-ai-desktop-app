'use strict';
// Sichert ab, dass das erzeugte Stylesheet fuer die bestehenden Modi Byte-gleich bleibt.
// Baseline ist die Kopie aus .backups/2026-08-17-design-window (Stand vor dem Midnight-Umbau);
// fehlt sie, ueberspringt der Test statt zu scheitern.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CUR = require('../inject/theme-static.js');
let base = null;
try { base = require('../.backups/2026-08-17-design-window/inject/theme-static.js'); } catch {}

const AC = { from: '#F26A3F', to: '#E83B6E', mid: '#E8524F' };
const ST = {
  dark: { mode: 'dark', design: 'modern', accent: AC },
  light: { mode: 'light', design: 'modern', accent: AC },
  oled: { mode: 'oled', design: 'modern', accent: AC },
  oledClassic: { mode: 'oled', design: 'classic', accent: { from: '#d4734c', to: '#d4734c', mid: '#E8524F' } }
};

for (const name of Object.keys(ST)) {
  test(`buildStaticCSS: ${name} unveraendert gegenueber Baseline`, { skip: base ? false : 'keine Baseline' }, () => {
    assert.equal(CUR.buildStaticCSS(ST[name]), base.buildStaticCSS(ST[name]));
    assert.equal(CUR.sparkleBg(ST[name]), base.sparkleBg(ST[name]));
  });
}

test('midnight bringt eigenen Scope und faerbt nicht ueber das OLED-Scope', () => {
  const st = { mode: 'midnight', design: 'modern', accent: { from: '#2F7FFF', to: '#00E5FF', mid: '#2F7FFF' } };
  const css = CUR.buildStaticCSS(st);
  assert.ok(css.includes('html[data-cd-theme="midnight"]'), 'midnight-Scope fehlt');
  assert.ok(css.includes('#060f24'), 'Basisfarbe fehlt');
  // Die OLED-Regeln bleiben im Sheet, duerfen aber nur unter ihrem eigenen Scope stehen.
  for (const rule of css.split('}')) {
    if (rule.includes('#050306')) assert.ok(rule.includes('data-cd-theme="oled"'), 'OLED-Schwarz ausserhalb des OLED-Scopes: ' + rule.slice(0, 120));
  }
});
