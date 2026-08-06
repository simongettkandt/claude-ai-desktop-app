# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.4.14] - 2026-08-06 - Blank Screen Root Fix

### Fixed
- **The chat area still went black after a while.** This time the cause is measured instead of inferred: `webContents.setBackgroundThrottling(false)` sets `disable_hidden_` on the render widget host, after which the renderer ignores every hide. With the content view hidden, `requestAnimationFrame` keeps firing, so renderer and native view disagree about visibility. On the way back no `WasShown` arrives, no new frame is requested, and the layer keeps showing its background colour, which in the OLED theme is the same black as an empty frame. All runtime `setBackgroundThrottling` calls are gone. Background tabs are throttled by hiding them, which the webPreferences default already does, verified in `test/frame-watchdog.test.js`.
- **A redraw that did not help was repeated forever.** The watchdog now escalates: redraw, then a bounds nudge, then detaching and re-attaching the content view, which gives it a fresh compositor layer without reloading the page. Detection is more reliable as well: the renderer answers each heartbeat twice, immediately and from `requestAnimationFrame`, so "alive but no frames" is distinguishable from a merely busy renderer. A stalled surface is caught in about 8 seconds instead of 20.
- The content view's bounds are no longer nudged while the window is hidden or minimized. That left behind a surface id whose frame the compositor then waited for.

### Added
- "Copy diagnostics info" reports how often the surface had to be repaired and at which escalation stage.

---

## [1.4.13] - 2026-08-01 - Blank Screen Recovery

### Fixed
- **The chat area went black after a while and only came back on a tab switch.** The tab bar kept rendering normally, so the page itself was fine: what stalled was the compositor surface of the content view. It was most visible in the OLED theme, where the view's background colour is the same black as an empty frame. The app now watches whether the renderer still receives frames (`requestAnimationFrame` goes silent when the surface stalls, while IPC and timers keep running) and redraws after three silent checks, so within about 20 seconds. The redraw is also triggered by events that were previously unhandled: moving the window to another monitor (which produces no resize on X11 as long as the window size stays the same), display configuration changes, screen wake-up after DPMS or the lock screen, and regaining window focus.
- **Background tabs were never actually throttled.** The throttle was applied after hiding the tab, but the flag only takes effect on the next visibility change, so it was a no-op and every tab you had opened kept rendering at full cost while invisible. Measured with three background tabs, renderer CPU drops from 13.5% to 6.7%. The same ordering mistake made "Redraw" (Ctrl+Alt+R) weaker than a real tab switch.

### Changed
- Removed the `setFrameRate` calls used for throttling. Per the Electron API they only take effect with offscreen rendering, which this app does not use, so they never did anything.

---

## [1.4.12] - 2026-07-22 - Instant Theme Switching

### Fixed
- **Switching to the White theme froze for about half a second.** White flipped claude.ai's whole page to its light palette (a `prefers-color-scheme` change), which made claude.ai recompute the style of every visible element, measured at ~480ms and unaffected by chat length. White now keeps claude.ai in its dark palette and inverts the page on the GPU instead (`filter: invert(1) hue-rotate(180deg)` at the root, with real images inverted back), so only one property changes on the root. Measured ~6ms instead of ~480ms, on par with the OLED and Dark switch. White is therefore a colour-faithful inversion of the dark theme rather than claude.ai's native light theme.
- **The OLED theme visibly built up on a cold start.** The full theme was applied by a script injected at `dom-ready`, but that script waited behind claude.ai's own startup work on the main thread and only ran about 1.7s in, so the page first showed claude.ai's default styling and then snapped to the theme. The complete static theme is now applied before the first paint (from the same single source), so restored content appears already themed. The underlying multi-second main-thread block during claude.ai's load is claude.ai's own and unchanged.
- **Theme rendering felt slow while a response streamed.** In OLED mode the starfield behind open dialogs was hidden with a CSS `:has()` selector, which the browser re-evaluated on every change to the page. While a response is being written claude.ai changes the page many times per second, so this ran constantly and made the display feel sluggish. Measured, the selector added noticeable cost per change; the starfield is now toggled by a lightweight attribute instead, with no measurable per-change cost.

### Changed
- The colour-variable scan no longer runs a canvas fallback on values that can never be colours (`var()`, `calc()`, timing functions), removing a few hundred wasted GPU read-backs per scan.
- An identical theme stylesheet is no longer rewritten on tab switches or in-page navigation, so the browser does not re-parse and re-style for no change.

---

## [1.4.11] - 2026-07-19 - Theme Fix and Tab Persistence

