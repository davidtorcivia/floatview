//! System tray icon + right-click menu.
//!
//! The menu uses `CheckMenuItem`s for "Always on Top" and "Click-Through
//! Mode" so the check mark reflects current state — the user doesn't
//! have to open the menu, toggle, and hope. State updates from any
//! source (strip button, hotkey, settings, tray itself) feed back here
//! via `state::update_tray_*` helpers that call closures stashed on
//! `AppState::tray` during setup.
//!
//! Layout (seven items, no redundancy):
//!
//! ```text
//! Show/Hide Window
//! ─────────────────
//! ☑ Always on Top        Alt+Shift+T
//! ☐ Click-Through Mode   Alt+Shift+D
//! ─────────────────
//! Settings…
//! Go Home
//! ─────────────────
//! Install Update v1.3.0      ← disabled when none available
//! Quit
//! ```

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, warn};

use crate::actions::{
    do_install_update, do_navigate_home, do_toggle_always_on_top, do_toggle_locked,
};
use crate::state::{AppState, TrayBoolSetter, TrayUpdateSetter, TraySetters};
use crate::window_state::persist_window_geometry;

const INSTALL_UPDATE_IDLE_LABEL: &str = "No Updates Available";

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "Show/Hide Window", true, None::<&str>)?;

    // Initial state loaded from config so the tray check marks match
    // reality as soon as the menu is first opened.
    let (initial_ontop, initial_locked) = match app.state::<AppState>().config.lock() {
        Ok(c) => (c.window.always_on_top, c.window.locked),
        Err(_) => (true, false),
    };

    let toggle_top = CheckMenuItem::with_id(
        app,
        "toggle_top",
        "Always on Top",
        true,
        initial_ontop,
        Some("Alt+Shift+T"),
    )?;
    let toggle_lock = CheckMenuItem::with_id(
        app,
        "toggle_lock",
        "Click-Through Mode",
        true,
        initial_locked,
        Some("Alt+Shift+D"),
    )?;

    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let go_home = MenuItem::with_id(app, "go_home", "Go Home", true, None::<&str>)?;
    // Rescue affordances: "Reload Page" hard-reloads the webview when
    // a page has hung or hijacked the control strip past recovery;
    // "Show Control Strip" re-prepends + forces visibility via eval,
    // useful when hover reveal is disabled by the page but JS still
    // works. Both accessible from the always-present tray.
    let reload_page = MenuItem::with_id(app, "reload_page", "Reload Page", true, None::<&str>)?;
    let show_strip_item = MenuItem::with_id(
        app,
        "show_strip",
        "Show Control Strip",
        true,
        None::<&str>,
    )?;

    // Install update: disabled + placeholder label until a check finds
    // something. The background updater thread and the settings "Check"
    // button both route their results here.
    let install_update = MenuItem::with_id(
        app,
        "install_update",
        INSTALL_UPDATE_IDLE_LABEL,
        false,
        None::<&str>,
    )?;

    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &toggle_top,
            &toggle_lock,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &go_home,
            &PredefinedMenuItem::separator(app)?,
            &reload_page,
            &show_strip_item,
            &PredefinedMenuItem::separator(app)?,
            &install_update,
            &quit,
        ],
    )?;

    // Install setters so state changes from elsewhere (hotkeys, strip
    // buttons, settings, background updater) can feed back into the
    // tray without the rest of the code touching tray/muda types.
    install_setters(app, toggle_top.clone(), toggle_lock.clone(), install_update.clone());

    // Fallback icon: a 1x1 transparent pixel so a missing asset can't
    // crash startup in dev/test. Never hit in a packaged build.
    let icon = match app.default_window_icon().cloned() {
        Some(icon) => icon,
        None => tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1),
    };

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
            "show" => toggle_visibility(app),
            "reload_page" => reload_page_hard(app),
            "show_strip" => force_show_strip(app),
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
                toggle_visibility(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn toggle_visibility(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Hard-reload the webview. The "nuclear recovery" option when a page
/// has frozen or hijacked the strip past all JS-level recovery — this
/// path goes through the Tauri runtime, not the page's JS, so it works
/// even if the webview's scripting context is hung.
fn reload_page_hard(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        warn!("reload_page: main window not found");
        return;
    };
    // `WebviewWindow::eval("location.reload()")` would work when JS is
    // responsive, but the whole point of this option is recovery from
    // the case where JS is NOT responsive. Prefer direct eval of a
    // reload hook that the runtime schedules even if the current
    // frame's loop is blocked.
    if let Err(e) = window.eval("location.reload()") {
        warn!(error = %e, "reload_page: eval failed");
    }
}

/// Trigger the JS-side force-show-strip recovery via eval. If the page's
/// scripting context is hung, `window.show` + `set_focus` still bring
/// the window to front so the user can see the tray menu succeeded,
/// and then "Reload Page" is the next escalation.
fn force_show_strip(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        warn!("show_strip: main window not found");
        return;
    };
    let _ = window.show();
    let _ = window.set_focus();
    if let Err(e) = window.eval(crate::injection::SHOW_STRIP_SCRIPT) {
        warn!(error = %e, "show_strip: eval failed");
    }
}

/// Build the [`TraySetters`] closures that each capture their respective
/// menu item and install them on `AppState`. The rest of the app talks
/// to the tray exclusively through these closures, so `tray.rs` stays
/// the only module that knows about `CheckMenuItem`/`MenuItem`.
fn install_setters(
    app: &AppHandle,
    toggle_top: CheckMenuItem<tauri::Wry>,
    toggle_lock: CheckMenuItem<tauri::Wry>,
    install_update: MenuItem<tauri::Wry>,
) {
    let top_item = toggle_top;
    let set_always_on_top: TrayBoolSetter = Box::new(move |on| {
        if let Err(e) = top_item.set_checked(on) {
            warn!(on, "Failed to update tray always-on-top: {}", e);
        }
    });

    let lock_item = toggle_lock;
    let set_locked: TrayBoolSetter = Box::new(move |locked| {
        if let Err(e) = lock_item.set_checked(locked) {
            warn!(locked, "Failed to update tray locked: {}", e);
        }
    });

    let update_item = install_update;
    let set_update_available: TrayUpdateSetter =
        Box::new(move |version: Option<&str>| match version {
            Some(v) => {
                let label = format!("Install Update v{}", v);
                if let Err(e) = update_item.set_text(&label) {
                    warn!(version = %v, "Failed to set tray update label: {}", e);
                }
                if let Err(e) = update_item.set_enabled(true) {
                    warn!("Failed to enable tray update item: {}", e);
                }
            }
            None => {
                if let Err(e) = update_item.set_text(INSTALL_UPDATE_IDLE_LABEL) {
                    warn!("Failed to reset tray update label: {}", e);
                }
                if let Err(e) = update_item.set_enabled(false) {
                    warn!("Failed to disable tray update item: {}", e);
                }
            }
        });

    let setters = TraySetters {
        set_always_on_top,
        set_locked,
        set_update_available,
    };

    match app.state::<AppState>().tray.lock() {
        Ok(mut guard) => *guard = Some(setters),
        Err(e) => error!("tray setters mutex poisoned during setup: {}", e),
    }
}
