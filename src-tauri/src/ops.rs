//! Shared "operation" helpers that drive state changes both Tauri commands
//! (token-authenticated JS calls) and direct actions (hotkeys / tray menu)
//! need to perform.
//!
//! Each operation has one strict implementation here (`Result`-returning,
//! aborts on window-API failure, propagates mutex poisoning). The two
//! call sites wrap it differently:
//!
//! - [`crate::commands`] adds a token check and surfaces errors to JS.
//! - [`crate::actions`] logs failures and fires an `__floatViewUpdate`
//!   eval on success so the injected control strip stays in sync even
//!   when JS-side event listeners haven't attached yet.
//!
//! Operations here are invariant: they always load fresh state, apply,
//! save, and emit. Callers can layer best-effort vs. strict semantics
//! on top without re-implementing the pipeline.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::config::clamp_opacity;
use crate::config_io::save_config;
use crate::injection::js_navigate;
use crate::opacity;
use crate::state::{update_tray_exit_lock_enabled, AppState};
use crate::urls::{normalize_url, DEFAULT_HOME_URL};

/// Resolve the main webview window, returning a descriptive error instead
/// of `None` so callers can propagate the failure upward uniformly.
pub fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())
}

/// Fire `window.__floatViewUpdate(key, value)` in the main webview. Used by
/// direct actions to notify the injected control strip that a state change
/// originated in Rust (a hotkey press or tray menu click), so the strip
/// updates without waiting on the `listen()`-based event bus that can be
/// late-attaching on external pages.
///
/// Both `key` and `value` are JSON-encoded, so the key string is part of
/// the trust boundary; only pass compile-time constants.
pub fn eval_ui_update<T: Serialize>(app: &AppHandle, key: &'static str, value: T) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let key_json = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
    let val_json = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string());
    let _ = window.eval(format!(
        "if(window.__floatViewUpdate) window.__floatViewUpdate({}, {})",
        key_json, val_json
    ));
}

/// Flip always-on-top. Source of truth is the OS (the window may have been
/// un-topped by external means), so we read `is_always_on_top` rather than
/// trusting config.
pub fn toggle_always_on_top(app: &AppHandle) -> Result<bool, String> {
    let window = main_window(app)?;
    let current = window.is_always_on_top().map_err(|e| e.to_string())?;
    let new_value = !current;
    window
        .set_always_on_top(new_value)
        .map_err(|e| e.to_string())?;

    let state = app.state::<AppState>();
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.window.always_on_top = new_value;
        save_config(&state, &config);
    }

    app.emit("always-on-top-changed", new_value)
        .map_err(|e| e.to_string())?;
    Ok(new_value)
}

/// Flip click-through (locked) mode. Source of truth is config, because the
/// OS-level `set_ignore_cursor_events` has no reliable read-back.
pub fn toggle_locked(app: &AppHandle) -> Result<bool, String> {
    let window = main_window(app)?;
    let state = app.state::<AppState>();
    let new_value = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        let nv = !config.window.locked;
        config.window.locked = nv;
        save_config(&state, &config);
        nv
    };

    window
        .set_ignore_cursor_events(new_value)
        .map_err(|e| e.to_string())?;
    update_tray_exit_lock_enabled(app, new_value);
    app.emit("locked-changed", new_value)
        .map_err(|e| e.to_string())?;
    Ok(new_value)
}

/// Force-disable click-through. Returns `true` if a change was applied,
/// `false` if the window was already unlocked. Used by the tray's
/// "Exit Click-Through Mode" item and the dedicated hotkey — both
/// safety hatches for a locked, invisible window.
pub fn exit_click_through(app: &AppHandle) -> Result<bool, String> {
    let window = main_window(app)?;
    let state = app.state::<AppState>();
    let changed = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        if !config.window.locked {
            false
        } else {
            config.window.locked = false;
            save_config(&state, &config);
            true
        }
    };

    if changed {
        // Safety-critical: this releases the user from click-through mode.
        // If it fails, the invisible window still eats cursor input.
        window
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;
        update_tray_exit_lock_enabled(app, false);
        app.emit("locked-changed", false)
            .map_err(|e| e.to_string())?;
    }
    Ok(changed)
}

/// Navigate to the configured home URL. Clears `last_url` first so a
/// subsequent app restart lands on home, not on the prior page.
pub fn navigate_home(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
    let state = app.state::<AppState>();
    let home_url = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.last_url = None;
        save_config(&state, &config);
        normalize_url(&config.home_url).unwrap_or_else(|_| DEFAULT_HOME_URL.to_string())
    };

    let _ = window.eval("window.stop()");
    window
        .eval(js_navigate(&home_url))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Apply an absolute opacity value (clamped). Returns the effective value
/// after clamping, which callers can forward to JS.
pub fn set_opacity(app: &AppHandle, opacity: f64) -> Result<f64, String> {
    let opacity = clamp_opacity(opacity);
    let window = main_window(app)?;
    opacity::set_window_opacity(&window, opacity);

    let state = app.state::<AppState>();
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.window.opacity = opacity;
        save_config(&state, &config);
    }

    app.emit("opacity-changed", opacity)
        .map_err(|e| e.to_string())?;
    Ok(opacity)
}

/// Adjust opacity by a delta. Reads the current value from config (the
/// OS-level opacity is not reliably readable on Windows).
pub fn adjust_opacity(app: &AppHandle, delta: f64) -> Result<f64, String> {
    let current = {
        let state = app.state::<AppState>();
        let config = state.config.lock().map_err(|e| e.to_string())?;
        config.window.opacity
    };
    set_opacity(app, current + delta)
}
