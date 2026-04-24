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
use tauri::{AppHandle, Manager, Runtime};
use tracing::{error, warn};

use crate::config::AppConfig;

/// Window dimensions remembered across a snap chain so corner/center
/// snaps can restore the user's pre-snap size after a halves/thirds/
/// aspect resize. Cleared on a manual resize and on each corner snap
/// that consumed it.
pub type PreSnapSize = (u32, u32);

/// Callback that flips a boolean tray state (a check mark, typically).
pub type TrayBoolSetter = Box<dyn Fn(bool) + Send + Sync>;

/// Callback that updates the "Install Update" tray item. `Some(version)`
/// enables it with the version embedded in the label; `None` disables
/// and resets.
pub type TrayUpdateSetter = Box<dyn Fn(Option<&str>) + Send + Sync>;

/// Bundle of callbacks the tray exposes so the rest of the app can
/// reflect state changes into the tray menu without knowing anything
/// about Wry/muda types. Stored as closures so `AppState` stays free of
/// runtime parameters and the webview2 import library doesn't get
/// pulled into test binaries.
pub struct TraySetters {
    /// Flip the "Always on Top" check mark.
    pub set_always_on_top: TrayBoolSetter,
    /// Flip the "Click-Through Mode" check mark.
    pub set_locked: TrayBoolSetter,
    /// Update the "Install Update" item's label + enabled state.
    pub set_update_available: TrayUpdateSetter,
}

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
    /// Tray menu callbacks. `None` before the tray is built, or in
    /// tests that don't set up a tray. Populated by `tray::setup_tray`.
    pub tray: Mutex<Option<TraySetters>>,
    /// Window size at the start of a snap chain. Saved by halves/thirds/
    /// aspect snaps; restored (and cleared) by corner/center snaps so the
    /// window snaps back to the user's "real" size when they go to a
    /// corner. Cleared by manual user resizes.
    pub pre_snap_size: Mutex<Option<PreSnapSize>>,
    /// True while a snap-driven `set_size` / `unmaximize` is in flight,
    /// so the window's `Resized` event handler can distinguish
    /// programmatic resizes from manual ones (only the latter clears
    /// `pre_snap_size`).
    pub snap_resize_in_progress: AtomicBool,
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

/// Run `f` with the current tray setters, if any. Silently no-ops
/// before the tray has been built (early startup), after teardown,
/// and in test builds that skip tray setup. Logs poisoned mutex.
fn with_tray_setters<F: FnOnce(&TraySetters)>(app: &AppHandle<impl Runtime>, f: F) {
    let state = app.state::<AppState>();
    let guard = match state.tray.lock() {
        Ok(g) => g,
        Err(e) => {
            error!("tray setters mutex poisoned: {}", e);
            return;
        }
    };
    if let Some(setters) = guard.as_ref() {
        f(setters);
    }
}

/// Reflect an always-on-top state change into the tray's check mark.
pub fn update_tray_always_on_top<R: Runtime>(app: &AppHandle<R>, on: bool) {
    with_tray_setters(app, |t| (t.set_always_on_top)(on));
}

/// Reflect a click-through state change into the tray's check mark.
pub fn update_tray_locked<R: Runtime>(app: &AppHandle<R>, locked: bool) {
    with_tray_setters(app, |t| (t.set_locked)(locked));
}

/// Toggle the "Install Update" tray item. `Some(version)` enables and
/// labels; `None` disables.
pub fn update_tray_update_available<R: Runtime>(app: &AppHandle<R>, version: Option<&str>) {
    with_tray_setters(app, |t| (t.set_update_available)(version));
}
