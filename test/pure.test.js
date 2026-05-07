'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  compareVersions,
  safeJson,
  isClaudeAiOrigin,
  validateAccelerator
} = require('../utils/pure');

test('compareVersions: gleiche Version', () => {
  assert.equal(compareVersions('1.3.7', '1.3.7'), 0);
});

test('compareVersions: Patch hoeher', () => {
  assert.ok(compareVersions('1.3.8', '1.3.7') > 0);
});

test('compareVersions: Minor hoeher schlaegt Patch', () => {
  assert.ok(compareVersions('1.4.0', '1.3.99') > 0);
});

test('compareVersions: Pre-Release < Stable mit gleicher Versionsnummer', () => {
  assert.ok(compareVersions('1.3.0-beta.1', '1.3.0') < 0);
  assert.ok(compareVersions('1.3.0', '1.3.0-beta.1') > 0);
});

test('compareVersions: zwei Pre-Releases vergleichen lexikografisch', () => {
  assert.ok(compareVersions('1.3.0-beta.1', '1.3.0-beta.2') < 0);
});

test('compareVersions: fehlende Patch-Stelle wird als 0 gewertet', () => {
  assert.equal(compareVersions('1.3', '1.3.0'), 0);
});

test('safeJson: escaped </script', () => {
  const out = safeJson({ html: '<script>alert(1)</script>' });
  assert.ok(!out.includes('</script>'));
  assert.ok(out.includes('<\\/script>'));
});

test('safeJson: case-insensitive </SCRIPT', () => {
  const out = safeJson({ html: '</SCRIPT>' });
  assert.ok(!/<\/script/i.test(out));
});

test('safeJson: normales Objekt unveraendert', () => {
  assert.equal(safeJson({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
});

test('isClaudeAiOrigin: claude.ai akzeptiert', () => {
  assert.equal(isClaudeAiOrigin('https://claude.ai'), true);
  assert.equal(isClaudeAiOrigin('https://claude.ai/chat/abc'), true);
});

test('isClaudeAiOrigin: Subdomains akzeptiert', () => {
  assert.equal(isClaudeAiOrigin('https://api.claude.ai'), true);
  assert.equal(isClaudeAiOrigin('https://app.claude.ai/x'), true);
});

test('isClaudeAiOrigin: claudeusercontent.com abgelehnt', () => {
  assert.equal(isClaudeAiOrigin('https://www.claudeusercontent.com'), false);
  assert.equal(isClaudeAiOrigin('https://claudeusercontent.com'), false);
});

test('isClaudeAiOrigin: Spoofing-Versuche abgelehnt', () => {
  assert.equal(isClaudeAiOrigin('https://evilclaude.ai'), false);
  assert.equal(isClaudeAiOrigin('https://claude.ai.evil.com'), false);
  assert.equal(isClaudeAiOrigin('https://claude-ai.com'), false);
});

test('isClaudeAiOrigin: HTTP (nicht HTTPS) abgelehnt', () => {
  assert.equal(isClaudeAiOrigin('http://claude.ai'), false);
});

test('isClaudeAiOrigin: file:/data: abgelehnt', () => {
  assert.equal(isClaudeAiOrigin('file:///etc/passwd'), false);
  assert.equal(isClaudeAiOrigin('data:text/html,<h1>x</h1>'), false);
});

test('isClaudeAiOrigin: ungueltige URL abgelehnt', () => {
  assert.equal(isClaudeAiOrigin('not a url'), false);
  assert.equal(isClaudeAiOrigin(''), false);
  assert.equal(isClaudeAiOrigin(null), false);
  assert.equal(isClaudeAiOrigin(undefined), false);
});

test('validateAccelerator: simple Modifier+Key', () => {
  assert.equal(validateAccelerator('CommandOrControl+Shift+E'), 'CommandOrControl+Shift+E');
  assert.equal(validateAccelerator('Alt+Space'), 'Alt+Space');
});

test('validateAccelerator: F-Tasten und Spezialtasten', () => {
  assert.equal(validateAccelerator('F11'), 'F11');
  assert.equal(validateAccelerator('Ctrl+Up'), 'Ctrl+Up');
});

test('validateAccelerator: leerer/zu langer String abgelehnt', () => {
  assert.equal(validateAccelerator(''), null);
  assert.equal(validateAccelerator('x'.repeat(100)), null);
});

test('validateAccelerator: nicht-string abgelehnt', () => {
  assert.equal(validateAccelerator(null), null);
  assert.equal(validateAccelerator(undefined), null);
  assert.equal(validateAccelerator(123), null);
});

test('validateAccelerator: Junk abgelehnt', () => {
  assert.equal(validateAccelerator('not a hotkey'), null);
  assert.equal(validateAccelerator('CommandOrControl+'), null);
  assert.equal(validateAccelerator('+E'), null);
});
