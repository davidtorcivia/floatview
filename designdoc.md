# FloatView — Technical Design Document (v3)

## Overview

A minimal, purpose-built floating browser window for streaming media on a secondary monitor. Native always-on-top, HDR-correct rendering, borderless resizable window, tiny resource footprint. Essentially a better Pennywise that doesn't break HDR.

## Why Not Electron

Electron bundles Chromium, which means you're fighting Electron's compositor for HDR tone mapping. Chromium itself supports HDR fine — it's the Electron wrapper that breaks things. We skip this entirely.

### Why Not Browser PiP?

Chrome's Picture-in-Picture mode is tempting but insufficient:

- **Subtitles** — Browser PiP strips styled subtitles (ASS/SSA from Emby, especially anime). WebView2 renders the full DOM, preserving subtitle rendering.
- **Controls** — PiP hides the timeline/scrubber. FloatView keeps the full Emby UI.
- **Opacity** — PiP cannot do transparency overlay.
- **Resize freedom** — PiP windows have constrained aspect ratios and limited resize behavior.

## Recommended Stack: Tauri v2

| Layer     | Technology                        | Rationale                                                                                                                           |
| --------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Runtime   | **Tauri v2** (Rust)               | Uses system WebView2 on Windows — same rendering engine as Edge, no bundled browser. ~3MB binary vs ~150MB Electron.                |
| Rendering | **WebView2** (system)             | Same rendering pipeline as Edge. HDR behavior should match Edge for the same URL on the same machine (to be verified in Phase 0).   |
| UI        | **Injected Shadow DOM**           | FloatView's controls are injected into the page via `AddScriptToExecuteOnDocumentCreated`. Closed ShadowRoot prevents CSS bleeding. |
| Windowing | Tauri window APIs + Win32 interop | Native `always_on_top`, borderless, resize. Single `WebviewWindow` — no unstable features required.                                 |

### Why Tauri over raw WebView2/C#

- Cross-platform path to macOS/Linux later if desired
- Rust backend is trivially small for this use case
- Tauri's window management APIs already expose everything we need
- Active ecosystem, well-maintained
- Still uses the system WebView2 under the hood — no abstraction penalty for media

## Architecture

### Why Not Multi-Webview

The v2 design proposed two webviews in one window via `Window::add_child()`. This is rejected:

