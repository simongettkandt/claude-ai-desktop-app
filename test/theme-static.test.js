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

// Das Sheet enthaelt immer alle Modi, gewaehlt wird ueber data-cd-theme am <html>. Neue
// Themes duerfen darum nur hinten anhaengen: was vorher drinstand, muss unveraendert und
// in derselben Reihenfolge stehen bleiben.
for (const name of Object.keys(ST)) {
  test(`buildStaticCSS: ${name} haengt nur an, aendert nichts Bestehendes`, { skip: base ? false : 'keine Baseline' }, () => {
    const before = base.buildStaticCSS(ST[name]);
    const now = CUR.buildStaticCSS(ST[name]);
    // Der eigentliche Schutz: kein Zeichen des alten Sheets darf sich geaendert haben oder
    // verrutscht sein. Neues gehoert hinten dran, auch wenn es OLED betrifft (Bugfixes an
    // Flaechen, die der OLED-Block ohnehin abdecken sollte, gehen dort genauso rein).
    assert.ok(now.startsWith(before), 'bestehende Regeln wurden veraendert statt ergaenzt');
    assert.equal(CUR.sparkleBg(ST[name]), base.sparkleBg(ST[name]));
  });
}

test('midnight bringt eigenen Scope und faerbt nicht ueber das OLED-Scope', () => {
  const st = { mode: 'midnight', design: 'modern', accent: { from: '#2F7FFF', to: '#00E5FF', mid: '#2F7FFF' } };
  const css = CUR.buildStaticCSS(st);
  assert.ok(css.includes('html[data-cd-theme="midnight"]'), 'midnight-Scope fehlt');
  // Nicht auf einen festen Hexwert pruefen, der wandert beim Feilen an der Palette. Es muss
  // eine Basisfarbe geben und die muss blau sein, sonst haengt das Theme in Grau oder Schwarz.
  const base = css.match(/html\[data-cd-theme="midnight"\]\[data-cd-surface="dark"\]\{background-color:(#[0-9a-f]{6})/);
  assert.ok(base, 'midnight setzt keine Basisfarbe auf html');
  const [r, g, b] = [1, 3, 5].map(i => parseInt(base[1].slice(i, i + 2), 16));
  assert.ok(b > r + 8 && b > g + 4, 'Basisfarbe ist nicht blau: ' + base[1]);
  // Die OLED-Regeln bleiben im Sheet, duerfen aber nur unter ihrem eigenen Scope stehen.
  for (const rule of css.split('}')) {
    if (rule.includes('#050306')) assert.ok(rule.includes('data-cd-theme="oled"'), 'OLED-Schwarz ausserhalb des OLED-Scopes: ' + rule.slice(0, 120));
  }
});
