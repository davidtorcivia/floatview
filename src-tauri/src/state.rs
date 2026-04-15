//! Shared application state, token-based command authorization, and the
//! small helper that toggles the tray's "Exit Click-Through" menu item.
//!
//! `AppState` is managed by Tauri and reachable from any command or
//! background worker via `app.state::<AppState>()`.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::thread::JoinHandle;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Wry};
use tracing::{error, warn};

use crate::config::AppConfig;

/// Shared state held by Tauri for the life of the app.
///
/// Mutex-wrapped `Option`s for the saver handles let `shutdown()` take
/// ownership of the sender and join handle without needing `&mut AppState`,
/// which Tauri's `State<'_, T>` API doesn't provide.
pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub config_path: PathBuf,
    pub command_token: String,
    /// `Some` during normal operation; `None` after `shutdown()`. Dropping
    /// the sender is how the saver thread learns it should exit.
    pub save_tx: Mutex<Option<Sender<AppConfig>>>,
    /// JoinHandle for the saver thread; taken by `shutdown()` so we can
    /// wait for pending writes to drain before the process exits.
    pub save_thread: Mutex<Option<JoinHandle<()>>>,
    /// Latched by `shutdown()`; cooperative workers (geometry auto-save)
    /// check this on each tick and exit their loops.
    pub shutdown_flag: AtomicBool,
    /// Tray "Exit Click-Through Mode" item. Stored so toggle_locked and
    /// exit_click_through can enable/disable it. Populated by `tray::setup`.
    pub tray_exit_lock_item: Mutex<Option<MenuItem<Wry>>>,
}

/// Constant-time token check would be nice, but this is a local IPC token
/// that never leaves the process, and the page script holds it in a closed
/// closure — timing attacks aren't a realistic threat here.
pub fn authorize_command(
    state: &tauri::State<'_, AppState>,
    token: &str,
    command_name: &str,
) -> Result<(), String> {
    if state.command_token == token {
        Ok(())
    } else {
        warn!(
            command = command_name,
            "Rejected command due to invalid token"
        );
        Err("Unauthorized command".to_string())
    }
}

/// Enable or disable the tray's "Exit Click-Through Mode" menu item.
///
/// Safe to call before the tray has been built (the stored item is `None`
/// during early startup); the call is a silent no-op in that window.
pub fn update_tray_exit_lock_enabled(app: &AppHandle, enabled: bool) {
    let state = app.state::<AppState>();
    let guard = match state.tray_exit_lock_item.lock() {
        Ok(g) => g,
        Err(e) => {
            error!("tray_exit_lock_item mutex poisoned: {}", e);
            return;
        }
    };
    if let Some(item) = guard.as_ref() {
        if let Err(e) = item.set_enabled(enabled) {
            warn!(enabled, "Failed to update tray exit_lock state: {}", e);
        }
    }
}