- `add_child()` requires Tauri's **`unstable` feature flag** — API may change between minor versions.
- Active bugs: only renders last child (#11376), breaks between versions (#11452), focus events don't fire with unstable enabled (#12568), resize breaks (#9634).
- Even if rendering worked, a full-window transparent overlay webview would swallow mouse events at the OS level (`WM_LBUTTONDOWN` captured by the overlay's HWND before reaching the content webview). `pointer-events: none` in CSS does not solve this — it only affects the DOM, not the Win32 hit test.
- Making the overlay's `DefaultBackgroundColor` alpha=0 controls rendering, not input routing.

### Primary Architecture: Single WebviewWindow + Shadow DOM Injection

One `WebviewWindow` navigates to the target URL. FloatView's control UI is **injected into every page** via JavaScript, isolated inside a closed Shadow DOM to prevent CSS interference in either direction.

```
┌──────────────────────────────────────────┐
│           Tauri Shell (Rust)              │
│                                          │
│  ┌─────────────────────────────────────┐ │
│  │     Single WebviewWindow            │ │
│  │                                     │ │
│  │  ┌─────────────────────────────┐    │ │
│  │  │ Injected Shadow DOM (top)   │    │ │  ← our UI: URL bar, pin, settings
│  │  │ - closed ShadowRoot         │    │ │     injected via on_page_load
│  │  │ - CSS fully isolated        │    │ │     re-injected on every navigation
│  │  │ - appears on hover          │    │ │
│  │  └─────────────────────────────┘    │ │
│  │                                     │ │
│  │  ┌─────────────────────────────┐    │ │
│  │  │ Page content (Emby, etc)    │    │ │  ← the actual site, untouched
│  │  └─────────────────────────────┘    │ │
│  └─────────────────────────────────────┘ │
│                                          │
│  ┌──────────┐  ┌────────────────────┐    │
│  │ Window    │  │ Config / State     │    │
│  │ Manager   │  │ (JSON on disk)     │    │
│  └──────────┘  └────────────────────┘    │
│  ┌──────────────────────────────────┐    │
│  │ Hotkey Listener (global)         │    │
│  │ System Tray                      │    │
│  │ Audio Device Enumeration (Rust)  │    │
│  └──────────────────────────────────┘    │
└──────────────────────────────────────────┘
```

**How the injection works:**

1. On WebView2 initialization, register a script via Tauri's `on_page_load` (which maps to WebView2's `AddScriptToExecuteOnDocumentCreated`). This script runs on every top-level navigation before any page script executes.

2. The injected script creates a container `<div>` at the top of `<body>`, attaches a **closed ShadowRoot**, and renders FloatView's control strip inside it. Closed mode prevents the host page from accessing or styling our UI, and our styles can't leak out.

3. The control strip is positioned `fixed` at the top of the viewport, `z-index: 2147483647`, initially hidden. A mouse-enter listener on a thin hotzone at the top of the viewport reveals it. The strip itself contains: URL display, always-on-top pin, lock icon, opacity slider, settings gear, minimize, close.

4. Communication with the Rust backend uses `window.__TAURI__` IPC (available because this is a Tauri webview). The injected script calls Tauri commands for: navigate, toggle always-on-top, toggle locked mode, set opacity, enumerate audio devices, etc.

5. On SPA navigations (where the page doesn't fully reload), the DOM persists so the injection stays. On full navigations, `AddScriptToExecuteOnDocumentCreated` automatically re-executes.

**Strengths:**

- No `unstable` feature flag. Standard `WebviewWindow`.
- No multi-HWND input routing problems.
- CSS isolation via Shadow DOM — site can't break our UI, we can't break the site.
- Automatic re-injection on navigation.

**Risks & mitigations:**

- Some aggressive sites may detect/remove injected DOM nodes. Mitigation: use `MutationObserver` to re-attach if our container is removed.
- Content Security Policy (CSP) on some sites may block inline styles. Mitigation: our injected styles live inside the Shadow DOM which has its own style scope; test with strict CSP sites.
- The injected strip shifts page content down by ~40px. Mitigation: use `position: fixed` + `pointer-events: none` on the hotzone (not the strip itself), so it overlays rather than pushes.

### Fallback Architecture: Two Separate Windows

If Shadow DOM injection proves unreliable across target sites, fall back to two independent windows:

- **Content window**: Standard borderless `WebviewWindow` navigating to the target URL.
- **Overlay window**: Tiny frameless always-on-top transparent `WebviewWindow` (~40px tall) positioned at the top edge of the content window, containing our control UI.

The Rust backend syncs the overlay position whenever the content window moves or resizes. This adds complexity (position syncing, dual focus management) but completely avoids DOM injection and site-interaction concerns. No unstable features needed for this either — these are two independent `WebviewWindow` instances.

**Switch criteria:** If Phase 0 shows that Shadow DOM injection fails on >1 of the primary target sites (Emby, Jellyfin, YouTube, Plex web), switch to the two-window approach.

## Core Features

### 1. Window Management

- **Always on top** — native, togglable via hotkey and injected pin icon. Not guaranteed over exclusive fullscreen apps/games (OS-level limitation).
- **Fully borderless** — no native title bar or chrome. Our injected strip is the only UI. Native resize via Tauri's `WM_NCHITTEST` interception (Tauri handles borderless resize by reporting edge zones as resize borders to Windows).
- **Opacity control** — adjustable transparency (0.1–1.0) via hotkey or slider.
- **Locked/unlocked mode** — see section below.
- **Remember geometry** — persist window size/position per monitor across sessions.
- **Single instance lock** — via `tauri-plugin-single-instance`. If launched again, focus existing window.
- **Native resize handles** — Tauri's OS-level `WM_NCHITTEST` interception, not JS coordinate calculation. Note: if the injected UI covers the very top edge, it may capture mouse events before the OS sees them for hit testing. Mitigation: leave a 2px transparent margin at window edges where the injected UI does not render.

### 2. HDR Support

**Goal: match Edge's HDR behavior for the same URL on the same machine.**

The hypothesis is that since WebView2 is Edge's rendering engine, HDR output should match what Edge produces. This is plausible but unverified. HDR behavior depends on OS settings, GPU drivers, display EDID, and content codec path.

**What we commit to:**

- No compositor interference (unlike Electron)
- Hardware acceleration enabled by default
- No chromium flags in production

**What needs verification (Phase 0 spike):**

- Side-by-side comparison: FloatView vs Edge on the same HDR test content
- SDR content on HDR display (correct SDR-to-HDR boost, no washed-out colors)
- `window.matchMedia('(dynamic-range: high)')` returns `true` in WebView2 on an HDR display
- Test matrix across OS builds and GPU vendors

**What we explicitly do NOT do:**

- No chromium flags in production. Microsoft is explicit: "apps in production shouldn't use [browser flags]" — they may change or disappear between WebView2 versions.
- No promises about specific HDR format support beyond what Edge/WebView2 natively supports.

### 3. User Agent & Transcoding

**Risk:** WebView2 identifies as a generic Chromium browser. Emby/Plex may treat it as "Unknown" and force server-side transcoding — burning CPU on the server and destroying HDR metadata — rather than Direct Play.

**Fix (Phase 1):** Set the WebView2 User Agent string to match Microsoft Edge exactly:

```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/1xx.0.xxxx.xx Safari/537.36 Edg/1xx.0.xxxx.xx
```

This is set via `CoreWebView2Settings.UserAgent` (exposed through Tauri's webview configuration or via `with_webview` callback). Emby sees "Edge" and enables Direct Play for HEVC/HDR codecs that Edge supports.

### 4. Playback Integration

- **Emby-aware (optional, Phase 3)** — Emby API auth, direct stream URLs, playback state sync, media key support.
- **Generic mode** — works with any URL. No Emby dependency.

### 5. Audio Routing

**Status: Requires feasibility spike before committing.**

The ideal path is the web-standard `setSinkId()` API on `HTMLMediaElement`. Chromium/WebView2 supports it.

**Challenges:**

- `setSinkId()` requires a **secure context** (HTTPS or localhost). Emby at `http://192.168.1.131:8096` is not a secure context. Host-side JS injection does not bypass this requirement — secure context is a web platform security constraint, not a permissions issue.
- `selectAudioOutput()` requires **user activation** (a click). Cannot be silently granted from Rust.
- WASAPI routing from Rust is fragile: WebView2 spawns child processes for rendering, identifying the correct audio session is unreliable.

**Investigation order (Phase 0 spike):**

1. **Test `setSinkId()` on HTTP origin in WebView2** — confirm it's actually blocked (it should be, but verify). If WebView2 has a permissive behavior for host apps, this is the happy path.
2. **WebView2 `PermissionRequested` event** — test whether auto-approving `speaker-selection` permission from Rust enables `setSinkId()` without user activation.
3. **Fallback: "Open Windows audio settings"** — button that runs `start ms-settings:apps-volume`. Zero code complexity, works on Win 10 1803+ and Win 11. Verify in Phase 0 that this specific deep link works on both OS versions.

**Explicitly not shippable:** `--unsafely-treat-insecure-origin-as-secure` flag. This requires specifying the exact origin, meaning the WebView process would need to restart when the user changes URLs. And Microsoft says production apps should not use browser flags. Prototype/diagnostic use only.

**For MVP:** Audio routing is **not in scope**. Ship the "open Windows settings" button. Add `setSinkId()` in Phase 2 only if the spike shows it works on HTTP origins in WebView2.

### 6. System Tray

- Minimize to tray
- Quick access: toggle always-on-top, opacity, locked/unlocked mode
- Recent URLs
- Launch at startup option

### 7. Global Hotkeys

Implemented via `tauri-plugin-global-shortcut`.

| Hotkey              | Action                                      |
| ------------------- | ------------------------------------------- |
| `Alt+Shift+T`       | Toggle always-on-top                        |
| `Alt+Shift+D`       | Toggle locked/unlocked (click-through) mode |
| `Alt+Shift+Up/Down` | Adjust opacity                              |
| `Alt+Shift+H`       | Hide/show window                            |

Note: Changed from `Ctrl+Shift+` to `Alt+Shift+` to avoid conflicts with text selection shortcuts. User-remappable via config from Phase 1.

`Ctrl+L` (focus URL bar) and `Escape` (hide URL bar) are **webview-scoped**, not global — they only fire when FloatView's window is focused.

## Design Decisions

### Hover Title Bar (Injected Strip)

The injected control strip is `position: fixed` at the top of the viewport. It does not push content down — it overlays. Initially invisible (height: 0 or opacity: 0). A thin hotzone (`pointer-events: auto`, ~8px tall, otherwise transparent) at the very top detects mouse entry.

On hover (with ~500ms dwell during video playback to prevent accidental triggers), the strip expands to ~40px and reveals controls:

```
┌──────────────────────────────────────────────┐
│ 📌 192.168.1.131:8096/web/...    🔓 ⚙ — ✕   │  ← injected Shadow DOM strip
├──────────────────────────────────────────────┤
│                                              │
│        (page content: Emby etc)              │
│                                              │
└──────────────────────────────────────────────┘
```

Controls: always-on-top pin, URL display (click to edit), lock toggle, settings gear (audio, preferences), minimize, close.

Communication: injected JS calls `window.__TAURI__.invoke('command_name', { args })` to talk to the Rust backend. Tauri commands handle window manipulation, config persistence, audio device enumeration, etc.

### Locked/Unlocked State Model (Click-Through)

**Logic:** `WS_EX_TRANSPARENT` (required for click-through) prevents all mouse input, including hover. You can't have a window that's transparent to clicks but responsive to hovers.

**Solution: Two explicit modes.**

|                  | Unlocked (default)               | Locked (click-through)                  |
| ---------------- | -------------------------------- | --------------------------------------- |
| Mouse input      | Normal — clicks hit FloatView    | Pass-through — clicks hit window behind |
| Injected strip   | Works normally (hover to reveal) | **Hidden** — no UI visible              |
| Resize           | Works normally                   | Disabled                                |
| How to exit      | N/A                              | **Global hotkey only** (`Alt+Shift+D`)  |
| Visual indicator | None                             | Subtle tray icon change                 |
| Win32            | Normal window styles             | `WS_EX_TRANSPARENT` applied             |

When entering locked mode: hide the injected strip, apply `WS_EX_TRANSPARENT`. When exiting: remove `WS_EX_TRANSPARENT`, re-enable strip. The only escape is the global hotkey — there is no mouse-based way to unlock.

## Security & Privacy

### WebView2 Privacy Disclosure

WebView2 aligns with Microsoft Edge's data collection and privacy behaviors. It may send diagnostic data to Microsoft depending on the user's Windows telemetry settings. FloatView itself does not phone home, collect telemetry, or transmit any user data — but the underlying WebView2 runtime may. This should be stated clearly in any README or about page.

### Application Security

- **Session storage** — Separate WebView2 user data directory (not shared with Edge). Persistent cookies/sessions so Emby login persists across launches.
- **Navigation restrictions** — Only `http://` and `https://` schemes. No `file://`.
- **Remote debugging** — Disabled in production builds. Available via flag for development.
- **SmartScreen** — Enabled by default in WebView2 (verify in Phase 0). Provides phishing/malware protection for arbitrary URL navigation.
- **File System Access API** — Disabled in WebView2 permissions to prevent rogue sites from prompting to read local files.
- **User Agent** — Set to match Edge (see section 3). Not a security feature but prevents unexpected transcoding behavior.

### DRM

DRM behavior in WebView2 is browser-engine-dependent and not fully documented. PlayReady is generally supported on Windows. **Widevine support in WebView2 is not confirmed** — there is an active feature request (WebView2Feedback #4828) specifically asking for it, implying it is not generally available.

For FloatView's primary use case (self-hosted Emby with personal media), DRM is irrelevant — there's no DRM on your own files. For users streaming DRM-protected content from services like Netflix via the Emby web UI, playback restrictions may apply. Test DRM scenarios in Phase 0 but do not promise support.

### Code Signing

Unsigned Windows binaries trigger SmartScreen warnings and may face friction in corporate environments. For hobby/open-source distribution, provide clear install instructions. For broader distribution, sign the binary. SmartScreen reputation builds over time even for signed binaries.

## Build & Distribution

- **Binary size**: ~3–5MB (Tauri + Rust, no bundled browser engine)
- **WebView2 Runtime**: Not guaranteed to be present on all systems. Ship the **Evergreen Bootstrapper** in the installer (Tauri's default NSIS installer handles this). On first launch, detect WebView2 presence and prompt/install if missing.
- **Installer**: Tauri's built-in NSIS installer (includes WebView2 bootstrapper) or portable `.exe` with a startup check.
- **Auto-update**: Tauri has built-in updater support via `tauri-plugin-updater`.

## Persistent State (config.json)

```json
{
  "window": {
    "x": 1920,
    "y": 100,
    "width": 640,
    "height": 360,
    "monitor": 1,
    "always_on_top": true,
    "opacity": 1.0,
    "locked": false
  },
  "last_url": "http://192.168.1.131:8096",
  "recent_urls": [],
  "audio_device_id": null,
  "launch_at_startup": false,
  "hotkeys": {
    "toggle_on_top": "Alt+Shift+T",
    "toggle_locked": "Alt+Shift+D",
    "opacity_up": "Alt+Shift+Up",
    "opacity_down": "Alt+Shift+Down",
    "toggle_visibility": "Alt+Shift+H"
  }
}
```

## Development Phases

### Phase 0 — Spikes & Validation

All spikes are go/no-go gates. No production code until these pass.

**Spike 1: Shadow DOM Injection ("The Parasite")**

- Scaffold a Tauri v2 `WebviewWindow` that loads Emby.
- Use `on_page_load` to inject a Shadow DOM control strip.
- Verify: strip renders, CSS doesn't bleed in or out, strip survives SPA navigation, strip re-injects on full navigation.
- Test on: Emby, Jellyfin, YouTube, Plex web.
- Exit criteria: strip works on ≥3 of 4 target sites without site-breaking side effects.
- **If fails:** Switch to two-window architecture (see fallback section).

**Spike 2: HDR Validation ("The Detective")**

- Same minimal Tauri app.
- Open YouTube HDR test video. Compare output side-by-side with Edge.
- Check `window.matchMedia('(dynamic-range: high)')` returns `true`.
- Test matrix (minimum): Win 10 vs Win 11, NVIDIA vs AMD GPU, HDR display vs SDR display.
- Measurement: visual comparison + HDR badge presence in YouTube player.
- Exit criteria: HDR output matches Edge visually. If gap exists, document it — still better than Electron.

**Spike 3: Audio Routing ("The Plumber")**

1. In the Tauri webview loading an HTTP Emby URL, inject JS calling `setSinkId()` on a `<video>` element. Does it throw `NotAllowedError`? (Expected: yes, because HTTP is not a secure context.)

2. Test `PermissionRequested` event auto-approval for speaker-selection.

3. Verify `start ms-settings:apps-volume` deep link works on Win 10 and Win 11.
- Exit criteria: At least the Windows Settings deep link works (fallback). If `setSinkId()` works on HTTP — bonus.

**Spike 4: Click-Through ("The Ghost")**

- Apply `WS_EX_TRANSPARENT` via Win32 interop from Tauri.
- Verify: all mouse input passes through to window behind, global hotkey recaptures, always-on-top maintained.
- Exit criteria: locked mode works. Document quirks.

**Spike 5: Environment Basics**

- Verify SmartScreen is enabled by default in WebView2.
- Verify WebView2 bootstrapper works in Tauri's NSIS installer.
- Set User Agent to Edge string; confirm Emby shows Direct Play (not transcode) for HEVC content.

### Phase 1 — MVP

- Tauri v2 project scaffold (standard `WebviewWindow`, no `unstable` flag)
- Shadow DOM injection of control strip
- Fully borderless resizable window (native `WM_NCHITTEST` resize, 2px edge margin)
- Hover-reveal control strip with drag region, URL input, close/minimize
- Always-on-top toggle (pin icon + hotkey)
- User Agent set to Edge for Direct Play
- Persist window geometry + last URL
- System tray with basic controls (via `tauri-plugin-tray-icon` — note: this is a Tauri plugin, not built-in)
- Single instance lock (via `tauri-plugin-single-instance`)
- Global hotkeys (via `tauri-plugin-global-shortcut`)
- Hotkey remapping via config.json
- Local log file: WebView2 version, GPU, HDR state, display info, codec errors (not telemetry — no network)

### Phase 2 — Polish

- Control strip auto-hide with dwell delay for video-friendly behavior
- Opacity control + hotkeys
- Locked/unlocked mode (click-through via `WS_EX_TRANSPARENT`)
- Audio: `setSinkId()` if spike succeeded, otherwise "Open Windows audio settings" button
- Recent URLs list
- Launch at startup
- `MutationObserver` guard to re-inject strip if page removes it

### Phase 3 — Media Integration (Optional)

- Emby API auth + direct stream URL extraction
- Media key support (play/pause/next)
- Playback state reporting back to Emby
- PiP-style controls overlay on hover

## Risk Register

| Risk                                              | Severity | Mitigation                                                                    |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| Shadow DOM injection breaks on target sites       | High     | Phase 0 spike. Fallback: two-window architecture.                             |
| HDR doesn't match Edge output                     | High     | Phase 0 spike. If gap exists, document and ship — still better than Electron. |
| Aggressive CSP blocks injected styles             | Medium   | Shadow DOM has own style scope. Test with strict CSP. Fallback: two-window.   |
| Sites detect/remove injected DOM                  | Medium   | `MutationObserver` to re-attach. Fallback: two-window.                        |
| `setSinkId()` blocked on HTTP origins             | Medium   | Expected. Ship "Open Windows settings" button.                                |
| Click-through fights with always-on-top           | Medium   | Phase 0 spike. Locked mode disables resize.                                   |
| `WM_NCHITTEST` edge zones captured by injected UI | Low      | 2px transparent margin at window edges.                                       |
| WebView2 runtime not present                      | Low      | Ship Evergreen Bootstrapper in installer.                                     |
| Unsigned binary triggers SmartScreen              | Low      | Provide install instructions. Sign for wider distribution.                    |
| WebView2 Widevine/DRM not available               | Low      | Irrelevant for self-hosted media. Document limitation.                        |
| Emby/Plex force transcoding due to unknown UA     | Low      | Set User Agent to Edge string in Phase 1.                                     |

## Scope Guardrails

This is a floating browser window, not a media center. The Emby integration in Phase 3 is optional and should be a plugin/module, not core. If a feature request doesn't serve "show a URL in a small always-on-top window with correct HDR", it's out of scope.
