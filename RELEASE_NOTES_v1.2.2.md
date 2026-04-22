## v1.2.2 — Stability Refresh (2026-04-14)

This release republishes v1.2.2 with a bundle of **11 stability and memory fixes**. The version number is unchanged on purpose — the auto-updater will treat existing installs as already up to date, so no reinstall is required unless you want the fixes right now.

### Bug fixes

- **Window bounds no longer corrupted when minimized** — `saveWindowState()` now bails out early if the window is minimized, preventing off-screen positions on next launch.
- **Child-window memory leak fixed** — added the missing `closed` handler that kept destroyed windows referenced.
- **WebContents listener leak fixed** — `removeAllListeners()` is now called before closing a tab's webContents, preventing handler accumulation.
- **Theme preference is now persisted** — dark-mode and custom-design toggles survive a restart.
- **Auto-updater backoff reset** — the failure counter now resets after a successful `update-not-available` event, so a single past error no longer throttles future checks.
- **Update errors logged in production** — previously only visible in dev mode.
- **Guard against destroyed WebContentsViews** in `updateActiveTab`, preventing crashes on rapid tab close.
- **Variable shadowing cleaned up** (`t` → `tab`) in tab iteration callbacks.
- **Extra destroy-checks** on shutdown to avoid race conditions when closing all tabs.

### Download

- `Claude-Desktop-1.2.2.AppImage` — universal Linux build
- `latest-linux.yml` — required for the auto-updater; do not omit

### Install

```bash
chmod +x Claude-Desktop-1.2.2.AppImage
./Claude-Desktop-1.2.2.AppImage --no-sandbox
```

The `--no-sandbox` flag is needed on systems where the Chromium SUID helper is not configured. The in-process web content sandbox remains active.
