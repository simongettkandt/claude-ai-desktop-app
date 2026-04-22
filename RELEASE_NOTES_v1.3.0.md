# Claude Desktop v1.3.0 — Productivity Release

**Veröffentlicht:** 2026-04-22
**Vorherige Version:** [v1.2.2](./RELEASE_NOTES_v1.2.2.md)

Das größte Feature-Update seit v1.2.0. Drei neue Fenster, System-Tray-Integration, globaler Hotkey, umfassende Performance-Optimierung und eine kleinere AppImage.

---

## Das Wichtigste in Kürze

| Bereich | Neu in v1.3.0 |
|---------|---------------|
| **Produktivität** | Globaler Hotkey + Quick-Prompt-Fenster, System-Tray, App-Einstellungen |
| **UI** | What's-New-Popup, Update-Check-Dialoge, Tab-Bar-Akzente am Logo-Gradient |
| **Performance** | Hintergrund-Drosselung aktiver Tab, AppImage ~17 % kleiner |
| **Stabilität** | 19+ Bugfixes aus systematischem Code-Review |
| **Sicherheit** | Electron 41.2.1 (3 CVEs), Hotkey-Validierung, IPC-Sender-Checks |

---

## Neue Features

### System-Tray & Hintergrund-Modus

Claude läuft jetzt optional im Hintergrund weiter. Beim Schließen des Fensters minimiert die App ins Tray (optional, standardmäßig aus), bleibt über das Tray-Symbol erreichbar oder wird per Hotkey geholt.

- Tray-Menü: **Öffnen** · **Neuer Chat** · **App-Einstellungen** · **Beenden**
- Klick aufs Tray-Symbol toggelt das Hauptfenster
- Persistiert in `window-state.json` (`minimizeOnClose`)

### Globaler Quick-Prompt-Hotkey

Ein frei wählbarer, systemweiter Hotkey öffnet ein schlankes Eingabefenster mit animiertem Gradient-Rahmen. Text wird in einen neuen Chat bei `claude.ai/new` injiziert und automatisch abgeschickt.

- Transparent, frameless, always-on-top
- Auto-fokussiertes Textfeld, Enter sendet, Shift+Enter Zeilenumbruch, Esc abbricht
- Akzeptiert Key-Kombinationen wie `Alt+C`, `CmdOrCtrl+Shift+Space`, etc.
- Validierte Accelerator-Syntax (siehe Sicherheit)

### App-Einstellungen-Fenster

Neuer Dialog im Fenstermenü unter **Claude → App-Einstellungen…**:

- Hintergrund-Modus (Minimize-to-Tray) an/aus
- Globaler Hotkey setzen (interaktives Tastenkombinations-Capture) oder löschen
- Einstellungen werden sofort und persistent gespeichert

### What's-New-Popup

Einmalig nach jeder Versions-Aktualisierung wird ein Changelog-Fenster angezeigt. Triggert bei Versionswechsel, merkt sich die zuletzt gesehene Version und erscheint beim nächsten Start nicht mehr.

- Über `lastSeenVersion` in `window-state.json` gesteuert
- Öffnet automatisch die App-Einstellungen, wenn der Nutzer das im Popup wählt

### Update-Check mit Feedback-Dialogs

Das Menü zeigt jetzt klare Dialoge bei **Update verfügbar**, **Kein Update**, **Update-Fehler**. Bisher lief der Update-Check still im Hintergrund.

### Multi-Monitor-Fix

