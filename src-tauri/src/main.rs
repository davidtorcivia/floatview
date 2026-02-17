#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_updater::UpdaterExt;
use tracing::{error, info, warn};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use url::Url;

mod config;
mod opacity;

use config::AppConfig;

const INJECTION_SCRIPT: &str = include_str!("injection.js");
const DEFAULT_HOME_URL: &str = "https://www.google.com";
const MAX_URL_LEN: usize = 2048;
const MAX_HOTKEY_LEN: usize = 64;
const MIN_WINDOW_SIZE: i32 = 200;
const MAX_WINDOW_SIZE: i32 = 10_000;

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

pub struct LoggingState {
    _guard: WorkerGuard,
}

fn init_logging<R: Runtime>(app: &AppHandle<R>) -> Option<WorkerGuard> {
    let log_dir = app
        .path()
        .app_log_dir()
        .or_else(|_| app.path().app_config_dir().map(|p| p.join("logs")))
        .unwrap_or_else(|_| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("logs")
        });

    if let Err(e) = fs::create_dir_all(&log_dir) {
        eprintln!("Failed to create log directory: {}", e);
        return None;
    }

    let file_appender = tracing_appender::rolling::daily(&log_dir, "floatview.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,floatview=debug"));

    let console_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_ansi(true);
    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true);

    if tracing_subscriber::registry()
        .with(filter)
        .with(console_layer)
        .with(file_layer)
        .try_init()
        .is_err()
    {
        eprintln!("Tracing subscriber was already initialized");
        return None;
    }

    info!(path = %log_dir.display(), "Logging initialized");
    Some(guard)
}

fn get_config_path(app: &AppHandle) -> PathBuf {
    let app_dir = match app.path().app_config_dir() {
        Ok(path) => path,
        Err(e) => {
            eprintln!("Failed to resolve app config dir: {}", e);
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        }
    };
    if let Err(e) = fs::create_dir_all(&app_dir) {
        eprintln!("Failed to create config directory: {}", e);
    }
    app_dir.join("config.json")
}

fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty".to_string());
    }
    if trimmed.len() > MAX_URL_LEN {
        return Err("URL is too long".to_string());
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };

    let parsed = Url::parse(&candidate).map_err(|_| "Invalid URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Only http and https URLs are allowed".to_string()),
    }
    if parsed.host_str().is_none() {
        return Err("URL must include a host".to_string());
    }

    Ok(parsed.to_string())
}

fn sanitize_hotkey(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_HOTKEY_LEN {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_config(mut config: AppConfig) -> AppConfig {
    config.window.width = config.window.width.clamp(MIN_WINDOW_SIZE, MAX_WINDOW_SIZE);
    config.window.height = config.window.height.clamp(MIN_WINDOW_SIZE, MAX_WINDOW_SIZE);
    config.window.opacity = config.window.opacity.clamp(0.1, 1.0);
    config.window.monitor = config.window.monitor.max(0);

    config.home_url = normalize_url(&config.home_url)
        .or_else(|_| normalize_url(DEFAULT_HOME_URL))
        .unwrap_or_else(|_| DEFAULT_HOME_URL.to_string());
    config.last_url = config
        .last_url
        .take()
        .and_then(|url| normalize_url(&url).ok());

    let mut deduped_recent = Vec::new();
    let mut seen = HashSet::new();
    for url in config.recent_urls.take().unwrap_or_default() {
        if let Ok(normalized) = normalize_url(&url) {
            if seen.insert(normalized.clone()) {
                deduped_recent.push(normalized);
            }
        }
        if deduped_recent.len() >= 10 {
            break;
        }
    }
    config.recent_urls = Some(deduped_recent);

    config.hotkeys.toggle_on_top = sanitize_hotkey(&config.hotkeys.toggle_on_top, "Alt+Shift+T");
    config.hotkeys.toggle_locked = sanitize_hotkey(&config.hotkeys.toggle_locked, "Alt+Shift+D");
    config.hotkeys.opacity_up = sanitize_hotkey(&config.hotkeys.opacity_up, "Alt+Shift+Up");
    config.hotkeys.opacity_down = sanitize_hotkey(&config.hotkeys.opacity_down, "Alt+Shift+Down");
    config.hotkeys.toggle_visibility =
        sanitize_hotkey(&config.hotkeys.toggle_visibility, "Alt+Shift+H");

    config
}

fn load_config(path: &PathBuf) -> AppConfig {
    if path.exists() {
        match fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(config) => return sanitize_config(config),
                Err(e) => eprintln!("Failed to parse config: {}", e),
            },
            Err(e) => eprintln!("Failed to read config: {}", e),
        }
    }
    sanitize_config(AppConfig::default())
}

