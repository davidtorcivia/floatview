#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! FloatView entry point.
//!
//! Everything is split into focused modules:
//! - [`state`]       : `AppState`, token auth, tray-item mutator
//! - [`config`]      : serde config types
//! - [`config_io`]   : load/save/sanitize/shutdown of `config.json`
//! - [`urls`]        : URL normalization and match helpers
//! - [`logging`]     : tracing subscriber setup
//! - [`injection`]   : webview init script + media-control JS snippets
//! - [`window_state`]: geometry clamping, persistence, startup restore
//! - [`browsing_data`]: thin wrapper around WebView2 clear-all-data
//! - [`opacity`]     : per-platform opacity native interop
//! - [`actions`]     : direct-action helpers (hotkeys / tray)
//! - [`hotkeys`]     : hotkey parsing + global-shortcut registration
//! - [`commands`]    : all `#[tauri::command]` handlers
//! - [`tray`]        : tray icon + menu
//!
//! This file only wires `run()` together and owns the `RunEvent::Exit`
//! handler that flushes the config saver before the process exits.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tracing::{error, info, warn};
use uuid::Uuid;

mod actions;
mod browsing_data;
mod commands;
mod config;
mod config_io;
mod hotkeys;
mod injection;
mod logging;
mod opacity;
mod state;
mod tray;
mod urls;
mod window_state;

use crate::config_io::{do_save_config, get_config_path, load_config, shutdown};
use crate::injection::{build_injection_script, USER_AGENT};
use crate::logging::{init_logging, LoggingState};
use crate::state::AppState;
use crate::urls::{normalize_url, DEFAULT_HOME_URL};
use crate::window_state::{
    apply_window_state, persist_window_geometry, DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH,
};

fn run() {
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
                tray_exit_lock_item: Mutex::new(None),
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
            {
                let state_ref = app.state::<AppState>();
                let needs_write = {
                    let mut c = state_ref.config.lock().unwrap();
                    if c.window.locked {
                        c.window.locked = false;
                        let _ = window.set_ignore_cursor_events(false);
                        true
                    } else {
                        false
                    }
                };
                if needs_write {
                    if let Ok(c) = state_ref.config.lock() {
                        do_save_config(&state_ref.config_path, &c);
                    }
                }
            }

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
                let _ = window_clone.eval(format!("window.location.href = {:?}", nav_url));
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
            commands::open_settings,
            commands::exit_click_through,
            commands::minimize_window,
            commands::close_window,
            commands::maximize_toggle,
            commands::get_version,
            commands::check_for_updates,
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

fn main() {
    run()
}
