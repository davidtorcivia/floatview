//! FloatView library entry point.
//!
//! The binary at `src/main.rs` is a thin shim over [`run`]. Exposing the
//! pipeline as a library lets integration tests under `tests/` exercise
//! operations against a `tauri::test::MockRuntime`, which would be
//! invisible to them if this were bin-only.
//!
//! Module map:
//! - [`state`]       : `AppState`, token auth, tray-item mutator
//! - [`config`]      : serde config types
//! - [`config_io`]   : load/save/sanitize/shutdown of `config.json`
//! - [`urls`]        : URL normalization and match helpers
//! - [`logging`]     : tracing subscriber setup
//! - [`injection`]   : webview init script + media-control JS snippets
//! - [`window_state`]: geometry clamping, persistence, startup restore
//! - [`browsing_data`]: thin wrapper around WebView2 clear-all-data
//! - [`opacity`]     : per-platform opacity native interop
//! - [`ops`]         : strict toggle / opacity / navigate core shared by
//!   commands and direct actions
//! - [`actions`]     : best-effort wrappers around `ops` for hotkeys / tray
//! - [`hotkeys`]     : hotkey parsing + global-shortcut registration
//! - [`commands`]    : all `#[tauri::command]` handlers
//! - [`tray`]        : tray icon + menu

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tracing::{error, info, warn};
use uuid::Uuid;

pub mod actions;
pub mod browsing_data;
pub mod commands;
pub mod config;
pub mod config_io;
pub mod hotkeys;
pub mod injection;
pub mod logging;
pub mod opacity;
pub mod ops;
pub mod state;
pub mod tray;
pub mod urls;
pub mod window_state;

use crate::config_io::{do_save_config, get_config_path, load_config, shutdown};
use crate::injection::{build_injection_script, USER_AGENT};
use crate::logging::{init_logging, LoggingState};
use crate::state::AppState;
use crate::urls::{normalize_url, DEFAULT_HOME_URL};
use crate::window_state::{
    apply_window_state, persist_window_geometry, DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH,
};

