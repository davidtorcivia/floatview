#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_updater::UpdaterExt;

mod config;
mod opacity;

use config::AppConfig;

const INJECTION_SCRIPT: &str = include_str!("injection.js");

#[cfg(target_os = "windows")]
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

#[cfg(target_os = "macos")]
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

pub struct AppState {
    config: Mutex<AppConfig>,
    config_path: PathBuf,
}

fn get_config_path(app: &AppHandle) -> PathBuf {
    let app_dir = app.path().app_config_dir().expect("failed to get config dir");
    fs::create_dir_all(&app_dir).ok();
    app_dir.join("config.json")
}

fn load_config(path: &PathBuf) -> AppConfig {
    if path.exists() {
        match fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(config) => return config,
                Err(e) => eprintln!("Failed to parse config: {}", e),
            },
            Err(e) => eprintln!("Failed to read config: {}", e),
        }
    }
    AppConfig::default()
}

fn save_config(path: &PathBuf, config: &AppConfig) {
    match serde_json::to_string_pretty(config) {
        Ok(content) => {
            if let Err(e) = fs::write(path, content) {
                eprintln!("Failed to save config: {}", e);
            }
        }
        Err(e) => eprintln!("Failed to serialize config: {}", e),
    }
}

#[tauri::command]
async fn get_config(state: tauri::State<'_, AppState>) -> Result<AppConfig, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.clone())
}

