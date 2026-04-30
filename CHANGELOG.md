# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.3.4] – 2026-04-30

### Fixed
- **Snap autostart** now works without any manual setup. Replaced the `personal-files` plug with the snap-native `autostart:` directive — the desktop file is written to `$SNAP_USER_DATA/.config/autostart/` and snapd-userd handles launching at login. Auto-Review by the Snap Store is now possible (no more privileged interfaces).

### Changed
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