### Fixed
- **Brand icons rendered grey instead of coloured.** In the Modern design with dark or OLED mode, the spark above the greeting and other accent icons fell back to the text colour. The Modern recolor wrote a hex value into `--accent-brand`, but claude.ai consumes that variable as a bare HSL triplet via `hsl(var(...))`; a hex made the declaration invalid, so the colour fell through to `inherit`. The variable is now skipped and `.text-accent-brand` is coloured directly. Measured before/after: `rgb(195,194,183)` vs `rgb(232,82,79)`.
- **Tabs reset to a new chat after a connection dropout.** A tab's URL was recorded once at creation and never updated, so nothing knew which conversation a tab held. The offline page also replaced the active tab with a `data:` URL, which a later reload simply re-rendered, and background tabs stayed stuck on it permanently. Tab URLs now track navigation (including SPA route changes), reconnect restores every stuck tab to its own conversation, and the "Try Again" button returns to the conversation instead of opening a new chat.
- **Sidebar could look missing in OLED mode.** The pre-paint stylesheet flattened `nav`/`aside` to the same black as the chat area but omitted the 1px divider from the theme controller, leaving a 1.0:1 edge. The divider is now part of the pre-paint sheet, so it holds even if the controller runs late.
- **Artifact preview windows flashed white.** Child windows opened by claude.ai inherit the session but not `setBackgroundColor`, so they flashed white in OLED mode before painting.
- **A tab could stay throttled at 10 fps.** `switchToTab` cleared background throttling but never restored the frame rate, which only `throttleActiveView` touches. If a window event was missed after minimizing, the tab kept rendering at the reduced rate.

### Added
- **Open tabs are restored after a restart.** The session's conversations are persisted and reopened on the next start. Restored tabs load lazily on first click rather than all at once.
- **Redraw entry in the View menu (Ctrl+Alt+R).** Reattaches the compositor surface for the active view without switching tabs, for cases where the chat area goes blank. Mirrors the tab-switch workaround, which was previously the only way to recover.
- **Relayout after window restore.** The settle relayout was bound to resize only, so a restored window with a stale surface had no trigger at all.
- **Online state is checked on window focus.** Previously the app waited for the 60-second poll before noticing the connection was back.

---

## [1.4.10] - 2026-07-14 - Bug Report Clarity

### Added
- **Confirmation gate before a bug report is sent.** The Send button stays disabled until a required checkbox is ticked ("This is a problem with the Linux desktop app itself"). An affirmative action is harder to skip than a passive notice, which cuts down account/login/billing messages that belong with Anthropic support. Localized in DE/EN/FR/ES/IT.
- **Support keyword hint in the report form.** When the description mentions login, password, subscription, billing, refund and similar, an inline note points to support.anthropic.com. It is a nudge, not a block; the checkbox stays the hard gate.

### Changed
- **Sharper unofficial-wrapper notice.** The bug report disclaimer now states plainly that the message reaches a single volunteer developer, not Anthropic, and that account/login/subscription/billing questions (and anything that also happens on claude.ai in a normal browser) can only be handled by Anthropic. The Snap Store description got the same rework, with the unofficial/trademark notice and the support link moved above the contact email.

---

## [1.4.9] - 2026-07-03 - OLED Checkout & Recolor Fix

### Fixed
- **Black bars on the OLED upgrade/checkout page.** `buildStaticCSS()` matched background tokens with substring selectors like `[class*="bg-neutral-9"]`, which also matched Tailwind's opacity-modifier classes, e.g. `bg-neutral-900/5` (a light tint used for a price chip), and painted them fully opaque black, making the dark text meant for a light chip background invisible. A new `safeBg(tokens, color)` helper now generates the selectors with `:not([class*="TOKEN/"])`, so the opacity variant is excluded while the plain class is still blackened.
- **Classic/Modern brand recolor stopped working on some pages.** `buildVarsCSS()` detected the brand orange in claude.ai's CSS custom properties only through the regex-based `parseRGB()`, which understands hex/`rgb()`/`hsl()` but not newer CSS color functions like `oklch()` or `color-mix()` (Tailwind v4's default). A new `normalizeColor()` fallback renders unparseable color values onto a 1x1 canvas to get real sRGB pixels back, since `getComputedStyle()` does not reliably normalize these to `rgb()` in Electron 41 / Chromium 146 (verified against the running build; canvas pixel sampling does).

---

## [1.4.8] - 2026-06-29 - Cloudflare Verification Fix

### Added
- **Reset button in the toolbar.** "Reset claude.ai verification" is now reachable directly via a shield icon in the tab-bar toolbar (own IPC channel `tabbar-reset-verification` -> `resetClaudeVerification()`), not only via the hamburger menu. The stuck-verification banner also appears faster now (after 8s instead of 18s).
- **Redesigned What's-new window.** The update overview is now a slideshow: one slide per release note, navigable with next/back, dots or arrow keys, with a staggered entrance animation. Notes always show the current version only. Each note can carry an optional image (embedded as a data-URL at runtime, string or per-locale `{de,en,fr,it}`), shown above the title; the 1.4.8 lead note uses `whatsnew/cf-verify.png`.

### Fixed
- **Cloudflare verification client-hints mismatch.** The `onBeforeSendHeaders` rewrite forged a `Sec-Ch-Ua` / `Sec-Ch-Ua-Full-Version-List` brand set that included `"Google Chrome"` plus the GREASE token `"Not(A:Brand"`, while `navigator.userAgentData` in the same Electron 41 (Chromium 146) build reports only `[Not-A.Brand, Chromium]` with no Google Chrome. A header claiming a brand the JS Client-Hints API denies is a bot signal that could send the Cloudflare Turnstile check into a `"Verifying..."` loop. The header now mirrors the native brands exactly (`"Not-A.Brand";v="24", "Chromium";v="146"`, full-version-list to match), verified on the actual binary (wire header == `navigator.userAgentData`).

