# Claude Desktop App für Linux

Eine native, schnelle Desktop-App für Claude AI – kein Browser nötig.

## Features

- **Native Fenster** – Eigene App in der Taskleiste, Alt+Tab-fähig
- **Google OAuth** – Login mit Google funktioniert direkt
- **Deutsches Menü** – Neuer Chat (Strg+N), Einstellungen (Strg+,)
- **Dark Mode** – Dunkles Theme, passend zu Claude
- **Sicherheit** – Sandbox aktiviert, nur erlaubte Domains, sichere URL-Prüfung
- **Externe Links** – Öffnen sich automatisch im System-Browser
- **Custom Scrollbars** – Schlankes, modernes Scrollbar-Design
- **Zoom** – Strg++ / Strg+- zum Vergrößern/Verkleinern

## Installation

### Option 1: .deb-Paket (empfohlen für Ubuntu/Debian)

Lade die neueste `.deb`-Datei von den [Releases](https://github.com/simongettkandt/claude-desktop/releases) herunter und installiere sie:

```bash
sudo dpkg -i claude-desktop_1.0.1_amd64.deb
```

### Option 2: Aus Quellcode

Voraussetzungen: Node.js (v18+) und npm

```bash
git clone https://github.com/simongettkandt/claude-desktop.git
cd claude-desktop
npm install
npm start
```

### Selbst bauen

```bash
# Als .deb-Paket
npm run build-deb

# Als AppImage
npm run build-appimage
```

Die fertigen Dateien liegen dann unter `dist/`.

## Tastenkürzel

| Kürzel | Aktion |
|--------|--------|
| Strg+N | Neuer Chat |
| Strg+, | Einstellungen |
| Strg+R | Neu laden |
| Strg++ / Strg+- | Zoom |
| F11 | Vollbild |

## Changelog

### v1.0.1 – Sicherheitsupdate & Bugfix
- Sandbox aktiviert (`sandbox: true`)
- Sichere Domain-Prüfung via URL-Parsing statt `string.includes()`
- `shell.openExternal` nur noch für `https:`-URLs
- `will-navigate` blockiert unbekannte Domains
- DevTools nur im Entwicklungsmodus
- Fokus-Bug behoben (Tastatureingaben landeten in App trotz Fensterwechsel)

### v1.0.0 – Initial Release
- BrowserWindow lädt claude.ai mit Chrome User-Agent
- Google OAuth Popup-Handling
- Dark Mode, deutsches Menü, Custom CSS

## Lizenz

Dieses Projekt ist ein inoffizieller Wrapper. Claude und claude.ai sind Eigentum von Anthropic.
