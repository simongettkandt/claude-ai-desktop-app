# Unofficial Claude Desktop App for Linux

Desktop wrapper for claude.ai. Runs as a native window on Linux without a browser tab.

## Installation

[![Get it from the Snap Store](https://snapcraft.io/static/images/badges/en/snap-store-black.svg)](https://snapcraft.io/claude-ai-desktop)

Or via Terminal:

​```bash
sudo snap install claude-ai-desktop
​```

[![claude-ai-desktop](https://snapcraft.io/claude-ai-desktop/badge.svg)](https://snapcraft.io/claude-ai-desktop)

> **v1.4.8** - Cloudflare verification fix. The browser identity sent in the request headers now matches what the built-in browser reports in JavaScript (no more forged "Google Chrome" brand that could loop the Cloudflare check), the non-default Do Not Track header is gone, and the stuck-verification banner now points to what actually helps (a different network, or turning off an active VPN, which is often the cause) instead of dead-end resets. A persistent loop is dominated by IP reputation, which is server-side and no client change can override.

---

## Features

- **Voice Input** – Microphone permission for claude.ai's voice features, scoped strictly to claude.ai (artifact iframes can't piggyback). Snap users get an in-app setup wizard that detects whether the `audio-record` plug is connected and links straight to the Snap Store permissions page. Since v1.3.8 the App Settings show a live colored status pill next to the toggle and the Allow button briefly pulses the moment the Snap permission is granted
- **Live Notifications** – Tab-bar banner for service-side notices (info / warn / critical / success), fetched from the repo every 6h with version filters and per-ID dismiss state, so urgent hints land without a new release
- **Custom App Menu (Hamburger)** – In-app menu with keyboard navigation, replaces the native menu bar; quick access to all actions including new tab, export, settings, updates and bug report
- **Tab System** – Multiple chats side by side with a visual tab bar (Ctrl+T, Ctrl+W, Ctrl+Tab); direct buttons in the tab bar for Markdown export and bug report
- **Markdown Export** – Save the active conversation as a `.md` file via `Ctrl+Shift+E`, including code blocks, lists, headings and links
- **System Tray** – Optional minimize-to-tray instead of closing the window
- **Global Quick-Prompt Hotkey** – Configurable hotkey opens a frameless prompt window that injects your text into a new chat
- **Prompt Templates** – Define named prefixes (e.g. "Translate to English:"), pick them with Tab in the Quick-Prompt window
- **Clipboard Hotkey** – Separate global hotkey that opens a new chat with your clipboard text already inserted
- **Background-Tab Response Notifications** – Optional native notification when Claude finishes a response in a tab you're not currently viewing
- **In-App Bug Report** – Description, optional error codes, optional contact email; auto-includes app/OS info on opt-in. Includes a clear notice that this is an unofficial community wrapper (not an official Anthropic product) with a direct link to https://support.anthropic.com for account/login/billing/payment questions. Localized in DE, EN, FR, ES, IT
- **App Settings Window** – Configure hotkeys, minimize-to-tray, autostart, background notifications and templates from `Claude → App Settings…`
- **Autostart** – Optional launch on system boot (Linux: writes a `.desktop` file to `~/.config/autostart/`; Snap: native autostart directive)
- **Custom Design System** – Modern gradient theme or Classic mode toggle
- **Dark/Light Mode Toggle** – Moon/Sun button in the tab bar
- **Auto-Update** – Updates via GitHub Releases (AppImage) or `snapd` (Snap). Since v1.3.7 the AppImage also rewrites stale `.desktop` and autostart entries on startup, so the menu shortcut keeps pointing at the current file after `electron-updater` replaces the AppImage
- **Manual Update Check** – Menu entry shows a dialog with the result
- **What's-New Popup** – Shows the changelog once after each version upgrade, including notes for skipped versions
- **In-App OAuth Popups** – Google, GitHub, Google Drive, GitLab, Bitbucket, Microsoft, Auth0, Higgsfield
- **Multilingual UI** – Full interface in German, English, French and Italian, selected by system language with English fallback (the bug-report dialog covers additional languages)
- **Offline Detection** – Automatic reconnect when connection is restored
- **Crash Recovery** – Crashed tabs reload automatically (max 3 retries)
- **Background Throttling** – Reduces CPU usage when the window is minimized
- **Security** – Sandbox enabled, IPC validation, CSP headers
- **Performance** – GPU acceleration, disk caching, tab preloading

---

## Installation

### Snap Store (Ubuntu/Snap-based distros)

```bash
sudo snap install claude-ai-desktop
```

Snap updates are handled automatically by `snapd` – no action needed.

### AppImage (all Linux distros)

Download the latest `.AppImage` from [Releases](https://github.com/simonlinuxcraft/claude-ai-desktop-app/releases):

```bash
chmod +x Claude-Desktop-*.AppImage
./Claude-Desktop-*.AppImage --no-sandbox
```

This is a type-2 AppImage and needs the FUSE 2 runtime. Ubuntu 22.04 / 24.04 and other recent distros ship FUSE 3 only, so the AppImage may fail with `fuse: device not found` or a missing `libfuse.so.2`. Either install FUSE 2 once:

```bash
sudo apt install libfuse2        # Debian/Ubuntu
```

or run the AppImage without FUSE:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./Claude-Desktop-*.AppImage --no-sandbox
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
Exec=/path/to/Claude-Desktop-1.4.1.AppImage --no-sandbox
Icon=/path/to/icon.png
Type=Application
Categories=Utility;
StartupWMClass=claude-desktop
EOF
```

If you want the shortcut to survive future updates, point `Exec=` to a stable filename like `Claude-Desktop-latest.AppImage` and create a symlink to the current version after each update.

### From source

```bash
git clone https://github.com/simonlinuxcraft/claude-ai-desktop-app.git
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
3. **Check your Desktop shortcut** – If your `~/.local/share/applications/claude-desktop.desktop` still has a hardcoded path like `Claude-Desktop-1.2.0.AppImage`, update it to point to the new file. Since v1.3.7 the app rewrites this file on startup, so once you've launched a v1.3.7+ AppImage at least once, future updates fix the shortcut on their own.
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

## Security

Sandbox active on all windows, IPC validated, CSP headers, Electron 41.

Known limitation: `--no-sandbox` required for AppImage (SUID sandbox incompatibility). Web content sandbox remains active.

---

## License

This project is an unofficial wrapper. Claude and claude.ai are property of Anthropic.