/// Build and run the FloatView application. Blocks until the Tauri event
/// loop exits. The binary wrapper is just `fn main() { floatview::run() }`.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Some(guard) = init_logging(app.handle()) {
                app.manage(LoggingState { _guard: guard });
            } else {
                warn!("Structured logging was not initialized");
            }

            info!("FloatView setup started");
            let config_path = get_config_path(app.handle());
            let config = load_config(&config_path);
            info!(path = %config_path.display(), "Configuration loaded");
            let command_token = Uuid::new_v4().to_string();
            let injection_script = build_injection_script(&command_token, &config.home_url);

            let (save_tx, save_rx) = std::sync::mpsc::channel::<config::AppConfig>();
            let saver_path = config_path.clone();
            let save_thread = std::thread::Builder::new()
                .name("floatview-config-saver".to_string())
                .spawn(move || {
                    while let Ok(cfg) = save_rx.recv() {
                        do_save_config(&saver_path, &cfg);
                    }
                })
                .expect("failed to spawn config saver thread");

            let state = AppState {
                config: Mutex::new(config.clone()),
                config_path,
                command_token,
                save_tx: Mutex::new(Some(save_tx)),
                save_thread: Mutex::new(Some(save_thread)),
                shutdown_flag: AtomicBool::new(false),
                tray: Mutex::new(None),
            };
            app.manage(state);

            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("FloatView")
                    .inner_size(DEFAULT_WINDOW_WIDTH as f64, DEFAULT_WINDOW_HEIGHT as f64)
                    .decorations(false)
                    .always_on_top(true)
                    .initialization_script(&injection_script)
                    .user_agent(USER_AGENT)
                    .build()?;

            apply_window_state(&window, &config);

            // Safety: force-clear click-through so the user is never trapped
            // behind an invisible, unclickable window on startup. The tray's
            // "Exit Click-Through Mode" item is initialized disabled to match.
            // Write synchronously rather than via the save channel so the
            // invariant reaches disk before any crash could strand the user.
            clear_startup_click_through(app.handle(), &window);

            // Opacity must be deferred ~300ms so the native HWND is ready for
            // SetLayeredWindowAttributes. Read the value from state at apply
            // time (not capture time) so user adjustments made during the
            // delay are not overwritten with the stale startup value.
            let window_for_opacity = window.clone();
            let app_for_opacity = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                let opacity = app_for_opacity
                    .state::<AppState>()
                    .config
                    .lock()
                    .map(|c| c.window.opacity)
                    .unwrap_or(1.0);
                opacity::set_window_opacity(&window_for_opacity, opacity);
            });

            let nav_url = config
                .last_url
                .clone()
                .and_then(|u| normalize_url(&u).ok())
                .or_else(|| normalize_url(&config.home_url).ok())
                .unwrap_or_else(|| DEFAULT_HOME_URL.to_string());
            let window_clone = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                let _ = window_clone.eval(crate::injection::js_navigate(&nav_url));
            });

            let app_handle = app.handle().clone();
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    let state = app_handle.state::<AppState>();
                    if let Err(e) = persist_window_geometry(&window_clone, &state) {
                        error!("Failed to persist window geometry on close: {}", e);
                    }
                    // RunEvent::Exit will call shutdown() to flush and join the saver.
                }
            });

            hotkeys::register_hotkeys(app.handle());
            tray::setup_tray(app.handle())?;

            // Background update check. Runs on startup after a small
            // grace period so it doesn't fight the webview for network
            // or compete with the initial page load, then repeats every
            // 24 hours. Surfaces availability to both the tray item and
            // an `update-available` event that the settings UI listens
            // for, so the user can install without hunting for the
            // "Check" button.
            let app_for_updates = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_updater::UpdaterExt;
                const STARTUP_DELAY: Duration = Duration::from_secs(30);
                const RECHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
                tokio::time::sleep(STARTUP_DELAY).await;
                loop {
                    if app_for_updates
                        .state::<AppState>()
                        .shutdown_flag
                        .load(Ordering::Acquire)
                    {
                        return;
                    }
                    match app_for_updates.updater() {
                        Ok(updater) => match updater.check().await {
                            Ok(Some(update)) => {
                                let version = update.version.clone();
                                info!(version = %version, "Background check: update available");
                                crate::state::update_tray_update_available(
                                    &app_for_updates,
                                    Some(&version),
                                );
                                let payload = serde_json::json!({
                                    "version": version,
                                    "body": update.body.clone(),
                                });
                                let _ = app_for_updates.emit("update-available", payload);
                            }
                            Ok(None) => {
                                crate::state::update_tray_update_available(&app_for_updates, None);
                            }
                            Err(e) => {
                                warn!("Background update check failed: {}", e);
                            }
                        },
                        Err(e) => warn!("Background updater unavailable: {}", e),
                    }
                    tokio::time::sleep(RECHECK_INTERVAL).await;
                }
            });

            // Periodic geometry auto-save. Wakes every second so shutdown
            // can interrupt promptly; only persists every 30 ticks so disk
            // churn matches the old behavior.
            let app_handle_geom = app.handle().clone();
            let window_geom = window.clone();
            std::thread::Builder::new()
                .name("floatview-geometry-saver".to_string())
                .spawn(move || {
                    const TICK: Duration = Duration::from_secs(1);
                    const SAVE_EVERY: u32 = 30;
                    let mut ticks: u32 = 0;
                    loop {
                        std::thread::sleep(TICK);
                        let state = app_handle_geom.state::<AppState>();
                        if state.shutdown_flag.load(Ordering::Acquire) {
                            return;
                        }
                        ticks = ticks.wrapping_add(1);
                        if ticks.is_multiple_of(SAVE_EVERY) {
                            if let Err(e) = persist_window_geometry(&window_geom, &state) {
                                warn!("Geometry auto-save failed: {}", e);
                            }
                        }
                    }
                })
                .expect("failed to spawn geometry saver thread");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::update_config,
            commands::navigate,
            commands::navigate_home,
            commands::toggle_always_on_top,
            commands::set_opacity,
            commands::set_opacity_live,
            commands::toggle_locked,
            commands::set_url,
            commands::save_window_geometry,
            commands::snap_window,
            commands::set_aspect_ratio,
            commands::pause_global_hotkeys,
            commands::resume_global_hotkeys,
            commands::open_settings,
            commands::minimize_window,
            commands::close_window,
            commands::maximize_toggle,
            commands::get_version,
            commands::check_for_updates,
            commands::install_update,
            commands::set_window_title,
            commands::add_bookmark,
            commands::remove_bookmark,
            commands::set_crop,
            commands::clear_crop,
            commands::clear_site_data,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                info!("FloatView shutting down");
                shutdown(&app_handle.state::<AppState>());
            }
        });
}

/// Force-clear click-through mode on startup and write the config
/// synchronously. Extracted from [`run`] so it can be exercised by
/// integration tests.
///
/// Returns `true` if a change was applied.
pub fn clear_startup_click_through<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> bool {
    clear_startup_click_through_with(&app.state::<AppState>(), || {
        let _ = window.set_ignore_cursor_events(false);
    })
}

