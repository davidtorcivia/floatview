//! Direct-action helpers invoked from the tray menu and global hotkeys.
//!
//! These bypass the JS command bus — they mutate state in Rust, call the
//! native window API directly, and emit events to the webview so the
//! control strip stays in sync. They match the behavior of their
//! `#[tauri::command]` siblings but are callable without a token.

use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};
use tauri_plugin_updater::UpdaterExt;

use crate::config_io::save_config;
use crate::opacity;
use crate::state::{update_tray_exit_lock_enabled, AppState};
use crate::urls::{normalize_url, DEFAULT_HOME_URL};

pub fn do_navigate_home(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let state = app.state::<AppState>();
        let home_url = if let Ok(mut config) = state.config.lock() {
            config.last_url = None;
            save_config(&state, &config);
            normalize_url(&config.home_url).unwrap_or_else(|_| DEFAULT_HOME_URL.to_string())
        } else {
            DEFAULT_HOME_URL.to_string()
        };
        let _ = window.eval("window.stop()");
        let _ = window.eval(format!("window.location.href = {:?}", home_url));
    }
}

pub fn do_toggle_always_on_top(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        warn!("do_toggle_always_on_top: main window not found");
        return;
    };
    let current = window.is_always_on_top().unwrap_or(false);
    let new_value = !current;
    if let Err(e) = window.set_always_on_top(new_value) {
        warn!(error = %e, new_value, "set_always_on_top failed");
    }

    let state = app.state::<AppState>();
    if let Ok(mut config) = state.config.lock() {
        config.window.always_on_top = new_value;
        save_config(&state, &config);
    }

    if let Err(e) = app.emit("always-on-top-changed", new_value) {
        warn!(error = %e, "failed to emit always-on-top-changed");
    }
    let _ = window.eval(format!(
        "if(window.__floatViewUpdate) window.__floatViewUpdate('always_on_top', {})",
        new_value
    ));
}

pub fn do_toggle_locked(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        warn!("do_toggle_locked: main window not found");
        return;
    };
    let new_value = {
        let state = app.state::<AppState>();
        let mut config = match state.config.lock() {
            Ok(config) => config,
            Err(e) => {
                error!("Failed to lock config in do_toggle_locked: {}", e);
                return;
            }
        };
        let nv = !config.window.locked;
        config.window.locked = nv;
        save_config(&state, &config);
        nv
    };

    if let Err(e) = window.set_ignore_cursor_events(new_value) {
        // If this fails while enabling lock, the user's click-through request
        // silently no-ops, which is confusing but not dangerous. If it fails
        // while disabling lock, the user is trapped behind an invisible window
        // — that's a significant UX failure worth a loud log line.
        error!(error = %e, new_value, "set_ignore_cursor_events failed");
    }

    update_tray_exit_lock_enabled(app, new_value);

    if let Err(e) = app.emit("locked-changed", new_value) {
        warn!(error = %e, "failed to emit locked-changed");
    }
    let _ = window.eval(format!(
        "if(window.__floatViewUpdate) window.__floatViewUpdate('locked', {})",
        new_value
    ));
}

pub fn do_exit_click_through(app: &AppHandle) {
    let is_locked = {
        let state = app.state::<AppState>();
        let config = match state.config.lock() {
            Ok(config) => config,
            Err(e) => {
                error!("Failed to lock config in do_exit_click_through: {}", e);
                return;
            }
        };
        config.window.locked
    };
    if !is_locked {
        return;
    }

    let Some(window) = app.get_webview_window("main") else {
        warn!("do_exit_click_through: main window not found");
        return;
    };
    {
        let state = app.state::<AppState>();
        let mut config = match state.config.lock() {
            Ok(config) => config,
            Err(e) => {
                error!("Failed to lock config in do_exit_click_through: {}", e);
                return;
            }
        };
        config.window.locked = false;
        save_config(&state, &config);
    }

    // Safety-critical: this releases the user from click-through mode. If it
    // fails, the invisible window still eats all cursor input. Log at error
    // level so it's impossible to miss when debugging a stuck session.
    if let Err(e) = window.set_ignore_cursor_events(false) {
        error!(error = %e, "failed to disable click-through from exit hotkey");
    }
    update_tray_exit_lock_enabled(app, false);

    if let Err(e) = app.emit("locked-changed", false) {
        warn!(error = %e, "failed to emit locked-changed");
    }
    let _ = window.eval("if(window.__floatViewUpdate) window.__floatViewUpdate('locked', false)");
}

pub fn do_opacity_change(app: &AppHandle, delta: f64) {
    if let Some(window) = app.get_webview_window("main") {
        let new_opacity = {
            let state = app.state::<AppState>();
            let mut config = match state.config.lock() {
                Ok(config) => config,
                Err(e) => {
                    error!("Failed to lock config in do_opacity_change: {}", e);
                    return;
                }
            };
            let op = (config.window.opacity + delta).clamp(0.1, 1.0);
            config.window.opacity = op;
            save_config(&state, &config);
            op
        };

        opacity::set_window_opacity(&window, new_opacity);

        let _ = app.emit("opacity-changed", new_opacity);
        let _ = window.eval(format!(
            "if(window.__floatViewUpdate) window.__floatViewUpdate('opacity', {})",
            new_opacity
        ));
    }
}

pub fn do_media_action(app: &AppHandle, script: &'static str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(script);
    }
}

pub fn do_install_update(app: &AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match install_update(app_handle.clone()).await {
            Ok(true) => {
                let _ = app_handle.emit(
                    "update-install-status",
                    "Installing update and restarting...",
                );
                app_handle.restart();
            }
            Ok(false) => {
                let _ = app_handle.emit("update-install-status", "No update available to install");
                info!("Install update requested but no update was available");
            }
            Err(e) => {
                let _ = app_handle.emit("update-install-status", format!("Install failed: {}", e));
                error!("Install update failed: {}", e);
            }
        }
    });
}

pub async fn install_update(app: AppHandle) -> Result<bool, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        info!(version = %update.version, "Installing update from native action");
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}
