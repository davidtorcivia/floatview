//! Best-effort wrappers around [`crate::ops`] for the tray menu and global
//! hotkeys. Each `do_*` calls the strict operation, then:
//!
//! - On success, emits a `__floatViewUpdate(key, value)` eval so the
//!   injected control strip reflects the new state even when its
//!   event-bus listeners haven't attached yet (common on external pages).
//! - On failure, logs at `warn`/`error` and continues. Hotkey/tray
//!   callers have no useful error channel to propagate into.

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tracing::{error, info, warn};

use crate::ops;

pub fn do_navigate_home(app: &AppHandle) {
    if let Err(e) = ops::navigate_home(app) {
        warn!(error = %e, "do_navigate_home failed");
    }
}

pub fn do_toggle_always_on_top(app: &AppHandle) {
    match ops::toggle_always_on_top(app) {
        Ok(new_value) => ops::eval_ui_update(app, "always_on_top", new_value),
        Err(e) => warn!(error = %e, "do_toggle_always_on_top failed"),
    }
}

pub fn do_toggle_locked(app: &AppHandle) {
    match ops::toggle_locked(app) {
        Ok(new_value) => ops::eval_ui_update(app, "locked", new_value),
        // Safety-critical path: if this fails while *enabling* lock the
        // user's click-through request silently no-ops (confusing, not
        // dangerous). If it fails while *disabling* lock, the user is
        // trapped behind an invisible window — loud log so it's
        // impossible to miss when debugging a stuck session.
        Err(e) => error!(error = %e, "do_toggle_locked failed"),
    }
}

pub fn do_opacity_change(app: &AppHandle, delta: f64) {
    match ops::adjust_opacity(app, delta) {
        Ok(new_opacity) => ops::eval_ui_update(app, "opacity", new_opacity),
        Err(e) => warn!(error = %e, "do_opacity_change failed"),
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

/// Check for an update and, if one exists, download + install it.
///
/// `on_chunk` receives `(chunk_bytes, total_bytes)` deltas during the
/// download so callers can drive a progress UI; pass a no-op for the
/// silent tray path. Returns `Ok(true)` if an update was installed,
/// `Ok(false)` if none was available, `Err(_)` on failure. The caller
/// owns restart-on-success and status-event emission — those differ
/// between the tray (best-effort, restarts from `do_install_update`) and
/// the JS command (emits granular status + restarts itself), so they
/// stay at the call sites rather than being baked in here.
pub async fn install_update_with_progress<F>(
    app: AppHandle,
    mut on_chunk: F,
) -> Result<bool, String>
where
    F: FnMut(u64, Option<u64>) + Send + 'static,
{
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    info!(version = %update.version, "Installing update from native action");
    update
        .download_and_install(move |chunk, total| on_chunk(chunk as u64, total), || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

pub async fn install_update(app: AppHandle) -> Result<bool, String> {
    // Silent tray path: no per-chunk progress reporting.
    install_update_with_progress(app, |_, _| {}).await
}
