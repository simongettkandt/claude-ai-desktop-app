# Claude Desktop App for Linux

A fast, native desktop app for Claude AI – no browser needed. Runs on all Linux distributions.

> **v1.2.0** – Electron 41, WebContentsView, Custom Design System, 0 vulnerabilities

---

## Features

- **Tab System** – Multiple chats side by side with a visual tab bar (Ctrl+T, Ctrl+W, Ctrl+Tab)
- **Custom Design System** – Modern gradient theme or Classic mode toggle
- **Dark/Light Mode Toggle** – Moon/Sun button in the tab bar, seamless theme switching
- **Auto-Update** – Automatically updates via GitHub Releases (AppImage)
- **Google OAuth** – Google login works out of the box
- **In-App OAuth Popups** – GitHub, Google Drive, GitLab, Bitbucket, Microsoft
- **Bilingual UI** – Automatic language detection (German/English)
- **Offline Detection** – Automatic reconnect when connection is restored
- **Crash Recovery** – Crashed tabs reload automatically (max 3 retries)
- **Security** – Sandbox enabled, IPC validation, CSP headers, 0 npm vulnerabilities
- **Performance** – GPU acceleration, disk caching, tab preloading, no white flash on start

---

## Installation

### Snap Store (Ubuntu/Snap-based distros)

```bash
sudo snap install claude-ai-desktop
```

### AppImage (all Linux distros)

Download the latest `.AppImage` from [Releases](https://github.com/simongettkandt/claude-ai-desktop-app/releases):

```bash
chmod +x Claude-Desktop-*.AppImage
./Claude-Desktop-*.AppImage --no-sandbox
```

Or use the included launch script:

```bash
chmod +x start-claude.sh
./start-claude.sh
```

### Desktop shortcut (optional)

```bash
cat > ~/.local/share/applications/claude-desktop.desktop << EOF
[Desktop Entry]
Name=Claude Desktop
Comment=Claude AI Desktop App
Exec=/path/to/Claude-Desktop-1.2.0.AppImage --no-sandbox
Icon=/path/to/icon.png
Type=Application
Categories=Utility;
StartupWMClass=claude-desktop
EOF
```

### From source

```bash
git clone https://github.com/simongettkandt/claude-ai-desktop-app.git
cd claude-ai-desktop-app
npm install
npm start
```

Build AppImage:

```bash
npm run build-appimage
```

---

## Note on --no-sandbox

The `--no-sandbox` flag is required for Electron AppImages on Linux because the Chrome SUID sandbox needs `root:4755` permissions, which are not possible inside an AppImage mount. `CHROME_DEVEL_SANDBOX=''` does **not** work as an alternative. The web content sandbox (`sandbox: true` in webPreferences) remains active and protects against untrusted web content.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+T | New tab |
| Ctrl+W | Close tab |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| Ctrl+1–9 | Switch to tab |
| Ctrl+N | New chat |
| Ctrl+, | Settings |
| Ctrl+R | Reload |
| Ctrl++ / Ctrl+- | Zoom |
| F11 | Fullscreen |

---

## Architecture

- Tab contents rendered as `WebContentsView` (one per tab)
- Tab bar as inline HTML in the main window
- IPC communication through `preload-tabbar.js` (contextBridge)
- Theme toggle via `nativeTheme.themeSource` (claude.ai responds natively)
- Custom design via CSS variable overrides + DOM injection
- Session: `persist:claude` partition shared between tabs and OAuth popups

---

## Changelog

### v1.2.0 – Electron 41 & WebContentsView (2026-03-26)

- Upgrade to Electron 41.0.4
- Migration from deprecated `BrowserView` → `WebContentsView`
- 0 npm audit vulnerabilities
- Light mode glow effect
- OAuth error dialog fix ("Object has been destroyed")

### v1.1.4 – Custom Design System (2026-03-26)

- Modern/Classic design toggle
- Gradient accents and brand recoloring via CSS variable overrides
- Input glow effect (dark + light mode)
- Tab bar visual redesign

### v1.1.3 – Security, Stability & Performance (2026-03-23)

- IPC validation (type, integer, bounds checks)
- CSP meta tags for tab bar and offline page
- Crash rate limiting (max 3 reloads per tab)
- Memory leak fix (OAuth popup event listener cleanup)
- Tab pool reduced from 2 to 1 view (~190MB less RAM)
- LRU domain cache

### v1.1.2 – Tab System, Performance & OAuth Popups (2026-03-20)

- Tab system with visual tab bar
- Dark/Light mode toggle
- In-App OAuth popups (GitHub, Google Drive, GitLab, Bitbucket, Microsoft)
- AppImage size reduced from 1.3 GB to 103 MB
- GPU acceleration flags, disk cache, tab preload pool

### v1.1.1 – Security Hotfix & Localization (2026-03-18)

- URL validation via `new URL().hostname` (phishing protection)
- Dynamic User-Agent (uses current Chrome version)
- Bilingual UI (DE/EN) with automatic language detection

### v1.1.0 – Auto-Update & AppImage (2026-03-18)

- Automatic updates via GitHub Releases (`electron-updater`)
- AppImage format for all Linux distros
- Official Claude icon

### v1.0.0 – Initial Release

- BrowserWindow loading claude.ai with Chrome User-Agent
- Google OAuth popup handling
- Dark mode

---

## Security

**Score: 9.5/10** – Sandbox active on all windows, IPC validated, CSP headers, 0 npm vulnerabilities, Electron 41 current.

Known limitation: `--no-sandbox` required for AppImage (SUID sandbox incompatibility). Web content sandbox remains active.

---

## License

This project is an unofficial wrapper. Claude and claude.ai are property of Anthropic.