fn save_config(path: &PathBuf, config: &AppConfig) {
    match serde_json::to_string_pretty(config) {
        Ok(content) => {
            let tmp_path = path.with_extension("json.tmp");
            if let Err(e) = fs::write(&tmp_path, content) {
                eprintln!("Failed to save config: {}", e);
                return;
            }
            if let Err(e) = fs::rename(&tmp_path, path) {
                // Windows cannot overwrite an existing file via rename.
                let _ = fs::remove_file(path);
                if let Err(e2) = fs::rename(&tmp_path, path) {
                    eprintln!("Failed to finalize config save: {} / {}", e, e2);
                    let _ = fs::remove_file(&tmp_path);
                }
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
    let config = sanitize_config(config);
    {
        let mut current = state.config.lock().map_err(|e| e.to_string())?;
        *current = config.clone();
    }
    save_config(&state.config_path, &config);

    app.emit("config-changed", &config)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn navigate(window: WebviewWindow, url: String) -> Result<(), String> {
    let url = normalize_url(&url)?;
    window
        .eval(&format!("window.location.href = {:?}", url))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn toggle_always_on_top(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let current = window.is_always_on_top().map_err(|e| e.to_string())?;
    let new_value = !current;
    window
        .set_always_on_top(new_value)
        .map_err(|e| e.to_string())?;

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.window.always_on_top = new_value;
    let config_clone = config.clone();
    drop(config);
    save_config(&state.config_path, &config_clone);

    app.emit("always-on-top-changed", new_value)
        .map_err(|e| e.to_string())?;
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

    app.emit("opacity-changed", opacity)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn set_opacity_live(window: WebviewWindow, opacity: f64) -> Result<(), String> {
    let opacity = opacity.clamp(0.1, 1.0);
    opacity::set_window_opacity(&window, opacity);
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

    window
        .set_ignore_cursor_events(new_value)
        .map_err(|e| e.to_string())?;

    app.emit("locked-changed", new_value)
        .map_err(|e| e.to_string())?;
    Ok(new_value)
}

#[tauri::command]
async fn set_url(state: tauri::State<'_, AppState>, url: String) -> Result<(), String> {
    let url = normalize_url(&url)?;
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.last_url = Some(url.clone());

    let recent = config.recent_urls.get_or_insert_with(Vec::new);
    recent.retain(|u| u != &url);
    recent.insert(0, url.clone());
    if recent.len() > 10 {
        recent.truncate(10);
    }

    let config_clone = config.clone();
    drop(config);
    save_config(&state.config_path, &config_clone);
    Ok(())
}

fn update_window_geometry_config(config: &mut AppConfig, x: i32, y: i32, width: i32, height: i32) {
    config.window.x = x;
    config.window.y = y;
    config.window.width = width.clamp(MIN_WINDOW_SIZE, MAX_WINDOW_SIZE);
    config.window.height = height.clamp(MIN_WINDOW_SIZE, MAX_WINDOW_SIZE);
}

fn persist_window_geometry<R: Runtime>(
    window: &WebviewWindow<R>,
    state: &AppState,
) -> Result<(), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    update_window_geometry_config(
        &mut config,
        position.x,
        position.y,
        size.width as i32,
        size.height as i32,
    );
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
    persist_window_geometry(&window, &state)
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

        window
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;

        app.emit("locked-changed", false)
            .map_err(|e| e.to_string())?;
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
        normalize_url(&config_clone.home_url).unwrap_or_else(|_| DEFAULT_HOME_URL.to_string())
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
            normalize_url(&config.home_url).unwrap_or_else(|_| DEFAULT_HOME_URL.to_string())
        } else {
            DEFAULT_HOME_URL.to_string()
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
            let mut config = match state.config.lock() {
                Ok(config) => config,
                Err(e) => {
                    error!("Failed to lock config in do_toggle_locked: {}", e);
                    return;
                }
            };
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

    if let Some(window) = app.get_webview_window("main") {
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
            save_config(&state.config_path, &config);
        }

        let _ = window.set_ignore_cursor_events(false);

        let _ = app.emit("locked-changed", false);
        let _ =
            window.eval("if(window.__floatViewUpdate) window.__floatViewUpdate('locked', false)");
    }
}

fn do_opacity_change<R: Runtime>(app: &AppHandle<R>, delta: f64) {
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
        let hotkeys = match state.config.lock() {
            Ok(config) => config.hotkeys.clone(),
            Err(e) => {
                error!("Failed to lock config while registering hotkeys: {}", e);
                return Ok(());
            }
        };
        hotkeys
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
        app.global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    do_toggle_always_on_top(&app_h);
                }
            })?;
    }

    if let Some((modifiers, code)) = parse_hotkey(&hotkeys.toggle_locked) {
        let app_h = app_handle.clone();
        let shortcut = Shortcut::new(Some(modifiers), code);
        app.global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    do_toggle_locked(&app_h);
                }
            })?;
    }

    if let Some((modifiers, code)) = parse_hotkey(&hotkeys.opacity_up) {
        let app_h = app_handle.clone();
        let shortcut = Shortcut::new(Some(modifiers), code);
        app.global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    do_opacity_change(&app_h, 0.05);
                }
            })?;
    }

    if let Some((modifiers, code)) = parse_hotkey(&hotkeys.opacity_down) {
        let app_h = app_handle.clone();
        let shortcut = Shortcut::new(Some(modifiers), code);
        app.global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    do_opacity_change(&app_h, -0.05);
                }
            })?;
    }

    if let Some((modifiers, code)) = parse_hotkey(&hotkeys.toggle_visibility) {
        let shortcut = Shortcut::new(Some(modifiers), code);
        app.global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
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
    let exit_lock = MenuItem::with_id(
        app,
        "exit_lock",
        "Exit Click-Through Mode",
        true,
        None::<&str>,
    )?;
    let show = MenuItem::with_id(app, "show", "Show/Hide Window", true, None::<&str>)?;
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
            &quit,
        ],
    )?;

    let icon = app.default_window_icon().cloned().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "app should have a default window icon",
        )
    })?;

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Some(guard) = init_logging(&app.handle()) {
                app.manage(LoggingState { _guard: guard });
            } else {
                warn!("Structured logging was not initialized");
            }

            info!("FloatView setup started");
            let config_path = get_config_path(&app.handle());
            let config = load_config(&config_path);
            info!(path = %config_path.display(), "Configuration loaded");

            let state = AppState {
                config: Mutex::new(config.clone()),
                config_path,
            };
            app.manage(state);

            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("FloatView")
                    .inner_size(1280.0, 720.0)
                    .decorations(false)
                    .always_on_top(true)
                    .initialization_script(INJECTION_SCRIPT)
                    .user_agent(USER_AGENT)
                    .build()?;

            apply_window_state(&window, &config);

            let nav_url = config
                .last_url
                .clone()
                .and_then(|u| normalize_url(&u).ok())
                .or_else(|| normalize_url(&config.home_url).ok())
                .unwrap_or_else(|| DEFAULT_HOME_URL.to_string());
            let window_clone = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(100));
                let _ = window_clone.eval(&format!("window.location.href = {:?}", nav_url));
            });

            let app_handle = app.handle().clone();
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    let state = app_handle.state::<AppState>();
                    if let Err(e) = persist_window_geometry(&window_clone, &state) {
                        error!("Failed to persist window geometry on close: {}", e);
                    }
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
            set_opacity_live,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_url_adds_https_scheme() {
        let normalized = normalize_url("example.com").expect("url should normalize");
        assert_eq!(normalized, "https://example.com/");
    }

    #[test]
    fn normalize_url_rejects_non_http_schemes() {
        assert!(normalize_url("file:///tmp/test").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn sanitize_config_clamps_and_deduplicates() {
        let mut config = AppConfig::default();
        config.window.width = 10;
        config.window.height = 50_000;
        config.window.opacity = 2.0;
        config.window.monitor = -2;
        config.home_url = "javascript:alert(1)".to_string();
        config.last_url = Some("ftp://example.com".to_string());
        config.recent_urls = Some(vec![
            "http://example.com".to_string(),
            "example.com".to_string(),
            "https://example.com".to_string(),
            "javascript:alert(1)".to_string(),
        ]);
        config.hotkeys.toggle_on_top = "".to_string();

        let sanitized = sanitize_config(config);
        assert_eq!(sanitized.window.width, MIN_WINDOW_SIZE);
        assert_eq!(sanitized.window.height, MAX_WINDOW_SIZE);
        assert_eq!(sanitized.window.opacity, 1.0);
        assert_eq!(sanitized.window.monitor, 0);
        assert_eq!(sanitized.home_url, "https://www.google.com/");
        assert!(sanitized.last_url.is_none());
        assert_eq!(
            sanitized.recent_urls.unwrap_or_default(),
            vec![
                "http://example.com/".to_string(),
                "https://example.com/".to_string(),
            ]
        );
        assert_eq!(sanitized.hotkeys.toggle_on_top, "Alt+Shift+T");
    }

    #[test]
    fn update_window_geometry_config_clamps_size() {
        let mut config = AppConfig::default();
        update_window_geometry_config(&mut config, 123, 456, 100, 25_000);

        assert_eq!(config.window.x, 123);
        assert_eq!(config.window.y, 456);
        assert_eq!(config.window.width, MIN_WINDOW_SIZE);
        assert_eq!(config.window.height, MAX_WINDOW_SIZE);
    }
}
