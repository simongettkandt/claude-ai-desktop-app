# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.7] – 2026-05-06

### Fixed
- **Auto-update launch reliability (AppImage)**: the app now adds `--no-sandbox` automatically on Linux when launched without command-line arguments — for example via the system app menu or after `quitAndInstall()`. Previously the app could fail to come back up after an auto-update because the chrome-sandbox SUID helper isn't set up on most Linux systems.
- **`.desktop` files self-heal after auto-update (AppImage)**: on every start the app checks `~/.local/share/applications/claude-desktop.desktop` and `~/.config/autostart/claude-ai-desktop.desktop`, and rewrites the `Exec=` path if it doesn't match the currently running AppImage. Fixes the bug where the menu shortcut still pointed at the previous version's file after `electron-updater` had replaced it, leaving the launcher dead.

---

## [1.3.6] – 2026-05-04

### Added
- **Microphone access for voice input** on claude.ai. The first time you click the microphone icon, the app shows a one-time consent dialog. Choice persists; you can change it any time in App Settings → Microphone.
- **App Settings → Microphone section** with: an enable/disable toggle, an "Ask again on next microphone click" reset button, and on Snap an "Open in Snap Store" shortcut plus a copyable `snap connect` command. The reset button shows a transient "Done" confirmation after click.
- **Snap in-app permission wizard**: the consent dialog detects the `audio-record` plug status live via `snapctl is-connected`, shows a colored status indicator (green/red/amber), and offers two parallel paths — a smart "Open in Snap Store" button (tries `snap-store` → `gnome-software` → `plasma-discover` → `xdg-open` to skip the OS chooser dialog), and a copyable `sudo snap connect claude-ai-desktop:audio-record` command for users without a Snap GUI. Live polling auto-detects activation regardless of which path the user takes.
- `audio-record` plug declared in the Snap manifest (manual user-connect after install; no auto-connect request needed thanks to the in-app wizard).
- **Live notification system** in the tab bar. The app fetches `notifications.json` from the project's GitHub repo on startup and every 6 hours. JSON entries support `severity` (info/warn/critical/success), `title`, `body`, `link`/`linkLabel`, `minVersion`/`maxVersion`, `expires` (ISO date), `if: snap|appimage` and `dismissible`. Banners appear above the tab bar with severity-coloured accent; dismiss-state persists per notification ID. Used to communicate ongoing fixes (e.g. the Snap microphone Setup) without shipping a new release. Local override via `CLAUDE_NOTIFICATIONS_OVERRIDE=<path>` env var, plus auto-load of `./notifications.json` from the project root in dev mode.

### Fixed
- **Strict origin check for microphone permission**: only `claude.ai` and its subdomains can request the microphone. `claudeusercontent.com` (artifact iframes) is explicitly excluded so user-generated content can't inherit microphone access.
- **Dismissed-vs-denied distinction**: closing the consent dialog with X or Escape leaves the choice neutral (the dialog will reappear on the next microphone request) instead of being treated as "permanently denied". Only a deliberate click on Allow or Deny persists the decision.
- **Allow button blocked while Snap permission is missing**: prevents the silent-failure path where users click Allow but the Snap plug isn't connected yet and recording fails without feedback.
- **Per-dialog IPC channels** for microphone-related communication so cross-dialog interference is impossible. Preload exposes only whitelisted channel prefixes.
- **Async `snapctl` polling** instead of synchronous `execFileSync`, so the main thread is never blocked by a slow `snapctl` call (1.5 s polling interval, every check non-blocking).

### Changed
- **Whats-New 1.3.6 microphone note for Snap** describes the in-app wizard flow rather than a `sudo snap connect` terminal command.
- **Defensive `</script>` escaping** for inline JSON embeds in Settings, Quick-Prompt and the new microphone consent dialog (preventive — current strings are hardcoded, but the helper is now in place if i18n ever becomes dynamic).
- **Refactor**: shared dialog CSS extracted into `sharedDialogCSS()` (ends ~30 lines of duplication between message-box and microphone consent dialogs); `openSnapStorePage()` helper centralises the `snap://` deep link; inline `style="…"` attributes in Settings replaced with CSS classes (`.snap-actions`, `.hint-block`).

---

## [1.3.5] – 2026-05-02