Alle Child-Fenster (Quick-Prompt, Settings, What's-New) zentrieren auf dem Display der Hauptapp, nicht mehr auf dem Primary-Display. Verhindert "Fenster öffnet auf falschem Monitor".

---

## Performance

### Hintergrund-Drosselung

Die aktive Tab-View (claude.ai) wurde bisher **nicht** gedrosselt, wenn die App minimiert oder im Tray versteckt war — selbst eine Streaming-Antwort lief mit voller CPU weiter.

Jetzt:

| Situation | Frame-Rate | CPU-Throttling |
|-----------|------------|----------------|
| Fenster sichtbar + fokussiert | 60 fps | aus |
| **Minimiert oder im Tray** | **10 fps** | **an** |
| Unfokussiert (sichtbar) | 60 fps | aus |

Wird über Events `minimize` / `hide` / `show` / `restore` / `focus` auf `mainWindow` gesteuert.

### Kleineres AppImage

- `electronLanguages: ["en-US", "de"]` spart ~30 MB gegenüber dem vollen Locale-Satz
- Erwartete Größe: **~103 MB** (v1.2.2 war ca. 120 MB)
- Eigene UI-Strings gehen durch einen `t(de, en)`-Helper (kein i18n-Framework nötig)

### Sonstige Performance-Fixes

- `brand.js`: Schleife über alle Stylesheets läuft nur noch **einmal** pro Page-Load (per `varsFailed`-Flag). Vorher: Jeder Theme-Toggle löste eine vollständige Re-Iteration aus.
- Console-Warn-Spam bei fehlendem Orange-Recoloring gestoppt.

---

## Stabilität & Bugfixes

Alle bekannten Issues aus dem Fehlerbericht v1.2.2 sind behoben, plus Funde aus einem systematischen Deep-Review.

### Fixes aus Fehlerbericht v1.2.2

| # | Problem | Fix |
|---|---------|-----|
| 1 | `brand.js`-Pfad brach App-Start | Datei unter `inject/brand.js`, konsistent mit `package.json` |
| 2 | Auto-Updater-Backoff eskalierte dauerhaft | `failures = 0` auch bei `update-not-available` |
| 3 | Variable-Shadowing der `t()`-i18n-Funktion | Arrow-Parameter `t` → `tb` in `tabs.find` |
| 4 | Shadowing in `mainWindow.on('closed')` | `t` → `tab` in `tabs.forEach` |
| 5 | Theme-Toggle persistierte nicht | `saveWindowState()` im `theme-toggle`-IPC-Handler |
| 6 | Fehlendes Fallback-Logging bei CSS-Var-Ausfall | `console.warn` mit Hinweis auf Classic-Design |

### Weitere Fixes

- **Layout-Abschnitt behoben** — Tab-View wird jetzt bei `maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen`, `show` und nach Tab-did-finish-load neu positioniert.
- **What's-New-Timing** — Popup erscheint erst, wenn der claude.ai-Content geladen ist (vorher: schon während die rechte Seite noch leer war).
- **Update-Dialogs crash-fest** — `dialog.showMessageBox` mit destroyed `mainWindow` prüft jetzt vorher.
- **Interval-Cleanup** — `updateCheckInterval`, `onlineCheckInterval`, `waitForFirstTabInterval` werden in `before-quit` sauber gecleart.
- **`second-instance`** — Holt die App korrekt aus dem Tray, statt nur zu fokussieren.
- **Tray-Icon synchron** — Wird beim `toggleDesign` mit aktualisiert.
- **RELEASE_NOTES-Duplikation** entfernt — `'1.3.0-beta.1'` ist Alias auf `'1.3.0'`.

---

## Sicherheit

- **Electron 41.0.4 → 41.2.1** — schließt 3 CVEs
- **electron-builder 26.8.1 → 26.8.2**
- **Hotkey-Validierung** — `settings-hotkey` prüft Accelerator-String gegen eine Regex-Whitelist (nur Electron-valide Modifier + Keys), verhindert Injection beliebiger Strings.
- **Quick-Prompt-IPC-Sender-Check** — `quickprompt-submit` / `quickprompt-cancel` prüfen jetzt `event.sender === quickPromptWindow.webContents`, damit nur das eigene Fenster IPC feuern kann.
- **Input-Längenprüfung** im Main-Process für Quick-Prompt (max. 8000 Zeichen), unabhängig vom Preload-Layer.

---

## Dateistruktur (neu in v1.3.0)

```
claude-desktop/
├── main.js                    # ~1660 Zeilen (+220 seit v1.2.2)
├── inject/
│   └── brand.js               # Custom Design / Recoloring
├── preload-tabbar.js
├── preload-settings.js        # NEU – Settings-Window IPC
├── preload-quickprompt.js     # NEU – Quick-Prompt IPC
├── preload-whatsnew.js        # NEU – What's-New IPC
├── icon.png                   # Modern-Design
└── icon-original.png          # Classic/Terrakotta-Design
```

---

## Abhängigkeiten

| Paket | v1.2.2 | v1.3.0 | Hinweis |
|-------|--------|--------|---------|
| `electron` | ^41.0.4 | **^41.2.1** | 3 CVEs geschlossen |
| `electron-builder` | ^26.8.1 | **^26.8.2** | Patch-Update |
| `electron-updater` | ^6.8.3 | ^6.8.3 | Aktuell |

`npm audit` meldet **0 Vulnerabilities**.

---

## Installation

```bash
chmod +x Claude-Desktop-1.3.0.AppImage
./Claude-Desktop-1.3.0.AppImage --no-sandbox
```

Das `--no-sandbox`-Flag ist auf Systemen notwendig, auf denen der Chromium-SUID-Helper nicht konfiguriert ist. Der interne Web-Content-Sandbox bleibt aktiv.

---

## Upgrade aus v1.2.2

Der eingebaute Auto-Updater erkennt v1.3.0 automatisch und lädt das Update im Hintergrund. Beim nächsten Start erscheint der **Update-bereit**-Dialog. Einmalig nach dem Update wird das **What's-New**-Popup gezeigt.

## Download

- `Claude-Desktop-1.3.0.AppImage` — Universelles Linux-Build
- `latest-linux.yml` — Für den Auto-Updater zwingend erforderlich, nicht weglassen

---

## Dank & Referenzen

- Interner Fehlerbericht `FEHLERBERICHT_v1.2.2.md` (alle kritischen Punkte adressiert)
- Systematischer Deep-Code-Review für Race-Conditions, IPC-Sicherheit, Hintergrund-Performance

> **Hinweis:** Dies ist die erste Version, die System-Tray-Integration und globale Hotkeys unter Linux (X11 & Wayland) stabil unterstützt.
