# Claude Desktop App for Linux

A fast, desktop app for Claude AI – no browser needed. Runs on all Linux distributions.

## Installation

[![Get it from the Snap Store](https://snapcraft.io/static/images/badges/en/snap-store-black.svg)](https://snapcraft.io/claude-ai-desktop)

Or via Terminal:

​```bash
sudo snap install claude-ai-desktop
​```

[![claude-ai-desktop](https://snapcraft.io/claude-ai-desktop/badge.svg)](https://snapcraft.io/claude-ai-desktop)

> **v1.3.1** – System Tray, Global Quick-Prompt Hotkey, App Settings, Autostart, Multi-Monitor Fixes

---

## Features

- **System Tray** – Optional minimize-to-tray, keeps Claude one click away in the background
- **Global Quick-Prompt Hotkey** – Configurable hotkey opens a frameless prompt window that injects your text into a new chat
- **App Settings Window** – Configure hotkey, minimize-to-tray, and autostart from `Claude → App Settings…`
- **Autostart** – Optional launch on system boot (Linux: writes a `.desktop` file to `~/.config/autostart/`)
- **Tab System** – Multiple chats side by side with a visual tab bar (Ctrl+T, Ctrl+W, Ctrl+Tab)
- **Custom Design System** – Modern gradient theme or Classic mode toggle
- **Dark/Light Mode Toggle** – Moon/Sun button in the tab bar, seamless theme switching
- **Auto-Update** – Automatically updates via GitHub Releases (AppImage) or `snapd` (Snap)
- **Manual Update Check** – `Claude → Check for Updates…` shows a dialog with the result
- **What's-New Popup** – Shows the changelog once after each version upgrade
- **Google OAuth** – Google login works out of the box
- **In-App OAuth Popups** – GitHub, Google Drive, GitLab, Bitbucket, Microsoft
- **Multilingual UI** – Automatic language detection (25 languages, system fallback to English)
- **Offline Detection** – Automatic reconnect when connection is restored
- **Crash Recovery** – Crashed tabs reload automatically (max 3 retries)
- **Background Throttling** – Reduces CPU usage when the window is minimized
- **Security** – Sandbox enabled, IPC validation, CSP headers, 0 npm vulnerabilities
- **Performance** – GPU acceleration, disk caching, tab preloading, no white flash on start

---

## Installation

### Snap Store (Ubuntu/Snap-based distros)

```bash
sudo snap install claude-ai-desktop
```

Snap updates are handled automatically by `snapd` – no action needed.

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
Exec=/path/to/Claude-Desktop-1.3.1.AppImage --no-sandbox
Icon=/path/to/icon.png
Type=Application
Categories=Utility;
StartupWMClass=claude-desktop
EOF
```

> **Tip:** If you want the shortcut to survive future updates, point `Exec=` to a stable filename like `Claude-Desktop-latest.AppImage` and create a symlink to the current version after each update.

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

## Updating from older versions

The AppImage updates itself via `electron-updater` whenever the app is **fully quit** (not just minimized). If you're stuck on an older version like v1.2.0:

1. **Quit the app completely** – Right-click the tray icon → Quit, or `File → Quit`. Just closing the window is not enough if minimize-to-tray is enabled.
2. **Restart the app** – The pending update installs on next launch.
3. **Check your Desktop shortcut** – If your `~/.local/share/applications/claude-desktop.desktop` still has a hardcoded path like `Claude-Desktop-1.2.0.AppImage`, update it to point to the new file. This is the most common reason updates seem to "not stick".
4. **Manual check** – `Claude → Check for Updates…` forces an immediate check and shows the result.

Snap users don't need to do anything – `snapd` handles updates in the background.

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
| *(configurable)* | Quick-Prompt window |

---

## Architecture

- Tab contents rendered as `WebContentsView` (one per tab)
- Tab bar as inline HTML in the main window
- IPC communication through dedicated preload scripts (contextBridge):
  - `preload-tabbar.js` – tab bar
  - `preload-settings.js` – settings window
  - `preload-quickprompt.js` – quick-prompt window
  - `preload-whatsnew.js` – what's-new popup
  - `preload-messagebox.js` – custom message boxes
- Theme toggle via `nativeTheme.themeSource` (claude.ai responds natively)
- Custom design via CSS variable overrides + DOM injection
- Session: `persist:claude` partition shared between tabs and OAuth popups
- Tray icon via `nativeImage.createFromPath()` with separate sparkle icons for Modern/Classic
- Multi-monitor handling: child windows centered on the display containing the main window

---

## Changelog

### v1.3.1 – Stability & Polish (2026-04-26)

- Quick-Prompt: removed auto-submit, text is now inserted and waits for the user
- Download dialog deduplication (active-lock + 3s cooldown) – fixes double-prompt on some claude.ai download links
- Custom message box helper (`showCustomMessageBox`) replaces all `dialog.showMessageBox` calls – fixes Linux GTK dialogs landing on the wrong monitor
- Code-tab sidebar fix: OAuth cleanup lifecycle now only triggers for actual OAuth domains; non-OAuth child windows stay open
- `will-navigate` opens external links via `shell.openExternal` instead of silently blocking
- New tray icons: transparent sparkle (Modern: gradient `#FF6A2A→#E04E3F`, Classic: solid `#F26A3F`)
- Autostart toggle in App Settings (Linux: app writes its own `.desktop` file to `~/.config/autostart/` since `app.setLoginItemSettings()` is a no-op on Linux)

### v1.3.0 – Tray, Quick-Prompt, Settings (2026-04-22)

- System Tray with optional minimize-to-tray
- Global hotkey (configurable) opens Quick-Prompt window with animated gradient border; text is injected into a new chat via `execCommand('insertText')`
- Quick-Prompt window: transparent, frameless, always-on-top
- What's-New popup, shown once after each version upgrade
- App Settings window (hotkey, minimize-to-tray)
- Update check now shows a dialog for "available", "no updates", and "error"
- Multi-monitor fix: child windows center on the display containing the main window
- UI refinements: tab bar accent matches logo gradient (`#F26A3F → #E83B6E`), plus button moved to the right
- Background throttling at 10 fps when minimized
- Build optimization: `electronLanguages: ["en-US", "de"]` saves ~30 MB; AppImage now ~103 MB
- Electron 41.2.1, electron-builder 26.8.2

### v1.2.2 – Bugfix Round (2026-04-12)

- Crash on app close fixed (`mainWindow` check in `closeTab`)
- Window state no longer saved with wrong bounds when minimized
- Auto-updater logging now runs in production
- Memory leak fix in OAuth popup `closed` handler
- Resize after tab close no longer crashes
- Theme toggle now persists window state
- Auto-updater backoff resets on successful check

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