### Added
- **Custom in-app menu (hamburger icon)** in the tab bar replaces the OS-native menu bar. Keyboard navigation (arrows, Enter, Esc), click-outside-to-close, and re-clicking the icon now toggles the menu instead of reopening it.
- **Direct buttons in the tab bar** for Markdown export and bug report — no menu detour needed for the most-used actions.
- **Markdown export** of the active conversation via `Ctrl+Shift+E` or the menu. Captures user/assistant turns including code blocks, lists, headings, blockquotes and links.
- **Prompt templates** for the global Quick-Prompt window. Define named prefixes in App Settings (e.g. "Translate to English:"); pick them with Tab in the Quick-Prompt window. Up to 50 templates, 40-char names, 2000-char prefixes.
- **Background-tab response notifications**: optional native notification when Claude finishes a response in a tab you're not currently looking at. Toggleable in App Settings.
- **Clipboard hotkey**: a separate global hotkey that opens a new chat and inserts the current clipboard text as the prompt.
- **Bug report form localized** to French, Spanish and Italian (previously only DE/EN had the full form).
- **Heart-icon thank-you note** in the What's-New popup with a friendly nudge to send bug reports via the in-app form.
- **Specific hotkey conflict messages** — when assigning a Quick-Prompt or Clipboard hotkey to a combination already used by the other hotkey, the status line now names the conflict instead of showing a generic "registration failed".

### Fixed
- **Snap copy & paste on Wayland sessions** — the Snap version now launches with `--ozone-platform-hint=auto` and `--enable-wayland-ime` on Wayland (and explicit `--ozone-platform=x11` on X11 sessions), so the native session clipboard is used instead of the broken XWayland path.
- **Hamburger menu re-click toggle** — clicking the menu icon while the menu is already open now closes it instead of immediately reopening due to the blur-then-reopen race.
- **Settings template placeholder** broke the `placeholder="…"` HTML attribute in the EN locale because of unescaped ASCII double quotes. Replaced with typographic quotes.
- **Hotkey persistence on conflict** — registering a hotkey that conflicts with the other one no longer clears the previously active hotkey. State is only persisted on successful registration.
- **Auto-updater during quit** — update-related dialogs (downloaded / not-available / error) are now skipped while the app is shutting down, so no prompt appears on a window about to be destroyed.
- **Quick-Prompt length limit consistency** — preload now drops submissions over 8000 chars (matches main-process limit). Was 10000 in preload, silently dropped in main.

### Changed
- **Snap launch script**: `XDG_CURRENT_DESKTOP=Unity` is scoped to the claude-desktop process only (via `env`) instead of being exported globally. Prevents leakage into `shell.openExternal` subprocesses like `xdg-open`.
- **Template IPC return schema** unified: both `addTemplate` and `deleteTemplate` now return `{ templates: [...] }`. Previously `deleteTemplate` returned the array directly.

### Removed
- **Screenshot hotkey** (sending a tab screenshot to a new chat) — was unreliable on Linux clipboard and dropped before stable release.

---

## [1.3.4] – 2026-04-30

### Added
- **In-app bug report form** replaces the previous "copy email and send manually" dialog. Has a description field, optional error-codes field, optional contact email, and an opt-in toggle to include app version, OS and language. Submits directly via a hosted form endpoint; on network failure the manual email-copy fallback is shown.

### Fixed
- **Snap autostart** now works without any manual setup. Replaced the `personal-files` plug with the snap-native `autostart:` directive — the desktop file is written to `$SNAP_USER_DATA/.config/autostart/` and snapd-userd handles launching at login. Auto-Review by the Snap Store is now possible (no more privileged interfaces).

### Changed
- **Sub-window centering**: bug report, app settings, What's-New popup and custom message dialogs now open centered on the main window (not on the display), so they appear over the app wherever you have it. Quick-Prompt stays display-centered (often triggered while the main app isn't visible).
- AppImage path for autostart unchanged (`~/.config/autostart/claude-ai-desktop.desktop` with `Exec=$APPIMAGE --no-sandbox`).
- Settings UI: removed the "manual `sudo snap connect`" notice — no longer needed.

---

## [1.3.3] – 2026-04-29

### Fixed
- Artifact previews (HTML, React, wireframes) now render again — the app was blocking `claudeusercontent.com`, the separate origin claude.ai uses to sandbox user-generated content. Allowlist extended in `isAllowedDomain`.

### Changed
- What's-New popup now shows release notes for **all** versions a user skipped, not just the current one. Useful for Snap users who jump across versions due to background updates (e.g. 1.3.1 → 1.3.3 still surfaces the 1.3.2 Snap autostart setup hint).

---

## [1.3.1] – 2026-04-26

### Added
- New tray icons: transparent sparkle (Modern: gradient `#FF6A2A → #E04E3F`, Classic: solid `#F26A3F`)
- Autostart toggle in App Settings — on Linux, the app writes its own `.desktop` file to `~/.config/autostart/` since `app.setLoginItemSettings()` is a no-op on Linux
- Custom message box helper (`showCustomMessageBox` + `preload-messagebox.js`) replaces all `dialog.showMessageBox` calls

