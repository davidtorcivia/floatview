# AGENTS.md

Guide for AI agents working on the FloatView codebase.

## Project Overview

FloatView is a Tauri v2 application that provides a floating browser window for streaming media on secondary monitors. Key features include always-on-top, borderless resizable window, opacity control, click-through mode, persistent bookmarks, navigation controls, smart URL bar with DuckDuckGo search, window title tracking, crash recovery (config backup + periodic geometry auto-save), crop/zoom region, and clear site data.

## Tech Stack

- **Runtime**: Tauri v2 (Rust backend)
- **Rendering**: WebView2 (system webview on Windows)
- **Frontend**: Vanilla HTML/JS (minimal, injected Shadow DOM)
- **Plugins**: single-instance, global-shortcut, shell, tray-icon, log

## Prerequisites

- Rust (install via rustup)
- Node.js 18+
- WebView2 Runtime (auto-installed via bootstrapper)

## Essential Commands

```bash
npm install         # Install dependencies
npm run dev         # Development mode with hot reload
npm run build       # Build production release
cd src-tauri && cargo check  # Type-check Rust only
cd src-tauri && cargo test   # Run unit tests
```

## Project Structure

```
floatview/
├── src/
│   └── index.html              # Landing page (URL input)
├── src-tauri/
│   ├── src/
│   │   ├── main.rs             # Binary shim; just calls `floatview::run()`
│   │   ├── lib.rs              # run(), RunEvent::Exit hook, lifecycle integration tests
│   │   ├── state.rs            # AppState, auth, tray setter
│   │   ├── config.rs           # serde config types, clamp_opacity
│   │   ├── config_io.rs        # load/save/sanitize/shutdown pipeline
│   │   ├── urls.rs             # normalize_url, urls_match
│   │   ├── logging.rs          # tracing subscriber setup
│   │   ├── injection.rs        # init-script builder + js_navigate + media JS + UA
│   │   ├── window_state.rs     # geometry clamp, persist, startup restore
│   │   ├── ops.rs              # strict toggle/opacity/navigate core
│   │   ├── actions.rs          # do_* best-effort wrappers over ops
│   │   ├── hotkeys.rs          # parse_hotkey + register_hotkeys
│   │   ├── tray.rs             # setup_tray
│   │   ├── commands.rs         # all #[tauri::command] handlers
│   │   ├── browsing_data.rs    # WebView2 clear-all-data wrapper
│   │   ├── opacity.rs          # Cross-platform opacity interop
│   │   └── injection.js        # Shadow DOM control strip (embedded)
│   ├── capabilities/
│   │   └── default.json        # Tauri v2 permissions
│   ├── icons/                  # App icons (PNG, ICO)
│   ├── Cargo.toml              # Rust dependencies
│   ├── tauri.conf.json         # Tauri configuration
│   └── build.rs                # Tauri build script
├── .github/workflows/
│   └── build.yml               # CI: build + release installers
├── package.json                # npm scripts
├── README.md                   # User documentation
└── designdoc.md                # Technical design document
```

## Architecture

### Single WebviewWindow + Shadow DOM Injection

The application uses one `WebviewWindow` that navigates to user URLs. The control strip (URL bar, buttons) is injected into every page via WebView2's `AddScriptToExecuteOnDocumentCreated`, wrapped in a closed Shadow DOM for style isolation.

### IPC Communication

**Critical pattern**: The injected script runs inside external web pages where `window.__TAURI__.window.getCurrentWindow()` methods are unreliable. Always use `invoke()` to call Rust commands instead of calling JS-side Tauri window APIs directly.

```javascript
// GOOD - reliable on all pages
await invoke('minimize_window');
await invoke('toggle_always_on_top');

// BAD - fails on external pages
window.__TAURI__.window.getCurrentWindow().minimize();
```

### Event System

Rust actions (hotkeys, tray menu) execute directly in Rust, then sync JS via two mechanisms:

1. **Events**: `app.emit("event-name", payload)` caught by `window.__TAURI__.event.listen()` in JS
2. **Eval**: `window.eval("__floatViewUpdate('key', value)")` as reliable fallback

**Important**: Use `window.__TAURI__.event.listen()` (global), NOT `getCurrentWindow().listen()` (targeted only). Rust's `app.emit()` and `window.emit()` are global broadcasts.

### Direct Action Helpers

Hotkey and tray menu actions are executed directly in Rust via helper functions (`do_toggle_always_on_top`, `do_toggle_locked`, `do_opacity_change`, `do_exit_click_through`). This eliminates the fragile Rust->JS->Rust round-trip.

### CSS-based Window Dragging

The drag bar uses `-webkit-app-region: drag` for native WebView2 drag handling. Do NOT rely on `startDragging()` JS calls -- they fail due to async IPC timing.

## Key Patterns

### Tauri Commands (IPC)