### Changed
- **Stopped sending `DNT: 1`.** The header rewrite added `DNT: 1` to every claude.ai / challenge request; stock Chrome on Linux does not send DNT, so it was dropped to match a default browser profile.
- **Honest stuck-verification banner.** When the full-page Cloudflare interstitial loops past 8s, the in-page banner now states that Reset only clears cookies/cache (which only helps a stale-cookie loop) and that a persistent loop is most likely the network address: an active VPN is often the cause (turn it off for claude.ai), otherwise a different network helps. Updated in all four locales (de/en/fr/it). This steers the genuinely-stuck (IP-reputation) case toward the action that works instead of repeated resets.

### Notes
- The client-side bot signal is now removed, but Cloudflare's dominant factor is IP reputation, which is server-side and unaffected by any client change. A flagged network/VPN IP can still be challenged; switching to a better-reputation network is the only reliable fix in that case. The Snap build was audited for confinement-specific blocks (cookie persistence across revisions, AppArmor denials, DNS, TLS, GPU); none cause the verification loop.

---

## [1.4.7] - 2026-06-24 - OLED Polish & Window Frame

### Added
- **Subtle window frame.** A 1px frame now wraps the main window and the dialogs (settings, about, what's new, bug report). It is the tab bar's `border-image` showing through a 1px inset left around the embedded `WebContentsView`, so no transparency is involved. The gradient runs lighter at the top to darker at the bottom (soft-depth) and the color follows the theme (`frameHi`/`frameLo` per mode).

### Changed
- **OLED separation via hairlines instead of near-black surfaces.** In OLED mode the surface tones (`#050306` / `#120f12` / `#1a1517`) sit under 1.2:1 contrast and blur together on the panel. Menus, dialogs and popovers now get a warm 1px border plus a drop shadow, the sidebar gets a `border-right` against the same-black chat area, and claude.ai's newer `bg-surface-*` tokens are mapped to the OLED palette (previously only `bg-bg-*` was), so the settings content pane is no longer a light gray block next to the black sidebar.
- **Close button follows the design accent.** The `#win-close` hover was a fixed red (`#e05e3e`); it now uses the same accent gradient as the new-tab button, matching Modern (orange to pink) or Classic (terracotta).

### Fixed
- **Focus ring no longer reads as an error.** The OLED focus outline had been bumped to a 2px fully-opaque accent ring, which looked like a validation error on the settings search field. It is back to a thin, semi-transparent ring with an offset.
- **Background stars no longer shimmer through modals.** The OLED sparkle background showed through the dimmed backdrop behind dialogs. It is now hidden while any `[role="dialog"]` / `[aria-modal="true"]` is open.
- **Composer no longer shows a focus stripe while typing.** The same focus ring also hit the `contenteditable` composer; `contenteditable` and `[role="textbox"]` are now excluded, so typing stays clean.
- **Black window when tiling.** Tiling the window to half the screen could leave it fully black with only the title bar visible. The 1.4.6 split-screen fix only re-applied bounds, which is a no-op on X11 when the geometry is unchanged and the compositor surface is stale. The settle pass now also forces a real 1px size delta (shrink, then restore) to trigger a recomposition.

---

## [1.4.6] - 2026-06-23 - Crash & Split-Screen Fixes

### Fixed
- **A stray "A JavaScript error occurred in the main process" dialog no longer appears.** `electron-updater` logs through `console.info` during its periodic update check (`AppImageUpdater.isUpdaterActive`). On the Snap build, stdout/stderr is a pipe that can be closed, so the write threw `EPIPE`, and with no handler Electron surfaced its default crash dialog, recurring on every check. stdout/stderr now swallow `EPIPE` (logging must never crash the app), and the in-app updater no longer runs on Snap at all, where it can't update a read-only Snap anyway and the Store handles updates. Snap-only.
- **Split-screen / tiling no longer leaves the page mis-sized.** When the window was tiled to half the screen, the `WebContentsView` could keep stale bounds on X11: the page shifted toward the top, with a gray strip of bare window left at the bottom. The active view is throttled on `resize`; a debounced settle pass (200 ms after the last resize event) now clears the bounds cache and re-applies the final `getContentBounds()`, so the page re-fits the settled window size.
- **Hardened other main-process crash vectors.** `shell.openExternal` returns a promise that can reject under Snap (portal/xdg-open unavailable); the call sites had a synchronous try/catch that does not catch a rejection, so an unhandled rejection could surface the crash dialog. All seven sites now route through an `openExternalSafe()` helper, and the bare `new Notification().show()` calls reachable in normal use (clipboard hint, export done, online/offline, download done/failed) are wrapped so a throw under strict confinement cannot crash the main process. Added an `unhandledRejection` logger as a last line. A failed download move (rename + copy both throwing) no longer leaks the staged temp file.
- **Manual "Check for Updates" gives feedback on Snap.** The in-app updater no longer runs on Snap, so the manual menu action used to call into unregistered handlers and do nothing visible. It now reports that updates are managed by the Snap Store.
- **Connector sign-in robustness.** OAuth popups that open a nested window (e.g. Microsoft sign-in) now keep that window in-app on the claude.ai session instead of spawning an uncontrolled default window. Subframe navigation is tightened so an embedded iframe can no longer follow an arbitrary OAuth-shaped https URL unless the top-level page is claude.ai, and a sign-in that has left claude.ai onto a provider is now bounded to that provider's own domain rather than allowing any https host in-app.

---

## [1.4.5] - 2026-06-17 - Alt+Tab Focus Fix

### Fixed
- **Keyboard focus returns to the page after Alt+Tab.** The main window is frameless and its custom tab bar is the top-level web contents, holding the window controls (minimize/maximize/close). When the window regained focus via Alt+Tab (or from the tray), keyboard focus stayed in that bar and landed on the first button, minimize, so the first Space/Enter minimized the window instead of reaching the chat input. On window `focus`/`restore` the app now redirects keyboard focus to the active tab's web contents, deferred past Electron's own focus restore, so you can type right away.

---

## [1.4.4] - 2026-06-14 - Verification Loop Fix

### Fixed
- **`Sec-CH-UA-Platform-Version` no longer leaks the kernel version.** The claude.ai session set this client-hint header from the raw kernel release (e.g. `6.8.0`, or `7.0.9` on CachyOS), but real Chrome on Linux always sends an empty value here, and the in-page `navigator.userAgentData` reported empty as well. The mismatch was a clear bot signal to Cloudflare and could trap the security check ("Performing security verification") in a loop. The header is now sent as the empty structured-field string `""`, matching real Chrome on Linux (verified against Chromium 149). Affects all Linux users; CachyOS was most exposed because kernel major 7 does not exist upstream.

---

## [1.4.3] - 2026-06-11 - Design Refresh, Connectors & Snap Files

### Fixed
- **Custom connectors connect in-app again.** When claude.ai opened the sign-in popup for a custom connector, the wrapper only treated a fixed allowlist of hosts (Google, GitHub, etc.) as in-app OAuth popups; any other host was pushed to the system browser, where the callback never returned to the app session. A custom MCP/connector server is by definition an unknown host, so its OAuth flow was lost (same class as the v1.3.12 Higgsfield fix). `setWindowOpenHandler` now also opens a popup in-app when it originates from a claude.ai page and the target URL looks like an OAuth2 authorize endpoint (`response_type=`/`client_id=`/`redirect_uri=` query or `/oauth|authorize|sso` path), and the same OAuth-URL detection exempts same-window navigations in `will-navigate`/`will-frame-navigate`, so clicking "Approve" on the authorization page (which redirects to the provider) is no longer blocked. Normal external links still open in the system browser.
- **Snap: file dialogs go through the portal.** `electron-launch` now sets `GTK_USE_PORTAL=1`, so the open/save dialogs and the HTML file picker use `xdg-desktop-portal`. The document portal grants access to chosen files outside `$HOME` via a file descriptor, addressing "cannot attach a file" / "cannot save a download" under strict confinement.
- **Theme injection limited to claude.ai pages.** OLED/brand styling and the helper scripts no longer run on OAuth provider pages (Google, Linear, etc.) that load during a connector sign-in. Those login pages were previously recoloured to near-black (unreadable in OLED) and our MutationObservers could disturb the provider's OAuth JavaScript, surfacing as "Invalid flow state".
- **Snap: clipboard hotkey recognises images.** The clipboard-to-chat hotkey reported "clipboard is empty" when the clipboard held a screenshot (an image, not text). It now detects an image and points to pasting it directly with Ctrl+V.

### Added
- **Snap: `removable-media` plug.** Declares access to external drives (`/media`, `/run/media`) for attaching and saving files. Standard interface, no manual store review; connect with `sudo snap connect claude-ai-desktop:removable-media`.

### Changed
- **New app logo.** A new spark logo (orange-to-magenta on a dark tile) replaces the previous icon across the window, dock, tray and in-app surfaces.
- **Reworked theming engine.** `inject/brand.js` and `inject/oled.js` are replaced by a single attribute-scoped controller (`inject/theme.js`). The three themes (Light, Dark, OLED) are cleanly separated and switched by flipping a `data-cd-theme` attribute instead of a disable/re-inject cycle. A luminance "surface" gate keeps OLED from bleeding onto light claude.ai sub-apps (e.g. the Claude Design tool, where it previously turned inputs unreadable). OLED now renders consistently deep black including the home screen, with a faint 5-point starfield sitting behind content so the composer, previews and panels stay clear. The background gradients, which did not land well with many users, are removed everywhere: the chat background, the sub-windows and the hamburger menu (plus its logo). The light mode no longer carries a reddish brand tint.
- **Theme applies without lag.** The variable recolouring runs synchronously on apply (measured ~3ms), so the theme is in place immediately at startup and on new tabs instead of filling in roughly 1.5s after the first paint. A `requestIdleCallback`-deferred recolour pass added during development had caused that delay. The tab pre-warm pool was raised from one to two and refills after 1.2s instead of 3s, so the second tab is warm more often.
- **Updated Electron to 41.7.1** (current Chromium security fixes), electron-builder to 26.15.2, electron-updater to 6.8.9.

### Notes
- The `GTK_USE_PORTAL` file-dialog behaviour, the connector "Approve" flow, and the reworked theming across all three themes plus a light sub-app are to be verified against a real build before release.

---

## [1.4.2] - 2026-06-02 - Italian & French, Snap Notifications

### Added
- **App interface in Italian and French.** The whole app UI (tab bar, tray, native and app menus, Settings, About, What's New, Quick-Prompt, bug-report confirm dialogs, microphone consent, offline page, download/update notices, Markdown export labels) is now available in Italian and French on top of German and English. `t(de, en)` was extended to `t(de, en, fr, it)` with an English fallback, driven by the existing `sysLang` system-language detection; `localize()` for release notes follows the same scheme. The app picks the language from the system locale and stays on English when the locale is not one of the four. What's New shows a short FR/IT notice inviting users to report translation glitches via the bug-report form.

### Fixed
- **Snap notifications attribute to the app again.** Electron builds the libnotify `desktop-entry` hint from `$CHROME_DESKTOP`, which was never set in the Snap. Without it GNOME Shell cannot map the notification to the app and drops it under strict confinement. The Snap now sets `CHROME_DESKTOP=claude-ai-desktop.desktop`. This is the suspected cause of the v1.3.13 report that notifications were not coming through, and replaces the bogus `desktop-notifications` plug attempt from 1.4.1.
- **OLED tab bar colour is now consistent.** The tab-bar live-switch palette used `#000000` (with slightly different hover/active/border tones) while a fresh start in OLED used the central `#050306` palette, so the bar changed shade depending on how you entered OLED. The live-switch palette now matches the central OLED palette.
- **Settings status dot follows the theme.** The default microphone-status dot was hardcoded to the dark-theme text tone, slightly off in Light and OLED.

### Changed
- **Snap image slightly smaller.** `LICENSES.chromium.html` (19 MB uncompressed) is excluded from the Snap, which trims roughly 2 MB off the compressed download.
- **Snap: icon writes to `~/` are skipped under confinement.** `toggleDesign()` no longer copies icons into `~/Apps` and `~/.local/share/icons` when running as a Snap, where those paths are a no-op and only produced journal noise.

### Notes
- The notification fix is under verification against a real Snap build. The store-listing and release-note wording will be confirmed once the build is tested, to avoid another premature claim like the 1.4.1 `desktop-notifications` plug.

---

## [1.4.1] - 2026-05-29 - Localized Release Notes

### Fixed
- **"What's New" window now follows the system language.** Release-note titles and bodies were hard-coded in German, so users on non-German systems kept seeing the German strings even though the rest of the UI was localized. All entries from 1.3.0 through 1.4.0 now carry both `de` and `en` text, resolved through a new `localize()` helper at render time.

### Added
- **`RELEASE_NOTES_REVISIT` map.** When the current version is listed, its referenced predecessors are added to the What's New view. 1.4.1 carries 1.4.0 along so non-German users can read the previously garbled 1.4.0 highlights in their language.
- Small i18n cleanup in the live-notifications tab-bar template: the "More" link label and the close-button tooltip now use `t()` instead of hardcoded German.

### Notes
- An earlier draft of 1.4.1 also declared a `desktop-notifications` plug in the Snap manifest, billed as a fix for the v1.3.13 report that notifications from claude.ai were not coming through. The plug does not exist as a snapd interface (snapd dropped it silently with an `unknown interface` warning at install). The required interfaces for `org.freedesktop.Notifications` DBus access (`desktop`, `desktop-legacy`) are already provided by the `gnome` extension and were already connected on every previous Snap release. The plug entry has been removed; the underlying notification report remains under investigation.

---

## [1.4.0] - 2026-05-27 - OLED Mode & Frameless Window

### Added
- **Frameless main window with custom window controls.** The system title bar is gone; the tab bar now hosts its own Minimize, Maximize/Restore and Close buttons on the right (GNOME order). The whole free area of the tab bar is a drag region, double-click toggles maximize. New IPC channels `win-minimize`, `win-toggle-maximize`, `win-close`, `win-state-request` with sender check (only `mainWindow`).
- **OLED theme as a third theme.** The sun/moon button in the tab bar now cycles Light → Dark → OLED → Light. OLED renders claude.ai on a warm near-black background (`#050306`) with a subtle brand glow overlay (orange top-left, magenta bottom-right). All sub-windows (What's New, About, Settings, Bug Report) follow the same look via a `body::before` overlay. CSS-variable mapping + Tailwind class targeting in `inject/oled.js` recolor the page content; sidebar items become flat with a discreet hover state; popup menus (Radix dropdowns) get a slightly raised background. New state keys `oledMode` and `oledIntroSeen`.
- **OLED theme is preselected on the first launch of 1.4.0** so the new mode is visible right away. The What's-New entry explains how to switch back with the same sun/moon icon. After the intro the value is persisted and the user choice is respected.
- **Composer gradient ring.** The chat input field on claude.ai shows a thin animated brand gradient border (orange ↔ magenta, 6 s loop), matching the Quick-Prompt style. Implemented via JS detection of the innermost composer `<fieldset>` plus a `::before` mask-composite border so it sits exactly on the field's radius.
- **All sub-windows are frameless with a custom title bar.** What's New, About, Settings and Bug Report now use the same compact 36 px title strip (drag region + close button), consistent with the main window.
- **What's New redesigned.** New bento-grid layout: animated brand gradient hero with version pill, 2-column tile grid for highlights, brand-tinted icon containers with hover lift. Window resized to 640×680.
- **OLED logo variant** for the in-app spark (About hero, App Menu, Quick-Prompt). The existing icon is embedded into an SVG with a dark tile and two radial brand-glow stops so it does not disappear into the OLED black.

### Changed
- **Bug Report dialog rebuilt on `theme()` instead of hardcoded dark/light values**, so OLED now applies. Primary button uses the Modern brand gradient (`linear-gradient(135deg, F26A3F, E83B6E)`) like the rest of the app instead of a solid colour.
- **Settings, Bug Report, What's New, About, App Menu, Message Box and Microphone Consent** all use a shared `customTitlebarCSS` / `customTitlebarHTML` helper. In OLED the helper also paints the brand-glow body overlay, so the windows stay deep black but feel alive.
- **Tab bar separator removed.** The 1 px line between the tab bar and the WebView is gone for a seamless transition.
- **Sub-window background colours pinned to `theme().bg`** (a no-op `subTheme()` shim is kept for forward compatibility).

### Fixed
- `oledIntroSeen` is persisted via `saveWindowStateSync()` immediately after the intro default fires, so a hard crash within the first session cannot re-trigger the intro.
- `cd-titlebar-close` event binding uses optional chaining in What's New and About; if the title bar ever fails to render the rest of the window still works.
- Window-control IPC handlers (`win-minimize`, `win-toggle-maximize`, `win-close`, `win-state-request`) check `event.sender === mainWindow.webContents` so other preloads cannot remote-control the main window.
- `nav` / `aside` items no longer get individual painted backgrounds in OLED (the previous heuristic gave every sidebar entry its own card look). Background flat, hover state at `#181417`, active state at `#1c181b`.

### Internal
- `inject/oled.js` (new): CSS-variable override, Tailwind class targeting, focus outline recolour, popup menu mapping, brand glow overlay, composer ring helper.
- `iconDataUrlForCurrentTheme()`: returns the original icon in Light/Dark, returns an SVG with embedded PNG + brand-glow background in OLED.

---

## [1.3.13] - 2026-05-20 - Verification Banner & About Window

### Added
- **Banner on a stuck verification screen.** If the Cloudflare "Performing security verification" page is still up after 18 seconds, a banner appears at the top with Reset and Dismiss buttons. Reset clears claude.ai cookies and cache and reloads the page (the existing `resetClaudeVerification()`); before this the only way out was a hidden menu entry. New injected script `inject/verify-banner.js`. Detection is kept narrow (`<title>Just a moment...</title>`, `#challenge-stage`, `#challenge-running`) so the Turnstile widget on the login page is left alone. The timer is stored in `sessionStorage` so it survives a challenge that reloads itself.
- **About window.** New "About Claude Desktop" entry in the app menu opens a window with the app version, a short description, links to the GitHub repository and Anthropic support, the trademark/affiliation notice, and a "Show What's New" button. New file `preload-about.js`.
- **What's New reachable from the app menu.** A "What's New" entry now opens the release notes at any time, not just on first launch after an update. `getFilteredNotes()` takes a `force` flag so the current version's notes show regardless of the last-seen version.

### Changed
- Keyboard focus rings (`:focus-visible`) on buttons in the Settings, Bug Report, What's New and About windows, plus the hotkey capture field. Keyboard users had no visible focus indicator before.
- Bug Report success/error icons switched from raw Unicode glyphs to SVG, matching the rest of the app.
- Snap: added the `screen-inhibit-control` plug so the screensaver is held back during video playback. Snap listing description stripped of Markdown bold markers; `.desktop` `Comment` field set to English.
- AppImage launch wrapper now clears `GIO_MODULE_DIR`. README documents the FUSE 2 requirement on Ubuntu 22.04 / 24.04.

### Fixed
- Tab bar IPC listeners no longer accumulate when the tab bar reloads on a theme or design toggle. Listener registration in `preload-tabbar.js` is now idempotent; previously every reload added another listener and events arrived multiple times.

---

## [1.3.12] – 2026-05-17 — Higgsfield Connector Fix

### Fixed
- **Higgsfield connector now connects.** Users reported that clicking "Connect" / "Accept" on the Higgsfield MCP connector dialog inside claude.ai did nothing visible. Root cause: `higgsfield.ai` was not listed in the in-app OAuth allowlist (`isOAuthDomain`), so the auth popup was routed to the system browser via `shell.openExternal`. The OAuth callback then arrived in the external browser session instead of the Electron session backing the app, which left claude.ai stuck waiting for a token that never came. `higgsfield.ai` and its subdomains are now treated as OAuth domains: the popup opens inside the app (600×750, shared `persist:claude` partition so the callback reaches claude.ai), same as Google/GitHub/Microsoft/GitLab/Bitbucket/Auth0.
- **`mailto:` links open the mail client from in-tab navigation too.** Previously only `mailto:` links opened via `window.open()` were forwarded to `shell.openExternal`; a plain `mailto:` link followed in the same tab was silently dropped. Now both paths behave the same.
- **Bug Report dialog: action buttons no longer clipped at the bottom.** The serverSideHint paragraph added in 1.3.11 made the disclaimer block taller, but the fixed window height (760 px) was not adjusted, so on default scaling "Cancel" and "Send report" were partially or fully cut off. Window height bumped to 860 px.

### Changed
- **Internal: section header cleanup in `main.js`.** Removed 56 box-drawing separator lines (`// ═══...`) and 12 sub-section dash markers (`// ── X ──`). Headers now read as plain `// Section name` comments. Purely cosmetic, no functional change.
- **Snap listing copy** trimmed (removed marketing wording).

---

## [1.3.11] – 2026-05-13 — Cloudflare Verification Loop Fix

### Fixed
- **Cloudflare Turnstile no longer gets stuck in a verification loop.** Users reported that v1.3.10 (and occasionally earlier versions) could hang on "Performing security verification" / "Verifying you are human" indefinitely. Three root causes were addressed:
  - `isAllowedDomain` blocked the Turnstile challenge iframe (`challenges.cloudflare.com`) via `will-frame-navigate`, so the challenge could never complete. The host is now whitelisted alongside `claude.ai`, the Anthropic sandbox origins, and `claudemcp.com`.
  - The `webRequest.onBeforeSendHeaders` listener was scoped to `*.claude.ai` only, so the sandbox origins (`claudeusercontent.com`, `claudemcpcontent.com`, `claudemcp.com`), `*.anthropic.com` and the Cloudflare challenge endpoint received the default Electron user-agent and incomplete Client Hints — a known Cloudflare bot signal. The listener now covers all of these in a single combined URL filter (single listener per session, as required by Electron).
  - `Sec-Ch-Ua-Full-Version-List` and `Sec-Ch-Ua-Platform-Version` were missing (Electron upstream bug #34762: Electron does not send high-entropy UA Client Hints automatically). They are now injected with the same brand list and order as `Sec-Ch-Ua`, so Cloudflare's Client-Hints consistency check no longer mis-flags the renderer.

### Added
- **Bug Report dialog now shows a "browser cross-check" hint** under the unofficial-app disclaimer: "Quick check: does the same error also happen on claude.ai in a regular browser? If yes, it is a server-side issue at Anthropic and not a wrapper bug." Localised in DE/EN/FR/ES/IT (other languages fall back to English via the existing `bugReportStrings.en` merge). Cuts down on reports for server-side issues like the recent "Could not load connectors directory" message, which also occurs in the official Anthropic Claude apps and in regular browsers.
- **`*.anthropic.com` in the header hook**: prophylactic coverage for newer Anthropic endpoints (e.g. `assets-proxy.anthropic.com` referenced in upstream MCP diagnostics) so that future Connectors / asset proxy requests don't degrade the Cloudflare trust score because of a default Electron UA.

### Note for users on very old kernels
- Reports of "App is not responding" on kernel 5.3.0 (Ubuntu 19.10, end-of-life since 2020) are an unsupported-environment issue: `core24` Snap base on a pre-5.4 kernel runs with silently-degraded AppArmor confinement and broken Mesa userspace ABI for ANGLE. Please upgrade to Ubuntu 20.04 or newer.

---

## [1.3.10] – 2026-05-11 — MCP Connectors & Self-Service Diagnostics

### Fixed
- **MCP connectors (Visualize and others) now load again.** Users who had connected an MCP app inside claude.ai saw the error "Failed to set up MCP app — check that claudemcpcontent.com is not blocked by your network or browser". The cause was the app's own allowlist: `claudemcpcontent.com` (a separate sandbox origin Anthropic uses for MCP iframe content, analogous to `claudeusercontent.com` for artifacts) was missing from `isAllowedDomain`, so `will-frame-navigate` blocked the iframe load. Added `claudemcpcontent.com` and prophylactically `claudemcp.com` to the allowlist (same fix shape as the 1.3.3 artifact-iframe bug).

### Added
- **App Menu → "Copy diagnostics info"**: collects app version, Electron/Chrome/Node build, kernel release, session type (X11/Wayland), `XDG_SESSION_TYPE` / `WAYLAND_DISPLAY` / `DISPLAY`, locale, user-agent, GPU vendor/device IDs and driver strings (via `app.getGPUInfo('basic')`), GL vendor/renderer/version, and WebGL vendor/renderer/version (probed in the active tab via `WEBGL_debug_renderer_info`) into the clipboard. Makes future Cloudflare-verification-loop and rendering-stack bug reports reproducible.
- **App Menu → "Reset claude.ai verification…"**: a confirm-gated action that clears cookies, local storage, service workers, cache, IndexedDB, websql and filesystem storage for `claude.ai`, `claudeusercontent.com`, `claudemcpcontent.com` and `claudemcp.com` (all subdomains), plus the session cache and host resolver cache, then reloads `https://claude.ai` in the active tab. Self-service recovery for users stuck on a "Performing security verification" loop.

---

## [1.3.9] – 2026-05-07 — Wayland Compatibility

### Fixed
- **Wayland: pop-up windows land where they belong again.** On Wayland sessions (GNOME, KDE Plasma) the App Menu, Settings, Bug Report, Quick-Prompt and What's-New windows previously appeared at random positions across the screen, because Wayland forbids client-side toplevel positioning (Electron Issue #40886, marked not-planned by maintainers in October 2025). The app now starts under XWayland on Wayland sessions — the same approach VS Code, Discord, Signal and Obsidian use. Pixel-accurate window placement, `globalShortcut.register` and existing centering helpers all work again. Trade-off: minor HiDPI softness with fractional scaling. The switch is forced via `--ozone-platform=x11` in the AppImage wrapper (`scripts/after-pack.js`) and the Snap launcher (`snap/local/electron-launch`).
- **Bug Report window can no longer be opened multiple times.** Previously each click on the bug icon spawned a fresh window, leading to several identical reports stacked on top of each other. A singleton guard now focuses the existing window instead.
- **App Menu (hamburger) closes cleanly on rapid double-clicks.** The 250 ms cooldown that prevents a close+reopen race is now set the moment `close()` is called, not in the asynchronous `closed` event. Fast clicks no longer spawn parallel menu windows.
- **`window-state.json` no longer accumulates ghost coordinates** on Wayland-only setups. (Indirect fix — `loadWindowState` was patched in 1.3.9-dev with an `isWayland` branch that's no longer needed since the whole app now runs under XWayland; the branch has been removed.)

### Added
- **Settings → Hotkeys: Wayland note.** When the app detects Wayland, the settings window shows an explanatory hint above the hotkey fields so users understand why a global shortcut may not register system-wide on GNOME/KDE.
- **`failed-wayland` hotkey-status code**: distinct from the generic `failed` code, so the settings UI can show a specific message when the compositor refuses a global key grab.
- **`npm run dev` script** in `package.json` that launches Electron with `--no-sandbox --ozone-platform=x11` for local development on Wayland hosts.

### Changed
- **AppImage wrapper (`scripts/after-pack.js`)** appends `--ozone-platform=x11` automatically when `$WAYLAND_DISPLAY` and `$XDG_SESSION_TYPE=wayland` are set, before the existing `--no-sandbox` injection. X11 sessions are unaffected.
- **Snap launcher (`snap/local/electron-launch`)** now uses `--ozone-platform=x11` unconditionally for both X11 and Wayland sessions (was previously branching to `--ozone-platform-hint=auto` for Wayland). Combined with the existing `--use-gl=angle --use-angle=gl` switches, the Snap renders identically on both display servers.

---

## [1.3.8] – 2026-05-07

### Added
- **Unofficial-app disclaimer in the Bug Report dialog**: a prominent amber-coloured note explains that this is an unofficial community wrapper (not an official Anthropic product) and links directly to https://support.anthropic.com for account, login, subscription, billing or payment questions. Localised in DE/EN/FR/ES/IT.
- **Live Snap microphone status** in App Settings → Microphone: a coloured pill next to the toggle shows whether the `audio-record` plug is currently connected (green pulsing) or not (red), with 3-second polling while the settings window is open.
- **Snap-aware microphone toggle**: turning the toggle on while the Snap plug is not connected automatically reopens the consent wizard, so the user is never left in a state where the toggle is on but recording silently fails.
- **Allow-button pulse on Snap status flip**: the consent dialog's Allow button briefly pulses and refocuses the moment `snapctl is-connected audio-record` flips to connected, so the user sees that activating the permission worked without watching the status badge.
- **Notification heuristic with fallback selector stack**: `inject/notify.js` now tries four strategies (aria-label → data-testid → SVG `data-icon` → text content) to detect the claude.ai stop-button. The first matching strategy logs once to the DevTools console so regressions become visible if claude.ai changes its DOM. Visibility check now also catches fixed-positioned buttons.
- **Unit tests** for the pure utility functions (`compareVersions`, `safeJson`, `isClaudeAiOrigin`, `validateAccelerator`) under `test/`, runnable via `npm test` (uses `node:test`, no extra dev dependency).

### Changed
- **Refactor `STATE_SCHEMA`**: the 12 persisted window-state fields now have a single declaration that drives both `loadWindowState()` (on startup) and `buildState()` (on save). Previously the same set of fields was defined three times.
- **Refactor `createDialogWindow(opts)` helper**: shared `BrowserWindow` setup for the message-box and microphone-consent dialogs (size, position, parent/modal, preload, theme background) is now in one place.
- **Pure utilities extracted** to `utils/pure.js` so they can be unit-tested independently of Electron.

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
