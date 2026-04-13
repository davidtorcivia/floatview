# AGENTS.md

Guide for AI agents working on the FloatView codebase.

## Project Overview

FloatView is a Tauri v2 application that provides a floating browser window for streaming media on secondary monitors. Key features include always-on-top, borderless resizable window, opacity control, click-through mode, persistent bookmarks, navigation controls, smart URL bar with DuckDuckGo search, window title tracking, crash recovery (config backup + periodic geometry auto-save), and clear site data.

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
cd src-tauri && cargo test   # Run unit tests (5 tests)
```

## Project Structure

```
floatview/
├── src/
│   └── index.html              # Landing page (URL input)
├── src-tauri/
│   ├── src/
│   │   ├── main.rs             # Main application logic
│   │   ├── config.rs           # Configuration types
│   │   ├── click_through.rs    # Win32 WS_EX_TRANSPARENT interop
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
| `navigate_url` | Navigate to a URL | `main.rs:680` |
| `navigate_home` | Navigate to home URL | `main.rs:751` |
| `toggle_always_on_top` | Toggle pin state | `main.rs` |
| `toggle_locked` | Toggle click-through | `main.rs` |
| `set_opacity` | Set window opacity | `main.rs` |
| `minimize_window` | Minimize window | `main.rs` |
| `get_config` | Read current config | `main.rs` |
| `update_config` | Update config fields | `main.rs` |
| `set_home_url` | Set the home page URL | `main.rs` |
| `clear_recent_urls` | Clear recent URL list | `main.rs` |
| `clear_bookmarks` | Clear all bookmarks | `main.rs` |
| `clear_site_data` | Clear cookies/storage then reload | `main.rs` |
| `set_window_title` | Set window title (truncated to 256 chars) | `main.rs:702` |
| `add_bookmark` | Add URL to bookmarks (dedup, max 50) | `main.rs:718` |
| `remove_bookmark` | Remove URL from bookmarks | `main.rs:736` |

All commands require an auth token (`token` param) via `authorize_command()`.

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
    pub bookmarks: Vec<String>,     // new in v1.1
}
```

### Adding a Tauri Command

1. Add function with `#[tauri::command]` attribute in `main.rs`
2. Add to `invoke_handler!` macro
3. Add required permissions in `capabilities/default.json`
4. Call from JS via `invoke('command_name', { args })`

All commands must accept a `token: String` parameter and call `authorize_command(&state, &token, "command_name")?`.

### Adding a Global Hotkey

1. Add to `HotkeyConfig` in `config.rs`
2. Add key code to `parse_hotkey()` in `main.rs`
3. Register in `register_hotkeys()` -- call a `do_*` helper directly, don't emit events
4. Update `__floatViewUpdate()` in `injection.js` if UI sync needed

### Modifying the Control Strip

Edit `src-tauri/src/injection.js`. The script:
- Creates a closed Shadow DOM on `<div id="floatview-root">`
- Uses `MutationObserver` to survive page DOM changes
- Re-initializes on every navigation (guarded by `window.__floatViewInitialized`)

Control strip layout (v1.1):
```
┌─────────────────────────────────────────────────────┐
│ ← → ⟳ ★ [URL bar - DDG search fallback] 📌 🔒 ⚙ — ✕ │
└─────────────────────────────────────────────────────┘
```

Buttons: back, forward, refresh, bookmark star (click toggle, right-click dropdown), always-on-top pin, lock, settings, minimize, close.

Key injection.js features:
- **URL bar**: DuckDuckGo search fallback for non-URL input
- **Bookmarks**: Star toggle + right-click dropdown, fuzzy URL matching via `urlsMatch()`
- **Navigation**: `history.back()`, `history.forward()`, `location.reload()`
- **Title tracking**: MutationObserver + 2s polling → `set_window_title`
- **URL tracking**: `popstate` + 3s polling for address bar sync
- **Config sync**: `config-changed` event listener updates bookmarks in real-time
- **Dropdown mutual exclusion**: recent/bookmarks/snap dropdowns dismiss each other

## Gotchas

1. **Invoke, don't call window methods** -- `getCurrentWindow().method()` is unreliable from injected scripts. Always create a Rust command and use `invoke()`.

2. **Shadow DOM event boundaries** -- `e.relatedTarget` in mouseleave can be null or retargeted. Check for null before comparing.

3. **Mutex lifetime in helpers** -- When using `app.state::<AppState>()` in block expressions, use `.lock().unwrap()` not `if let Ok(...)` to avoid lifetime issues with the State temporary.

4. **Click-through mode is a trap** -- When locked, the control strip is hidden AND mouse events pass through. Users can only exit via global hotkey or tray menu. Always ensure these escape hatches work.

5. **User Agent** -- Set to Edge UA string for Direct Play support with Emby/Plex. See `inject_script_on_document_created()`.

6. **Opacity on Windows** -- Uses `SetLayeredWindowAttributes` with `WS_EX_LAYERED`. The `transparent: true` Tauri config is required for this to work.

7. **Single Instance** -- `tauri-plugin-single-instance` brings existing window to front if user launches again.

8. **Config backup** -- `save_config()` creates a `.bak` copy before writing. Used for crash recovery.

9. **Periodic geometry auto-save** -- Background thread saves window position/size every 30s (skips minimized/maximized). Prevents geometry loss on crash.

10. **Bookmark limits** -- Max 50 bookmarks, deduplication by normalized URL, sanitized via `sanitize_config()`. 

11. **Title truncation** -- `set_window_title` truncates titles >256 chars to prevent Win32 issues.

12. **Logging** -- Uses `tracing` crate (`warn!`, `error!`) instead of `eprintln!` for structured logging.

## Testing

5 unit tests in `src-tauri/` (run via `cargo test`). Test manually:

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