| Command | Purpose | File |
|---------|---------|------|
| `navigate` | Navigate to a URL (returns `true`) | `commands.rs` |
| `navigate_home` | Navigate to home URL (returns `true`) | `commands.rs` |
| `toggle_always_on_top` | Toggle pin state | `commands.rs` |
| `toggle_locked` | Toggle click-through | `commands.rs` |
| `set_opacity` | Set window opacity | `commands.rs` |
| `set_opacity_live` | Set opacity without persisting | `commands.rs` |
| `minimize_window` | Minimize window | `commands.rs` |
| `get_config` | Read current config | `commands.rs` |
| `update_config` | Update config fields | `commands.rs` |
| `set_url` | Set the last_url and recent list | `commands.rs` |
| `save_window_geometry` | Persist current geometry | `commands.rs` |
| `snap_window` | Snap window to corner/center | `commands.rs` |
| `open_settings` | Emit open-settings event | `commands.rs` |
| `exit_click_through` | Disable click-through mode | `commands.rs` |
| `close_window` | Close window | `commands.rs` |
| `maximize_toggle` | Maximize/unmaximize window | `commands.rs` |
| `get_version` | Get app version string | `commands.rs` |
| `check_for_updates` | Check for available updates | `commands.rs` |
| `set_window_title` | Set window title (truncated to 256 chars) | `commands.rs` |
| `add_bookmark` | Add URL to bookmarks (dedup, max 50) | `commands.rs` |
| `remove_bookmark` | Remove URL from bookmarks (fuzzy match) | `commands.rs` |
| `set_crop` | Persist crop region | `commands.rs` |
| `clear_crop` | Clear persisted crop region | `commands.rs` |
| `clear_site_data` | Clear all webview browsing data | `commands.rs` (→ `browsing_data.rs`) |

All commands require an auth token (`token` param) via `authorize_command()`.

### Config Serialization (Background Channel)

Config saves are performed by a dedicated background thread to avoid blocking the async runtime and to prevent races:

```rust
// In run():
let (save_tx, save_rx) = std::sync::mpsc::channel::<AppConfig>();
std::thread::spawn(move || {
    while let Ok(cfg) = save_rx.recv() {
        do_save_config(&path, &cfg);
    }
});

// Commands mutate the Mutex, then call:
save_config(&state, &config);  // sends clone to channel
```

This ensures that:
1. The `Mutex` is never held during disk I/O.
2. All writes are serialized (no race between geometry thread and user actions).
3. The existing config file is never deleted on a failed rename.

### Config Struct (`config.rs`)

```rust
pub struct AppConfig {
    pub window: WindowConfig,       // x, y, width, height, monitor, always_on_top, opacity, locked
    pub last_url: Option<String>,
    pub recent_urls: Option<Vec<String>>,
    pub hotkeys: HotkeyConfig,
    pub home_url: String,
    pub first_run: bool,
    pub auto_refresh_minutes: u32,
    pub bookmarks: Vec<String>,
    pub crop: Option<CropConfig>,   // x, y, width, height (0-1 normalized)
}
```

### Tray Menu Dynamic Updates

The tray's **Exit Click-Through Mode** item is dynamically enabled/disabled to match the actual locked state. A closure setter is stored in `AppState` because `MenuItem` is generic over `Runtime`:

```rust
tray_exit_lock_setter: Mutex<Option<Box<dyn Fn(bool) + Send + Sync>>>
```

It is disabled on startup (since locked mode is auto-cleared for safety) and updated whenever locked state changes.

### Adding a Tauri Command

1. Add function with `#[tauri::command]` attribute in `commands.rs` (declared `pub`)
2. Add `commands::<name>` to `generate_handler![ ... ]` in `lib.rs`
3. Call from JS via `invoke('command_name', { args })`

All commands must accept a `token: String` parameter and call `authorize_command(&state, &token, "command_name")?` from the `state` module.

### Adding a Global Hotkey

1. Add to `HotkeyConfig` in `config.rs`
2. Add key code to the `hotkey_code_map()` table in `hotkeys.rs`
3. Register in `register_hotkeys()` -- call a `do_*` helper directly, don't emit events
4. Update `__floatViewUpdate()` in `injection.js` if UI sync needed

### Modifying the Control Strip

Edit `src-tauri/src/injection.js`. The script:
- Creates a closed Shadow DOM on `<div id="floatview-root">`
- Uses `MutationObserver` to survive page DOM changes
- Re-initializes on every navigation (guarded by `window.__floatViewInitialized`)

Control strip layout:
```
┌──────────────────────────────────────────────────────────────────────┐
│ [←] [→] [⟳] [Pin] [Recent] [Home] [URL bar] [★] [Lock] [Snap] [Crop] | [Opacity] [⚙] [−] [✕] │
└──────────────────────────────────────────────────────────────────────┘
```

Buttons: back, forward, refresh, bookmark star (click toggle, right-click dropdown), always-on-top pin, lock, snap, crop, settings, minimize, close.

