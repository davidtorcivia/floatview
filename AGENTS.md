# AGENTS.md

Guide for AI agents working on the FloatView codebase.

## Project Overview

FloatView is a Tauri v2 application that provides a floating browser window for streaming media on secondary monitors. Key features include always-on-top, borderless resizable window, opacity control, and click-through mode.

## Tech Stack

- **Runtime**: Tauri v2 (Rust backend)
- **Rendering**: WebView2 (system webview on Windows)
- **Frontend**: Vanilla HTML/JS (minimal, injected Shadow DOM)
- **Plugins**: single-instance, global-shortcut, shell, tray-icon

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

### Adding a Tauri Command

1. Add function with `#[tauri::command]` attribute in `main.rs`
2. Add to `invoke_handler!` macro
3. Add required permissions in `capabilities/default.json`
4. Call from JS via `invoke('command_name', { args })`

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

## Gotchas

1. **Invoke, don't call window methods** -- `getCurrentWindow().method()` is unreliable from injected scripts. Always create a Rust command and use `invoke()`.

2. **Shadow DOM event boundaries** -- `e.relatedTarget` in mouseleave can be null or retargeted. Check for null before comparing.

3. **Mutex lifetime in helpers** -- When using `app.state::<AppState>()` in block expressions, use `.lock().unwrap()` not `if let Ok(...)` to avoid lifetime issues with the State temporary.

4. **Click-through mode is a trap** -- When locked, the control strip is hidden AND mouse events pass through. Users can only exit via global hotkey or tray menu. Always ensure these escape hatches work.

5. **User Agent** -- Set to Edge UA string for Direct Play support with Emby/Plex. See `inject_script_on_document_created()`.

6. **Opacity on Windows** -- Uses `SetLayeredWindowAttributes` with `WS_EX_LAYERED`. The `transparent: true` Tauri config is required for this to work.

7. **Single Instance** -- `tauri-plugin-single-instance` brings existing window to front if user launches again.

## Testing

No automated tests. Test manually:

1. `npm run dev`
2. Test URL navigation (landing page + control strip URL bar)
3. Test always-on-top toggle (hotkey + tray + settings + strip button)
4. Test opacity (hotkey + slider + settings)
5. Test click-through mode (enter via hotkey, exit via hotkey AND tray menu)
6. Test drag (from top bar), resize (from edges), minimize, close
7. Test system tray (left-click show/hide, right-click menu items)
8. Test persistence (close and reopen, verify state restored)
9. Test on external pages (navigate to a real site, verify all controls still work)