### Fixed
- Code-tab sidebar: OAuth cleanup lifecycle now only triggers for actual OAuth domains; non-OAuth child windows stay open
- Quick-Prompt: removed auto-submit, text is now inserted and waits for the user
- Download dialog deduplication (active-lock + 3s cooldown) — fixes double-prompt on some claude.ai download links
- `will-navigate` now opens external links via `shell.openExternal` instead of silently blocking them
- Linux GTK dialogs no longer land on the wrong monitor when the main window is on a non-primary display

---

## [1.3.0] – 2026-04-22

### Added
- System Tray with optional minimize-to-tray
- Global hotkey (configurable) opens Quick-Prompt window with animated gradient border; text is injected into a new chat via `execCommand('insertText')`
- Quick-Prompt window: transparent, frameless, always-on-top
- What's-New popup, shown once after each version upgrade
- App Settings window (hotkey, minimize-to-tray)
- Update check now shows a dialog for "available", "no updates", and "error"
- Background throttling at 10 fps when minimized

### Changed
- Tab bar accent now matches logo gradient (`#F26A3F → #E83B6E`), plus button moved to the right
- Build optimization: `electronLanguages: ["en-US", "de"]` saves ~30 MB
- AppImage size: ~103 MB (down from ~120 MB in v1.2.2)
- Electron 41.2.1, electron-builder 26.8.2

### Fixed
- Multi-monitor: child windows now center on the display containing the main window (via `screen.getDisplayMatching(mainWindow.getBounds())`)
- Window position is clamped to available displays on startup, preventing windows from spawning on disconnected monitors

### New files
- `preload-settings.js`, `preload-quickprompt.js`, `preload-whatsnew.js`

---

## [1.2.2] – 2026-04-12

### Fixed
- Crash on app close (`mainWindow` check in `closeTab`)
- Window state no longer saved with wrong bounds when minimized
- Auto-updater logging now runs in production (was dead code under `if (isDev)`)
- Memory leak in OAuth popup — `closed` handler added to `childWindow`
- Resize after tab close no longer crashes (added `alive()` guard)
- `render-process-gone` handler: arrow parameter `t` no longer shadows i18n function `t()`
- Theme toggle now persists window state
- Auto-updater backoff resets `failures = 0` on successful check
- `inject/brand.js`: console warning when no recoloring is possible

---

## [1.2.1] – 2026-03-28

### Changed
- Performance rewrite of main process

### Fixed
- Various security fixes

---

## [1.2.0] – 2026-03-26

### Changed
- Upgrade to Electron 41.0.4
- Migration from deprecated `BrowserView` → `WebContentsView`

### Added
- Light mode glow effect

### Fixed
- 0 npm audit vulnerabilities
- OAuth error dialog ("Object has been destroyed")

---

## [1.1.4] – 2026-03-26

### Added
- Modern/Classic design toggle
- Gradient accents and brand recoloring via CSS variable overrides
- Input glow effect (dark + light mode)
- Tab bar visual redesign

---

## [1.1.3] – 2026-03-23

### Added
- IPC validation (type, integer, bounds checks)
- CSP meta tags for tab bar and offline page
- Crash rate limiting (max 3 reloads per tab)
- LRU domain cache

### Changed
- Tab pool reduced from 2 to 1 view (~190 MB less RAM)

### Fixed
- Memory leak: OAuth popup event listener cleanup

---

## [1.1.2] – 2026-03-20

### Added
- Tab system with visual tab bar
- Dark/Light mode toggle
- In-App OAuth popups (GitHub, Google Drive, GitLab, Bitbucket, Microsoft)
- GPU acceleration flags, disk cache, tab preload pool

### Changed
- AppImage size reduced from 1.3 GB to 103 MB

---

## [1.1.1] – 2026-03-18

### Added
- Bilingual UI (DE/EN) with automatic language detection
- Dynamic User-Agent (uses current Chrome version)

### Fixed
- URL validation via `new URL().hostname` (phishing protection)

---

## [1.1.0] – 2026-03-18

### Added
- Automatic updates via GitHub Releases (`electron-updater`)
- AppImage format for all Linux distros
- Official Claude icon

---

## [1.0.1] – 2026-03-18

### Added
- Sandbox enabled on all `webPreferences`
- Secure URL checking

### Fixed
- Window focus bug

---

## [1.0.0] – 2026-03

### Added
- Initial release
- BrowserWindow loading claude.ai with Chrome User-Agent
- Google OAuth popup handling
- Dark mode

[1.3.1]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.3.1
[1.3.0]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.3.0
[1.2.2]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.2.2
[1.2.1]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.2.1
[1.2.0]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.2.0
[1.1.4]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.1.4
[1.1.3]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.1.3
[1.1.2]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.1.2
[1.1.1]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.1.1
[1.1.0]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.1.0
[1.0.1]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.0.1
[1.0.0]: https://github.com/simongettkandt/claude-ai-desktop-app/releases/tag/v1.0.0
