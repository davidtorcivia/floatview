//! System tray icon + right-click menu.
//!
//! Menu items are plain `MenuItem`s, not checkable, because Tauri v2's
//! checkable items are fiddly across platforms. Each menu action either
//! calls into `actions::do_*` (which matches the command behavior without
//! needing a token) or handles window show/hide inline.
//!
//! The tray's "Exit Click-Through Mode" item is stored on `AppState` so
//! toggle_locked / exit_click_through can enable/disable it. It starts
//! disabled because the startup path force-clears locked state for safety.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tracing::error;

use crate::actions::{
    do_exit_click_through, do_install_update, do_navigate_home, do_toggle_always_on_top,
    do_toggle_locked,
};
use crate::state::AppState;
use crate::window_state::persist_window_geometry;

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let go_home = MenuItem::with_id(app, "go_home", "Go Home", true, None::<&str>)?;
    let toggle_top = MenuItem::with_id(
        app,
        "toggle_top",
        "Toggle Always on Top",
        true,
        None::<&str>,
    )?;
    let toggle_lock = MenuItem::with_id(
        app,
        "toggle_lock",
        "Toggle Click-Through",
        true,
        None::<&str>,
    )?;
    // Starts disabled: the app force-clears locked mode on startup for safety,
    // and toggle_locked / exit_click_through update this via AppState.
    let exit_lock = MenuItem::with_id(
        app,
        "exit_lock",
        "Exit Click-Through Mode",
        false,
        None::<&str>,
    )?;
    let show = MenuItem::with_id(app, "show", "Show/Hide Window", true, None::<&str>)?;
    let install_update = MenuItem::with_id(
        app,
        "install_update",
        "Install Available Update",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &settings,
            &go_home,
            &toggle_top,
            &toggle_lock,
            &exit_lock,
            &show,
            &install_update,
            &quit,
        ],
    )?;

    // Fall back to a 1x1 transparent pixel so a missing icon asset can't
    // crash startup. Shouldn't happen in a packaged build — this is a
    // belt-and-braces for dev/test.
    let icon = match app.default_window_icon().cloned() {
        Some(icon) => icon,
        None => tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1),
    };

    {
        let state = app.state::<AppState>();
        let lock_result = state.tray_exit_lock_item.lock();
        match lock_result {
            Ok(mut guard) => *guard = Some(exit_lock.clone()),
            Err(e) => error!("tray_exit_lock_item mutex poisoned during setup: {}", e),
        }
    }

    let _tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .tooltip("FloatView - Right-click for options")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app.emit("open-settings", ());
                    let _ = window.eval(
                        "if(window.__floatViewUpdate) window.__floatViewUpdate('open_settings', true)",
                    );
                }
            }
            "go_home" => do_navigate_home(app),
            "toggle_top" => do_toggle_always_on_top(app),
            "toggle_lock" => do_toggle_locked(app),
            "exit_lock" => do_exit_click_through(app),
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            "install_update" => do_install_update(app),
            "quit" => {
                if let Some(window) = app.get_webview_window("main") {
                    let state = app.state::<AppState>();
                    let _ = persist_window_geometry(&window, &state);
                }
                // RunEvent::Exit handles the final flush + saver join.
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}
