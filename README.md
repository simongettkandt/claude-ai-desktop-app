# Claude Desktop App for Linux

Desktop wrapper for claude.ai. Runs as a native window on Linux without a browser tab.

## Installation

[![Get it from the Snap Store](https://snapcraft.io/static/images/badges/en/snap-store-black.svg)](https://snapcraft.io/claude-ai-desktop)

Or via Terminal:

​```bash
sudo snap install claude-ai-desktop
​```

[![claude-ai-desktop](https://snapcraft.io/claude-ai-desktop/badge.svg)](https://snapcraft.io/claude-ai-desktop)

> **v1.4.2** - Italian & French plus Snap fixes. The app interface is now available in Italian and French on top of German and English, chosen by system language with an English fallback. Snap notifications attribute to the app again (sets the `CHROME_DESKTOP` desktop-entry hint GNOME needs), the OLED tab bar colour is consistent between live-toggle and fresh start, and the Snap download is a little smaller.

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

## Changelog

### v1.4.2 - Italian & French, Snap Notifications (2026-06-02)

- **App interface in Italian and French.** The whole UI (tab bar, tray, native and app menus, Settings, About, What's New, Quick-Prompt, bug-report confirm dialogs, microphone consent, offline page, download/update notices, Markdown export labels) is now available in Italian and French on top of German and English. `t(de, en)` became `t(de, en, fr, it)` with an English fallback, driven by the existing `sysLang` system-language detection; `localize()` for release notes follows the same scheme. What's New shows a short FR/IT notice asking users to report translation glitches via the bug-report form.
- **Snap notifications attribute to the app again.** Electron derives the libnotify `desktop-entry` hint from `$CHROME_DESKTOP`, which the Snap never set, so GNOME Shell could not map the notification to the app and dropped it under strict confinement. The Snap now sets `CHROME_DESKTOP=claude-ai-desktop.desktop`. Suspected cause of the v1.3.13 "notifications not coming through" report; replaces the bogus `desktop-notifications` plug from 1.4.1. Under verification against a real Snap build.
- **OLED tab bar colour consistent.** The tab-bar live-switch palette used `#000000` while a fresh OLED start used `#050306`; both now use the central OLED palette.
- **Settings status dot follows the theme** instead of a hardcoded dark-theme tone.
- **Snap a little smaller** by excluding `LICENSES.chromium.html` (roughly 2 MB off the compressed download), and icon writes to `~/` are skipped under Snap confinement.

### v1.4.1 - Localized Release Notes (2026-05-29)

- **"What's New" window respects the system language.** Release-note titles and bodies were hard-coded German, so users on non-German systems kept seeing German strings even though the rest of the UI was localized. All entries from 1.3.0 through 1.4.0 now carry both `de` and `en` text, resolved through a `localize()` helper at render time.
- **One-time catch-up on 1.4.0 highlights.** A new `RELEASE_NOTES_REVISIT` map carries 1.4.0 along when 1.4.1 is shown, so non-German users get to read what 1.4.0 actually changed in their language.
- Small i18n cleanup in the live-notifications tab-bar template: the "More" link label and the close-button tooltip now use `t()` instead of hardcoded German.
- **Walked back:** an earlier draft of 1.4.1 added a `desktop-notifications` plug to the Snap manifest, billed as a fix for the user report that notifications were not coming through in v1.3.13 Snap. That plug name does not exist as a snapd interface (snapd dropped it with an `unknown interface` warning at install). The interfaces needed for `org.freedesktop.Notifications` DBus access (`desktop`, `desktop-legacy`) are already provided by the `gnome` extension and were connected on every prior Snap revision. The plug entry has been removed; the underlying report remains under investigation.

### v1.4.0 - OLED Mode & Frameless Window (2026-05-27)

- **OLED theme as a third theme.** The sun/moon icon in the tab bar cycles Light → Dark → OLED. OLED renders claude.ai on a warm near-black background (`#050306`) with a subtle brand-glow overlay (orange top-left, magenta bottom-right). CSS-variable mapping + Tailwind class targeting in `inject/oled.js` recolor the page content; sidebar items become flat with a discreet hover state; Radix popup menus get a slightly raised background. The mode is preselected on the first launch of 1.4.0; use the same icon to switch back, the choice is then persisted.
- **Frameless main window with custom window controls.** The system title bar is gone; the tab bar hosts Minimize, Maximize/Restore and Close on the right (GNOME order). The whole free area of the tab bar is a drag region, double-click toggles maximize. New IPC channels `win-minimize`, `win-toggle-maximize`, `win-close`, `win-state-request` with a sender check that restricts them to `mainWindow`.
- **All sub-windows frameless with a custom title bar.** What's New, About, Settings and Bug Report now use a shared 36 px title strip (drag region + close button), consistent with the main window. Helpers: `customTitlebarCSS()` / `customTitlebarHTML()`. In OLED the helper also paints a brand-glow body overlay so the dialogs stay deep black but feel alive.
- **Composer gradient ring.** The chat input on claude.ai shows a thin animated brand gradient border (orange ↔ magenta, 6 s loop), matching the Quick-Prompt style. JS detection picks the innermost composer `<fieldset>`, CSS uses a `::before` mask-composite border so it sits exactly on the field's radius.
- **What's New redesigned.** Bento-grid layout with an animated brand gradient hero (version pill, headline, subtitle) and a 2-column tile grid for highlights; brand-tinted icon containers with hover lift; primary close button gets a shadow that picks up the brand colour. Window resized to 640×680.
- **Bug Report dialog rebuilt on `theme()` instead of hardcoded dark/light values**, so OLED now applies. Primary button uses the Modern brand gradient (`linear-gradient(135deg, F26A3F, E83B6E)`) like the rest of the app instead of a solid colour.
- **OLED logo variant** for the in-app spark (About hero, App Menu, Quick-Prompt). The existing icon is embedded into an SVG with a dark tile and two radial brand-glow stops so it does not disappear into the OLED black.
- **Stability hardening.** `oledIntroSeen` is persisted via `saveWindowStateSync()` immediately after the intro default fires, so a hard crash within the first session cannot re-trigger the intro. `cd-titlebar-close` event binding uses optional chaining so a missing title bar does not break the rest of the window. Sidebar `<a>` / `<button>` entries no longer get individual painted backgrounds in OLED.

### v1.3.13 - Verification Loop Banner (2026-05-20)

- **In-page banner when the verification screen is stuck.** Land on the Cloudflare "Performing security verification" page and stay there 18 seconds, and a banner shows up at the top with a Reset button. Reset clears claude.ai cookies and cache and reloads the page. Before this the only way out was a hidden menu entry. New injected script `inject/verify-banner.js`; detection is kept narrow so the Turnstile widget on the login page does not trigger it.

### v1.3.12 – Higgsfield Connector Fix (2026-05-17)

- **Higgsfield connector now connects.** `higgsfield.ai` was missing from the OAuth allowlist, so the auth popup was sent to the system browser and the OAuth callback never returned to the app. The domain is now treated like the other OAuth providers (Google, GitHub, Microsoft, GitLab, Bitbucket, Auth0) — popup opens in-app, callback lands in the shared session.
- **`mailto:` links opened from in-tab navigation** now also reach the system mail client (previously only `window.open()`-style links did).
- **Bug Report dialog window height** bumped from 760 to 860 px so the action buttons are no longer cut off at the bottom (the serverSideHint added in 1.3.11 had stretched the disclaimer block without a matching size bump).
- Internal: cleaned up `main.js` section-header comments (cosmetic only).

### v1.3.11 – Cloudflare Verification Loop Fix (2026-05-13)

- **Cloudflare Turnstile no longer loops on "Performing security verification".** Three causes addressed: the challenge iframe (`challenges.cloudflare.com`) was missing from the allowlist; the UA / Sec-Ch-Ua header rewrite was scoped to `*.claude.ai` only, leaving sandbox origins on the default Electron UA; `Sec-Ch-Ua-Full-Version-List` and `Sec-Ch-Ua-Platform-Version` were not being sent (Electron upstream bug #34762).
- **Bug Report dialog**: added a "does the same error appear in a regular browser?" cross-check hint under the unofficial-app disclaimer.

### v1.3.10 – MCP Connectors & Self-Service Diagnostics (2026-05-11)

- **MCP connectors (Visualize and others) now load again** – Users who had connected an MCP app inside claude.ai saw the error *"Failed to set up MCP app — check that claudemcpcontent.com is not blocked by your network or browser"*. The cause was the app's own allowlist: `claudemcpcontent.com` (a separate sandbox origin Anthropic uses for MCP iframe content, analogous to `claudeusercontent.com` for artifacts) was missing from `isAllowedDomain`, so `will-frame-navigate` blocked the iframe load. Added `claudemcpcontent.com` and prophylactically `claudemcp.com` to the allowlist – same fix shape as the 1.3.3 artifact-iframe bug.
- **App Menu → "Copy diagnostics info"** – New entry that dumps app version, Electron/Chrome/Node build, kernel release, session type (X11/Wayland), `XDG_SESSION_TYPE` / `WAYLAND_DISPLAY` / `DISPLAY`, locale, user-agent, full GPU feature status, GPU vendor/device IDs and driver strings (`app.getGPUInfo('complete')`), GL vendor/renderer/version, and WebGL vendor/renderer/version (probed in the active tab via `WEBGL_debug_renderer_info`) into the clipboard. Makes verification-loop and rendering-stack bug reports reproducible.
- **App Menu → "Reset claude.ai verification…"** – Confirm-gated action that clears cookies, local storage, service workers, cache, IndexedDB, websql and filesystem storage for `claude.ai`, `claudeusercontent.com`, `claudemcpcontent.com` and `claudemcp.com` (all subdomains), plus the session cache and host resolver cache, then reloads `https://claude.ai`. Self-service recovery for users stuck on a *"Performing security verification"* loop.

### v1.3.9 – Wayland Compatibility (2026-05-07)

- **Wayland: pop-up windows land where they belong again** – On Wayland sessions (GNOME, KDE Plasma) the App Menu, Settings, Bug Report, Quick-Prompt and What's-New windows previously appeared at random positions across the screen, because Wayland forbids client-side toplevel positioning (Electron Issue #40886, marked not-planned by maintainers in October 2025). The app now starts under XWayland on Wayland sessions via `--ozone-platform=x11`, the same approach VS Code, Discord, Signal and Obsidian use. Pixel-accurate placement and `globalShortcut.register` work again. Trade-off: minor HiDPI softness with fractional scaling.
- **Bug Report window can no longer be opened multiple times** – Each click on the bug icon previously spawned a fresh window. A singleton guard now focuses the existing window instead.
- **App Menu (hamburger) closes cleanly on rapid double-clicks** – The 250 ms cooldown that prevents a close+reopen race is now set the moment `close()` is called, not in the asynchronous `closed` event.
- **Settings → Hotkeys: Wayland note** – When Wayland is detected, the settings window shows a hint explaining why a global shortcut may not register system-wide on GNOME/KDE; new `failed-wayland` status code distinguishes compositor refusal from a generic failure.
- **`npm run dev` script** added that launches Electron with `--no-sandbox --ozone-platform=x11` for local development on Wayland hosts.

### v1.3.8 – Snap Mic Live Status & Disclaimer (2026-05-07)

- **Unofficial-app disclaimer in the Bug Report dialog** – A prominent amber-coloured note explains that this is an unofficial community wrapper (not an official Anthropic product) and links directly to https://support.anthropic.com for account, login, subscription, billing or payment questions. Localised in DE/EN/FR/ES/IT.
- **Live Snap microphone status** in App Settings → Microphone: a coloured pill next to the toggle shows whether the `audio-record` plug is currently connected (green pulsing) or not (red), with 3-second polling while the settings window is open.
- **Snap-aware microphone toggle** – Turning the toggle on while the Snap plug is not connected automatically reopens the consent wizard, so the user is never left in a state where the toggle is on but recording silently fails.
- **Allow-button pulse on Snap status flip** – The consent dialog's Allow button briefly pulses and refocuses the moment `snapctl is-connected audio-record` flips to connected.
- **Notification heuristic with fallback selector stack** – `inject/notify.js` now tries four strategies (aria-label → data-testid → SVG `data-icon` → text content) to detect the claude.ai stop-button, so Background-Tab notifications keep working when claude.ai changes its DOM.
- **Unit tests** for the pure utility functions (`compareVersions`, `safeJson`, `isClaudeAiOrigin`, `validateAccelerator`) under `test/`, runnable via `npm test`.

### v1.3.7 – Auto-Update Self-Heal & Snap Cloudflare Fix (2026-05-06)

- **Auto-Update self-heal** – After an AppImage update, the app rewrites `~/.local/share/applications/claude-desktop.desktop` and `~/.config/autostart/claude-ai-desktop.desktop` to point at the current AppImage path. Fixes the long-standing "menu shortcut launches into the void after update" issue. Idempotent, Linux+AppImage only.
- **Bash wrapper for the Electron binary** – Adds `--no-sandbox` automatically when the app is launched without arguments (e.g. double-click from the file manager or `quitAndInstall`). Works around the Chrome SUID sandbox on AppImages without forcing users to remember the flag.
- **Snap Cloudflare fix** – Replaced `--disable-gpu` with `--use-gl=angle --use-angle=gl` in the Snap launcher. Cloudflare Turnstile was treating the SwiftShader fallback as a bot signal and looping the verification step; ANGLE-over-OpenGL gives Mesa GPU vendor strings while still avoiding the NVIDIA DRM hang the original `--disable-gpu` was added for.

### v1.3.6 – Voice Input & Live Notifications (2026-05-04)

- **Voice input permission architecture** – `media` permission strictly scoped to claude.ai (not to claudeusercontent.com artifact iframes that share the same session). Custom in-app consent dialog with a real three-state result, so closing the window with Escape isn't treated as "denied".
- **Snap microphone setup wizard** – Detects via `snapctl is-connected audio-record` whether the Snap plug is connected, polls every 1.5s, and links straight to the Snap Store permissions page. Per-dialog IPC channels prevent any other renderer from spamming the consent flow.
- **Live notification system** – Tab-bar banner that fetches `notifications.json` from the repo every 6h. Fields: `severity` (info/warn/critical/success), `title`, `body`, optional `link`/`linkLabel`, `minVersion`/`maxVersion`, `expires`, `if: snap|appimage`, `dismissible`. Per-ID dismiss state is persisted, so users only see each notice once. Lets us push urgent hints (e.g. Snap mic setup) without cutting a release.
- **Settings → Microphone section** added.

### v1.3.5 – Custom Menu, Markdown Export, Templates, Snap Clipboard Fix (2026-05-02)

- **Custom in-app menu (hamburger)** replaces the OS-native menu bar – keyboard navigation, click-outside-to-close, click-to-toggle. Direct tab-bar buttons for Markdown export and bug report.
- **Markdown export** of the active conversation via `Ctrl+Shift+E`.
- **Prompt templates** for the Quick-Prompt window – up to 50 named prefixes, picker via Tab.
- **Background-tab response notifications** – optional native notification when a non-active tab finishes responding.
- **Clipboard hotkey** – new global hotkey that opens a chat with your clipboard text inserted.
- **Snap copy & paste fix** – on Wayland sessions, the Snap version now uses native Wayland clipboard via `--ozone-platform-hint=auto` and `--enable-wayland-ime` instead of the broken XWayland path.
- **Bug report form localized** to French, Spanish and Italian.
- **Hotkey conflict messages** – specific status lines tell you which other hotkey owns the combo, instead of a generic failure.
- Hotkey persistence and auto-updater hardening (state only saved on success; update dialogs skipped during quit).
- Removed the unreliable Screenshot hotkey before stable release.

### v1.3.4 – Bug Report Form & Centering (2026-04-30)

- **In-app bug report form** replaces the previous "copy email and send manually" dialog. Description, optional error codes, optional contact email; opt-in toggle to include app version, OS and language. Submits directly via a hosted form endpoint, with manual email-copy fallback on network failure.
- **Sub-window centering** – bug report, app settings, what's-new and update dialogs now open centered on the main window (not on the display), so they appear over the app wherever you have it. Quick-Prompt stays display-centered (often triggered while the main app isn't visible).
- **Snap autostart** works without manual setup. Replaced the `personal-files` plug with the snap-native `autostart:` directive, written to `$SNAP_USER_DATA/.config/autostart/`. Auto-Review by the Snap Store is now possible (no more privileged interfaces).

### v1.3.3 – Artifact Previews & What's-New Refactor (2026-04-29)

- **Artifact previews** (HTML, React, wireframes) render again – `claudeusercontent.com` was missing from the allowlist. claude.ai uses that separate origin to sandbox user-generated content; without it, the artifact panel stayed empty.
- **What's-New shows skipped versions** – `getFilteredNotes()` now collects all release notes between `lastSeenVersion` and the current version, so a user who skips a release still sees what changed.

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

Sandbox active on all windows, IPC validated, CSP headers, Electron 41.

Known limitation: `--no-sandbox` required for AppImage (SUID sandbox incompatibility). Web content sandbox remains active.

---

## License

This project is an unofficial wrapper. Claude and claude.ai are property of Anthropic.