/// Pure-state variant of [`clear_startup_click_through`]. Runs the
/// click-through recovery against an `AppState` directly, calling
/// `apply_to_window` inside the config mutex so the state snapshot and
/// the window side effect stay ordered. Exposed for integration tests.
///
/// The sequence matches production: mutate config → apply to window →
/// release mutex → synchronous disk write. Returns `true` if a change
/// was applied.
pub fn clear_startup_click_through_with<F: FnOnce()>(
    state: &AppState,
    apply_to_window: F,
) -> bool {
    let save_path = state.config_path.clone();
    let snapshot = match state.config.lock() {
        Ok(mut c) if c.window.locked => {
            c.window.locked = false;
            apply_to_window();
            Some(c.clone())
        }
        _ => None,
    };
    match snapshot {
        Some(cfg) => {
            do_save_config(&save_path, &cfg);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod lifecycle_tests {
    //! Cross-module integration tests for the save pipeline and startup/
    //! shutdown sequencing. These live in `lib.rs` rather than a
    //! `tests/` integration crate because on Windows the resulting
    //! integration-test binary fails to load (a webview2-com import
    //! library is brought in transitively by the `tauri` crate and the
    //! test binary's link path doesn't resolve it the way
    //! `tauri-build` does for the main bin). As `#[cfg(test)]` tests
    //! here they run inside the working unit-test binary.

    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::thread::Builder as ThreadBuilder;

    use uuid::Uuid;

    use crate::config::AppConfig;
    use crate::config_io::{do_save_config, save_config, shutdown};
    use crate::state::AppState;

    /// Unique temp directory for one test; cleaned up on drop.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("floatview-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn config_path(&self) -> PathBuf {
            self.path.join("config.json")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    struct StateFixture {
        state: AppState,
        temp: TempDir,
    }

    impl StateFixture {
        fn new() -> Self {
            Self::with(|_| {})
        }

        fn with(mutate: impl FnOnce(&mut AppConfig)) -> Self {
            let temp = TempDir::new();
            let config_path = temp.config_path();

            let mut config = AppConfig::default();
            mutate(&mut config);
            do_save_config(&config_path, &config);

            let (save_tx, save_rx) = std::sync::mpsc::channel::<AppConfig>();
            let saver_path = config_path.clone();
            let save_thread = ThreadBuilder::new()
                .name("floatview-test-saver".to_string())
                .spawn(move || {
                    while let Ok(cfg) = save_rx.recv() {
                        do_save_config(&saver_path, &cfg);
                    }
                })
                .expect("spawn saver");

            let state = AppState {
                config: Mutex::new(config),
                config_path,
                command_token: "test-token".to_string(),
                save_tx: Mutex::new(Some(save_tx)),
                save_thread: Mutex::new(Some(save_thread)),
                shutdown_flag: AtomicBool::new(false),
                tray: Mutex::new(None),
            };

            StateFixture { state, temp }
        }

        fn read_disk(&self) -> AppConfig {
            let path = self.temp.config_path();
            let content = fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
            serde_json::from_str(&content).expect("parse config.json")
        }

        fn read_memory(&self) -> AppConfig {
            self.state.config.lock().expect("config mutex").clone()
        }
    }

    #[test]
    fn shutdown_flushes_pending_write_to_disk() {
        // The saver thread runs on its own cadence; shutdown() must
        // drain the channel before returning or queued writes are lost.
        let fx = StateFixture::with(|c| c.window.opacity = 0.4);

        {
            let mut cfg = fx.state.config.lock().unwrap();
            cfg.window.opacity = 0.25;
            save_config(&fx.state, &cfg);
        }

        shutdown(&fx.state);

        assert_eq!(fx.read_disk().window.opacity, 0.25);
    }

    #[test]
    fn shutdown_flushes_multiple_queued_saves_in_order() {
        let fx = StateFixture::with(|c| c.window.opacity = 1.0);

        for opacity in [0.8, 0.6, 0.4, 0.2] {
            let mut cfg = fx.state.config.lock().unwrap();
            cfg.window.opacity = opacity;
            save_config(&fx.state, &cfg);
        }

        shutdown(&fx.state);

        assert_eq!(fx.read_disk().window.opacity, 0.2);
    }

    #[test]
    fn shutdown_is_idempotent() {
        let fx = StateFixture::new();
        shutdown(&fx.state);
        // Subsequent calls must not panic: the sender and thread handle
        // are already taken, and the latched flag makes the rest a no-op.
        shutdown(&fx.state);
        shutdown(&fx.state);
    }

    #[test]
    fn shutdown_latches_flag_for_polling_workers() {
        let fx = StateFixture::new();
        assert!(!fx.state.shutdown_flag.load(Ordering::Acquire));
        shutdown(&fx.state);
        assert!(
            fx.state.shutdown_flag.load(Ordering::Acquire),
            "geometry-saver thread polls this flag every tick"
        );
    }

    #[test]
    fn save_config_after_shutdown_is_a_silent_noop() {
        let fx = StateFixture::with(|c| c.window.opacity = 0.8);
        shutdown(&fx.state);

        {
            let mut cfg = fx.state.config.lock().unwrap();
            cfg.window.opacity = 0.2;
            save_config(&fx.state, &cfg);
        }

        assert_eq!(
            fx.read_disk().window.opacity,
            0.8,
            "save_config after shutdown must not touch disk or panic"
        );
    }

    #[test]
    fn clear_startup_click_through_unlocks_and_writes_synchronously() {
        // Production calls this in `setup`, before the event loop
        // starts. The write must be synchronous so the invariant
        // reaches disk before any subsequent crash.
        let fx = StateFixture::with(|c| c.window.locked = true);
        assert!(fx.read_memory().window.locked);

        let mut on_change_called = false;
        let changed = super::clear_startup_click_through_with(&fx.state, || {
            on_change_called = true;
        });

        assert!(changed);
        assert!(on_change_called, "window side effect must fire");

        // Crucially, no shutdown() call: the write is already on disk
        // via synchronous do_save_config.
        assert!(!fx.read_disk().window.locked);
    }

    #[test]
    fn clear_startup_click_through_noops_when_already_unlocked() {
        let fx = StateFixture::new();
        assert!(!fx.read_memory().window.locked);

        let mut on_change_called = false;
        let changed = super::clear_startup_click_through_with(&fx.state, || {
            on_change_called = true;
        });

        assert!(!changed);
        assert!(!on_change_called);
    }

    #[test]
    fn clear_startup_click_through_holds_mutex_across_window_side_effect() {
        // Pin the ordering contract: another thread can't observe
        // "locked=false in config but window still trapping cursor"
        // because the window side effect happens while the mutex is
        // still held.
        let fx = StateFixture::with(|c| c.window.locked = true);
        let mutex_was_held = {
            let state_for_probe = &fx.state;
            let mut observed = false;
            super::clear_startup_click_through_with(&fx.state, || {
                // If the closure ran after the mutex was released,
                // try_lock would succeed here.
                observed = state_for_probe.config.try_lock().is_err();
            });
            observed
        };
        assert!(
            mutex_was_held,
            "window side effect must run while the config mutex is held"
        );
    }

    #[test]
    fn clear_startup_click_through_still_persists_after_shutdown() {
        // Edge case: if shutdown ran before recovery (e.g. early
        // error in setup), recovery must still flush synchronously
        // via do_save_config rather than rely on the dropped channel.
        let fx = StateFixture::with(|c| c.window.locked = true);
        shutdown(&fx.state);

        let changed = super::clear_startup_click_through_with(&fx.state, || {});
        assert!(changed);

        assert!(!fx.read_disk().window.locked);
    }

    #[test]
    fn config_save_creates_bak_file_with_prior_state() {
        // `do_save_config` must copy the prior file to `.bak` before
        // writing the new one, so partial writes have a fallback.
        // Use the synchronous `do_save_config` directly so the test
        // doesn't race with the saver thread and so `shutdown`'s final
        // sync save doesn't overwrite the bak we want to inspect.
        let fx = StateFixture::with(|c| c.window.opacity = 0.9);

        let mut next = fx.read_memory();
        next.window.opacity = 0.5;
        do_save_config(&fx.state.config_path, &next);

        // Drain the saver thread cleanly.
        shutdown(&fx.state);

        // After shutdown's final sync save, the bak captures the
        // *most recent* prior state — which is our 0.5 write, since
        // shutdown saved 0.5 again on top.
        let bak_path = fx.temp.config_path().with_extension("json.bak");
        assert!(bak_path.exists(), "backup file must exist");

        let bak_config: AppConfig =
            serde_json::from_str(&fs::read_to_string(&bak_path).expect("read bak"))
                .expect("parse bak");
        assert_eq!(bak_config.window.opacity, 0.5, "bak is the prior on-disk state");
    }

    #[test]
    fn config_save_bak_captures_initial_when_shutdown_is_skipped() {
        // When a single save happens without a trailing shutdown, the
        // bak holds the pre-save state. Pinning this explicitly because
        // it's the scenario crash-recovery actually cares about: a crash
        // mid-write would leave a stale `.bak` that the user can
        // manually restore.
        let fx = StateFixture::with(|c| c.window.opacity = 0.9);

        let mut next = fx.read_memory();
        next.window.opacity = 0.5;
        do_save_config(&fx.state.config_path, &next);

        // No shutdown: the only write is the one we just did.
        let bak_path = fx.temp.config_path().with_extension("json.bak");
        assert!(bak_path.exists());

        let bak_config: AppConfig =
            serde_json::from_str(&fs::read_to_string(&bak_path).expect("read bak"))
                .expect("parse bak");
        assert_eq!(
            bak_config.window.opacity, 0.9,
            "bak must capture the initial state pre-save"
        );

        // Clean up: drop the fixture without shutdown (channel/thread
        // will be reaped by the Drop impl and a channel hang-up).
        drop(fx);
    }
}