#[tauri::command]
async fn update_config(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    config: AppConfig,
) -> Result<(), String> {
    {
        let mut current = state.config.lock().map_err(|e| e.to_string())?;
        *current = config.clone();
    }
    save_config(&state.config_path, &config);

    app.emit("config-changed", &config).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn navigate(window: WebviewWindow, url: String) -> Result<(), String> {
    window.eval(&format!("window.location.href = {:?}", url)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn toggle_always_on_top(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let current = window.is_always_on_top().map_err(|e| e.to_string())?;
    let new_value = !current;
    window.set_always_on_top(new_value).map_err(|e| e.to_string())?;

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.window.always_on_top = new_value;
    let config_clone = config.clone();
    drop(config);
    save_config(&state.config_path, &config_clone);

    app.emit("always-on-top-changed", new_value).map_err(|e| e.to_string())?;
    Ok(new_value)
}

#[tauri::command]
async fn set_opacity(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    opacity: f64,
) -> Result<(), String> {
    let opacity = opacity.clamp(0.1, 1.0);
    opacity::set_window_opacity(&window, opacity);

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.window.opacity = opacity;
    let config_clone = config.clone();
    drop(config);
    save_config(&state.config_path, &config_clone);

    app.emit("opacity-changed", opacity).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn toggle_locked(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let new_value = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        let new_value = !config.window.locked;
        config.window.locked = new_value;
        let config_clone = config.clone();
        drop(config);
        save_config(&state.config_path, &config_clone);
        new_value
    };

    window.set_ignore_cursor_events(new_value).map_err(|e| e.to_string())?;

    app.emit("locked-changed", new_value).map_err(|e| e.to_string())?;
    Ok(new_value)
}

#[tauri::command]
async fn set_url(
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.last_url = Some(url.clone());

    if let Some(ref mut recent) = config.recent_urls {
        recent.retain(|u| u != &url);
        recent.insert(0, url.clone());
        if recent.len() > 10 {
            recent.truncate(10);
        }
    }

    let config_clone = config.clone();
    drop(config);
    save_config(&state.config_path, &config_clone);
    Ok(())
}

#[tauri::command]
async fn save_window_geometry(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.window.x = position.x;
    config.window.y = position.y;
    config.window.width = size.width as i32;
    config.window.height = size.height as i32;
    let config_clone = config.clone();
    drop(config);
    save_config(&state.config_path, &config_clone);
    Ok(())
}



#[tauri::command]
async fn open_settings(window: WebviewWindow) -> Result<(), String> {
    window.emit("open-settings", ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
async fn maximize_toggle(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn get_version(app: AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
    body: Option<String>,
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            body: update.body.clone(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    if let Some(update) = updater.check().await.map_err(|e| e.to_string())? {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}

#[tauri::command]
async fn exit_click_through(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    if config.window.locked {
        config.window.locked = false;
        let config_clone = config.clone();
        drop(config);
        save_config(&state.config_path, &config_clone);

        window.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;

        app.emit("locked-changed", false).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn navigate_home(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let home_url = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.last_url = None;
        let config_clone = config.clone();
        drop(config);
        save_config(&state.config_path, &config_clone);
        config_clone.home_url.clone()
    };
    let _ = window.eval("window.stop()");
    window
        .eval(&format!("window.location.href = {:?}", home_url))
        .map_err(|e| e.to_string())
}

// Direct action helpers (called from hotkeys and tray menu, no JS round-trip)
fn do_navigate_home<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let state = app.state::<AppState>();
        let home_url = if let Ok(mut config) = state.config.lock() {
            config.last_url = None;
            save_config(&state.config_path, &config);
            config.home_url.clone()
        } else {
            "https://www.google.com".to_string()
        };
        let _ = window.eval("window.stop()");
        let _ = window.eval(&format!("window.location.href = {:?}", home_url));
    }
}

fn do_toggle_always_on_top<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let current = window.is_always_on_top().unwrap_or(false);
        let new_value = !current;
        let _ = window.set_always_on_top(new_value);

        let state = app.state::<AppState>();
        if let Ok(mut config) = state.config.lock() {
            config.window.always_on_top = new_value;
            save_config(&state.config_path, &config);
        }

        let _ = app.emit("always-on-top-changed", new_value);
        let _ = window.eval(&format!(
            "if(window.__floatViewUpdate) window.__floatViewUpdate('always_on_top', {})",
            new_value
        ));
    }
}

fn do_toggle_locked<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let new_value = {
            let state = app.state::<AppState>();
            let mut config = state.config.lock().unwrap();
            let nv = !config.window.locked;
            config.window.locked = nv;
            save_config(&state.config_path, &config);
            nv
        };

        let _ = window.set_ignore_cursor_events(new_value);

        let _ = app.emit("locked-changed", new_value);
        let _ = window.eval(&format!(
            "if(window.__floatViewUpdate) window.__floatViewUpdate('locked', {})",
            new_value
        ));
    }
}

fn do_exit_click_through<R: Runtime>(app: &AppHandle<R>) {
    let is_locked = {
        let state = app.state::<AppState>();
        let config = state.config.lock().unwrap();
        config.window.locked
    };
    if !is_locked {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        {
            let state = app.state::<AppState>();
            let mut config = state.config.lock().unwrap();
            config.window.locked = false;
            save_config(&state.config_path, &config);
        }

        let _ = window.set_ignore_cursor_events(false);

        let _ = app.emit("locked-changed", false);
        let _ = window.eval("if(window.__floatViewUpdate) window.__floatViewUpdate('locked', false)");
    }
}

fn do_opacity_change<R: Runtime>(app: &AppHandle<R>, delta: f64) {
    if let Some(window) = app.get_webview_window("main") {
        let new_opacity = {
            let state = app.state::<AppState>();
            let mut config = state.config.lock().unwrap();
            let op = (config.window.opacity + delta).clamp(0.1, 1.0);
            config.window.opacity = op;
            save_config(&state.config_path, &config);
            op
        };

        opacity::set_window_opacity(&window, new_opacity);

        let _ = app.emit("opacity-changed", new_opacity);
        let _ = window.eval(&format!(
            "if(window.__floatViewUpdate) window.__floatViewUpdate('opacity', {})",
            new_opacity
        ));
    }
}

fn register_hotkeys<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let hotkeys = {
        let state = app.state::<AppState>();
        let config = state.config.lock().unwrap();
        config.hotkeys.clone()
    };

    fn parse_hotkey(s: &str) -> Option<(Modifiers, Code)> {
        let parts: Vec<&str> = s.split('+').collect();
        if parts.is_empty() {
            return None;
        }

        let mut modifiers = Modifiers::empty();
        for part in &parts[..parts.len() - 1] {
            match part.trim().to_lowercase().as_str() {
                "alt" => modifiers |= Modifiers::ALT,
                "shift" => modifiers |= Modifiers::SHIFT,
                "control" | "ctrl" => modifiers |= Modifiers::CONTROL,
                "super" | "win" | "meta" => modifiers |= Modifiers::SUPER,
                _ => {}
            }
        }

        let code = match parts.last()?.trim().to_lowercase().as_str() {
            "t" => Code::KeyT,
            "d" => Code::KeyD,
            "up" => Code::ArrowUp,
            "down" => Code::ArrowDown,
            "h" => Code::KeyH,
            _ => return None,
        };

        Some((modifiers, code))
    }

    let app_handle = app.clone();

    if let Some((modifiers, code)) = parse_hotkey(&hotkeys.toggle_on_top) {
        let app_h = app_handle.clone();
        let shortcut = Shortcut::new(Some(modifiers), code);
        app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                do_toggle_always_on_top(&app_h);
            }
        })?;
    }

    if let Some((modifiers, code)) = parse_hotkey(&hotkeys.toggle_locked) {
        let app_h = app_handle.clone();
        let shortcut = Shortcut::new(Some(modifiers), code);
        app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                do_toggle_locked(&app_h);
            }
        })?;
    }

    if let Some((modifiers, code)) = parse_hotkey(&hotkeys.opacity_up) {
        let app_h = app_handle.clone();
        let shortcut = Shortcut::new(Some(modifiers), code);
        app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                do_opacity_change(&app_h, 0.05);
            }
        })?;
    }

    if let Some((modifiers, code)) = parse_hotkey(&hotkeys.opacity_down) {
        let app_h = app_handle.clone();
        let shortcut = Shortcut::new(Some(modifiers), code);
        app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                do_opacity_change(&app_h, -0.05);
            }
        })?;
    }

    if let Some((modifiers, code)) = parse_hotkey(&hotkeys.toggle_visibility) {
        let shortcut = Shortcut::new(Some(modifiers), code);
        app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Some(window) = app_handle.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })?;
    }

    Ok(())
}

fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let go_home = MenuItem::with_id(app, "go_home", "Go Home", true, None::<&str>)?;
    let toggle_top = MenuItem::with_id(app, "toggle_top", "Toggle Always on Top", true, None::<&str>)?;
    let toggle_lock = MenuItem::with_id(app, "toggle_lock", "Toggle Click-Through", true, None::<&str>)?;
    let exit_lock = MenuItem::with_id(app, "exit_lock", "Exit Click-Through Mode", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show/Hide Window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&settings, &go_home, &toggle_top, &toggle_lock, &exit_lock, &show, &quit])?;

    let icon = app.default_window_icon().cloned()
        .expect("app should have a default window icon");

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("FloatView - Right-click for options")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app.emit("open-settings", ());
                    let _ = window.eval("if(window.__floatViewUpdate) window.__floatViewUpdate('open_settings', true)");
                }
            }
            "go_home" => {
                do_navigate_home(app);
            }
            "toggle_top" => {
                do_toggle_always_on_top(app);
            }
            "toggle_lock" => {
                do_toggle_locked(app);
            }
            "exit_lock" => {
                do_exit_click_through(app);
            }
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
            "quit" => {
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

fn apply_window_state(window: &WebviewWindow, config: &AppConfig) {
    let _ = window.set_always_on_top(config.window.always_on_top);
    opacity::set_window_opacity(window, config.window.opacity);

    if config.window.width > 0 && config.window.height > 0 {
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: config.window.width as u32,
            height: config.window.height as u32,
        }));
    }

    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: config.window.x,
        y: config.window.y,
    }));
}

fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let config_path = get_config_path(&app.handle());
            let config = load_config(&config_path);

            let state = AppState {
                config: Mutex::new(config.clone()),
                config_path,
            };
            app.manage(state);

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("FloatView")
            .inner_size(800.0, 450.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .initialization_script(INJECTION_SCRIPT)
            .user_agent(USER_AGENT)
            .build()?;

            apply_window_state(&window, &config);

            let nav_url = config.last_url.clone()
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| config.home_url.clone());
            if !nav_url.is_empty() {
                let window_clone = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    let _ = window_clone.eval(&format!("window.location.href = {:?}", nav_url));
                });
            }

            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    let _ = window_clone.emit("save-state", ());
                }
            });

            register_hotkeys(&app.handle())?;
            setup_tray(&app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            update_config,
            navigate,
            navigate_home,
            toggle_always_on_top,
            set_opacity,
            toggle_locked,
            set_url,
            save_window_geometry,
            open_settings,
            exit_click_through,
            minimize_window,
            close_window,
            maximize_toggle,
            get_version,
            check_for_updates,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run()
}