Key injection.js features:
- **URL bar**: DuckDuckGo search fallback for non-URL input
- **Bookmarks**: Star toggle + right-click dropdown, fuzzy URL matching via `urlsMatch()`
- **Navigation**: `history.back()`, `history.forward()`, `location.reload()`
- **Title tracking**: MutationObserver + 2s polling → `set_window_title`
- **URL tracking**: `popstate` + 3s polling for address bar sync
- **Config sync**: `config-changed` event listener updates bookmarks in real-time
- **Dropdown mutual exclusion**: recent/bookmarks/snap dropdowns dismiss each other
- **Crop/Zoom**: Select region, persist via `set_crop`, restore on init and resize
- **Media hotkeys**: `window.__floatViewLastMedia` tracks the most recently interacted `<video>` or `<audio>` element

## Gotchas

1. **Invoke, don't call window methods** -- `getCurrentWindow().method()` is unreliable from injected scripts. Always create a Rust command and use `invoke()`.

2. **Shadow DOM event boundaries** -- `e.relatedTarget` in mouseleave can be null or retargeted. Check for null before comparing.

3. **Mutex lifetime in helpers** -- When using `app.state::<AppState>()` in block expressions, use `.lock().unwrap()` not `if let Ok(...)` to avoid lifetime issues with the State temporary.

4. **Click-through mode is a trap** -- When locked, the control strip is hidden AND mouse events pass through. Users can only exit via global hotkey or tray menu. Always ensure these escape hatches work. The app auto-disables locked mode on startup for safety.

5. **User Agent** -- Set to Edge UA string for Direct Play support with Emby/Plex. See `inject_script_on_document_created()`.

6. **Opacity on Windows** -- Uses `SetLayeredWindowAttributes` with `WS_EX_LAYERED`. The `transparent: true` Tauri config is required for this to work. Opacity is applied with a 300ms startup delay to ensure the native HWND is ready.

7. **Single Instance** -- `tauri-plugin-single-instance` brings existing window to front if user launches again.

8. **Config backup** -- `do_save_config()` creates a `.bak` copy before writing. Used for crash recovery. It does NOT delete the existing config if the atomic rename fails.

9. **Periodic geometry auto-save** -- Background thread saves window position/size every 30s (skips minimized/maximized). Prevents geometry loss on crash.

10. **Bookmark limits** -- Max 50 bookmarks, deduplication by normalized URL and fuzzy `urls_match`, sanitized via `sanitize_config()`.

11. **Title truncation** -- `set_window_title` truncates titles >256 chars to prevent Win32 issues.

12. **Logging** -- Uses `tracing` crate (`warn!`, `error!`) instead of `eprintln!` for structured logging.

13. **Config save channel** -- All config mutations are serialized through a background `std::sync::mpsc` channel to eliminate races and keep the async runtime responsive.

14. **Error-page detection** -- The injected script detects browser error pages using multiple heuristics (requires at least 2 indicators or a definitive error title) to avoid false positives on tech blogs.

15. **Navigation via eval** -- When Rust navigates the webview by URL, use `crate::injection::js_navigate(&url)` (which `serde_json`-encodes the URL as a string literal), not raw `format!("... = {:?}", url)`. The Debug format is close-but-not-guaranteed to match JS string syntax; `js_navigate` is the audited path.

16. **Placeholder substitution in `build_injection_script`** -- The home-URL placeholder in `injection.js` is substituted as a complete JSON string literal via `serde_json`; the placeholder itself is `"__FLOATVIEW_HOME_URL__"` (wrapped in quotes) so the replacement swaps the *whole* literal. Don't wrap the placeholder in extra quotes on the JS side.

17. **Opacity clamping** -- Always go through `config::clamp_opacity`; it snaps near-opaque to 1.0 (lets the Windows backend drop `WS_EX_LAYERED`) and rejects non-finite inputs that would otherwise poison the saved config.

18. **Title truncation** -- `set_window_title` calls `truncate_title`, which respects UTF-8 char boundaries. Do NOT revert to `&title[..N]` slicing; it panics on multi-byte codepoints that any page can craft into a title.

19. **Capabilities** -- The `global-shortcut` plugin's JS register/unregister permissions are NOT granted. Hotkey management is Rust-only; don't add those permissions without a matching JS feature.

## Testing

Run unit tests in `src-tauri/` (via `cargo test`). Test manually:

1. `npm run dev`
2. Test URL navigation (landing page + control strip URL bar + DDG search fallback)
3. Test always-on-top toggle (hotkey + tray + settings + strip button)
4. Test opacity (hotkey + slider + settings)
5. Test click-through mode (enter via hotkey, exit via hotkey AND tray menu)
6. Test drag (from top bar), resize (from edges), minimize, close
7. Test system tray (left-click show/hide, right-click menu items)
8. Test persistence (close and reopen, verify state restored)
9. Test on external pages (navigate to a real site, verify all controls still work)
10. Test back/forward/refresh buttons work on navigated pages
11. Test bookmark star (toggle on/off, right-click dropdown shows list)
12. Test clear site data (Settings button, verify cookies/storage cleared)
13. Test window title updates when navigating between pages
14. Test crop/zoom (select region, verify persist/restore across restarts)
15. Test tray quit preserves geometry
16. Test media hotkeys target the most recently interacted player
17. Test error-page redirect only fires on actual browser errors
