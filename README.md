# Claude Desktop App for Linux

A fast, native desktop app for Claude AI – no browser needed. Runs on all Linux distributions.

## Features

- **Tab System** – Multiple chats side by side with a visual tab bar (Ctrl+T, Ctrl+W, Ctrl+Tab)
- **Dark/Light Mode Toggle** – Moon/Sun button in the tab bar, seamless theme switching
- **Auto-Update** – Automatically updates via GitHub Releases (AppImage)
- **Google OAuth** – Google login works out of the box
- **Bilingual UI** – Automatic language detection (German/English) for all menus and messages
- **Security** – Sandbox enabled, CSP headers, IPC validation, URL validation via `new URL().hostname`
- **Performance** – GPU acceleration, disk caching, preload pool, preconnect, no white flash on start
- **Crash Recovery** – Crashed tabs are automatically reloaded (max 3 attempts)
- **OAuth Connectors** – In-app OAuth popups for GitHub, Google Drive, GitLab, Bitbucket, Microsoft

## Installation

### Snap Store (Ubuntu Software Center)

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
Exec=/path/to/Claude-Desktop-1.1.3.AppImage --no-sandbox
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

Build it yourself:

```bash
npm run build-appimage
```

## Note on --no-sandbox

The `--no-sandbox` flag is required for Electron AppImages on Linux because the Chrome SUID sandbox needs `root:4755` permissions, which are not possible in AppImage's temporary mount point. `CHROME_DEVEL_SANDBOX=''` does **not** work as an alternative – Electron still finds the SUID helper and crashes. The web content sandbox (`sandbox: true` in webPreferences) remains active and protects against untrusted web content.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
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

## Architecture

- Tab contents rendered as `BrowserView` (one per tab)
- Tab bar as inline HTML in the main window via `loadURL('data:text/html,...')`
- IPC communication through `preload-tabbar.js` (contextBridge)
- No custom CSS injected into claude.ai – original rendering preserved
- Theme toggle via `nativeTheme.themeSource` (claude.ai responds natively)

## Changelog

### v1.1.3 – Security, Stability & Performance (2026-03-23)
**Security:**
- Sandbox enabled on main window (`sandbox: true`)
- IPC validation for tab-switch/tab-close (type, integer, bounds)
- CSP meta tags for tab bar HTML and offline page
- `textContent` instead of `innerHTML` for tab titles
- Input sanitization in preload (`validIndex()`)
- Removed dead code `isGoogleAuthDomain()`
- Security warnings disabled in production

**Stability:**
- Crash rate limiting: max 3 reloads per tab, then give up
- Event listener cleanup on OAuth popup close (memory leak fix)
- closeTab/switchToTab: bounds and isDestroyed checks
- Download manager uses `persist:claude` session

**Performance:**
- Preload pool reduced from 2 to 1 view (~190MB less RAM)
- Lazy pool fill: after first tab load instead of fixed timer
- Domain cache: LRU eviction instead of full clear
- Resize/window state: skip when size unchanged
- Theme toggle pool: `setImmediate` instead of 2s delay
- Preconnect for cdn.claude.ai
- Auto-updater with backoff on errors
- Resize handler consolidated (1 instead of 2)

**Code Quality:**
- Named constants instead of magic numbers
- Dev-mode logging for catch blocks
- Snap: removed unnecessary plugs

### v1.1.2 – Performance Hotfix (2026-03-20)
- Tab preload pool (2 views): new tabs open instantly
- Theme switch optimized: pool destroyed on toggle, only active tab re-renders
- Debounce/throttle on resize (16ms), tab updates (32ms), window state save (500ms)
- Menu cache: rebuild only on tab count/index change
- GPU flags: `enable-gpu-rasterization`, `enable-zero-copy`, `VaapiVideoDecoder`
- Disk cache 200MB, V8 code cache, spellcheck disabled
- Domain cache for URL checks
- Session preconnect to claude.ai (4 sockets)
- In-app OAuth popups for GitHub, Google Drive, GitLab, Bitbucket, Microsoft
- Crash recovery: crashed renderer tabs automatically reloaded
- AppImage reduced from 1.3GB to 103MB

### v1.1.1 – Security Hotfix, Auto-Updater & Localization (2026-03-18)
- URL validation: `new URL().hostname` instead of `string.includes()` (phishing protection)
- Protocol check for `shell.openExternal` (only https, http, mailto)
- `will-navigate`: explicit `event.preventDefault()` for unknown URLs
- DevTools restricted to development mode
- OAuth popup is now modal
- CSP headers for local content
- Auto-updater with download progress in title bar
- Dynamic User-Agent using current Chrome version
- Bilingual UI (DE/EN) with automatic language detection

### v1.1.0 – Auto-Update & AppImage (2026-03-18)
- Automatic updates via GitHub Releases (`electron-updater`)
- AppImage format – runs on all Linux distros
- Official Claude icon
- Launch script `start-claude.sh`

### v1.0.1 – Security Update & Bugfix (2026-03-18)
- Sandbox enabled, secure URL validation, DevTools restricted
- Focus bug fixed

### v1.0.0 – Initial Release
- BrowserWindow loads claude.ai with Chrome User-Agent
- Google OAuth popup handling
- Dark mode, German menu, custom CSS

## Known Limitations

- `--no-sandbox` flag required for AppImage (Chrome SUID sandbox needs root:4755, not possible in AppImage mount)
- `CHROME_DEVEL_SANDBOX=''` does NOT work as alternative
- BrowserView API deprecated in Electron 33+ → migration to WebContentsView needed before Electron upgrade

## Security

**Score: 8/10 (Good)** – Own code is clean (sandbox, CSP, IPC validation). Dependencies have known vulnerabilities. After dep update + Electron upgrade: 9-10/10.

**Open issues:**
1. **HIGH: Dependency vulnerabilities** – 10 vulnerabilities (tar, @tootallnate/once, Electron ASAR)
2. **MEDIUM: Electron outdated** – v31.7.7, current is v41+. Upgrade needed but requires BrowserView → WebContentsView migration

## License

This project is an unofficial wrapper. Claude and claude.ai are property of Anthropic.
