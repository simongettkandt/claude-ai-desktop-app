# Claude Desktop App für Linux

Eine native, schnelle Desktop-App für Claude AI – kein Browser nötig.

## Features

- **Native Fenster** – Eigene App in der Taskleiste, Alt+Tab-fähig
- **Deutsches Menü** – Neuer Chat (Strg+N), Einstellungen (Strg+,)
- **Dark Mode** – Dunkles Theme, passend zu Claude
- **Globaler Shortcut** – Strg+Shift+C bringt Claude sofort in den Vordergrund
- **Externe Links** – Öffnen sich automatisch im System-Browser
- **Custom Scrollbars** – Schlankes, modernes Scrollbar-Design
- **Zoom** – Strg++ / Strg+- zum Vergrößern/Verkleinern

## Installation

### Voraussetzungen

- Node.js (v18 oder neuer): https://nodejs.org/
- npm (kommt mit Node.js)

### Schnellstart

```bash
# 1. In das Projektverzeichnis wechseln
cd claude-desktop-electron

# 2. Abhängigkeiten installieren
npm install

# 3. App starten
npm start
```

### Als .deb-Paket bauen (für Ubuntu/Debian)

```bash
npm run build-deb
```

Das fertige `.deb`-Paket findest du dann unter `dist/`.

Installation:
```bash
sudo dpkg -i dist/claude-desktop_1.0.0_amd64.deb
```

### Als AppImage bauen (für alle Linux-Distros)

```bash
npm run build-appimage
```

Das AppImage unter `dist/` ist sofort lauffähig:
```bash
chmod +x dist/Claude-Desktop-1.0.0.AppImage
./dist/Claude-Desktop-1.0.0.AppImage
```

## Tastenkürzel

| Kürzel | Aktion |
|--------|--------|
| Strg+N | Neuer Chat |
| Strg+, | Einstellungen |
| Strg+R | Neu laden |
| Strg+Shift+C | Claude in den Vordergrund (global) |
| Strg++ / Strg+- | Zoom |
| F11 | Vollbild |

## Anpassungen

Die App lädt `https://claude.ai` in einem Electron-Fenster. Du kannst in `main.js` weitere Anpassungen vornehmen, z.B.:

- **Fenstergröße** ändern (`width`, `height`)
- **Zusätzliches CSS** injizieren (in `did-finish-load`)
- **Tray-Icon** hinzufügen für Minimize-to-Tray

## Lizenz

Dieses Projekt ist ein inoffizieller Wrapper. Claude und claude.ai sind Eigentum von Anthropic.
