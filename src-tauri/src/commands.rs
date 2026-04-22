//! All `#[tauri::command]` handlers exposed to the injection script.
//!
//! Every command takes a `token: String` parameter and calls
//! `authorize_command` before doing any work. Commands are thin wrappers
//! around helpers in `config_io`, `window_state`, etc.

use tauri::{AppHandle, Emitter, WebviewWindow};
use tauri_plugin_updater::UpdaterExt;

use crate::browsing_data;
use crate::config::{clamp_opacity, AppConfig, CropConfig};
use crate::config_io::{persist_recent_url, sanitize_config, save_config, CROP_MIN_DIM};
use crate::injection::js_navigate;
use crate::opacity;
use crate::state::{authorize_command, update_tray_exit_lock_enabled, AppState};
use crate::urls::{normalize_url, urls_match, DEFAULT_HOME_URL};
use crate::window_state::persist_window_geometry;

#[tauri::command]
pub async fn get_config(
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<AppConfig, String> {
    authorize_command(&state, &token, "get_config")?;
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    Ok(config)
}

#[tauri::command]
pub async fn update_config(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    config: AppConfig,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "update_config")?;
    let config = sanitize_config(config);
    {
        let mut current = state.config.lock().map_err(|e| e.to_string())?;
        *current = config.clone();
        save_config(&state, &current);
    }

    app.emit("config-changed", &config)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn navigate(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    url: String,
    token: String,
) -> Result<bool, String> {
    authorize_command(&state, &token, "navigate")?;
    let url = normalize_url(&url)?;
    persist_recent_url(&state, &url)?;
    window
        .eval(js_navigate(&url))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn navigate_home(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<bool, String> {
    authorize_command(&state, &token, "navigate_home")?;
    let home_url = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.last_url = None;
        save_config(&state, &config);
        normalize_url(&config.home_url).unwrap_or_else(|_| DEFAULT_HOME_URL.to_string())
    };
    let _ = window.eval("window.stop()");
    window
        .eval(js_navigate(&home_url))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn toggle_always_on_top(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<bool, String> {
    authorize_command(&state, &token, "toggle_always_on_top")?;
    let current = window.is_always_on_top().map_err(|e| e.to_string())?;
    let new_value = !current;
    window
        .set_always_on_top(new_value)
        .map_err(|e| e.to_string())?;

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.window.always_on_top = new_value;
    save_config(&state, &config);
    drop(config);

    app.emit("always-on-top-changed", new_value)
        .map_err(|e| e.to_string())?;
    Ok(new_value)
}

#[tauri::command]
pub async fn set_opacity(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    opacity: f64,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "set_opacity")?;
    let opacity = clamp_opacity(opacity);
    opacity::set_window_opacity(&window, opacity);

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.window.opacity = opacity;
    save_config(&state, &config);
    drop(config);

    app.emit("opacity-changed", opacity)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_opacity_live(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    opacity: f64,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "set_opacity_live")?;
    let opacity = clamp_opacity(opacity);
    opacity::set_window_opacity(&window, opacity);
    Ok(())
}

#[tauri::command]
pub async fn toggle_locked(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<bool, String> {
    authorize_command(&state, &token, "toggle_locked")?;
    let new_value = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        let new_value = !config.window.locked;
        config.window.locked = new_value;
        save_config(&state, &config);
        drop(config);
        new_value
    };

    window
        .set_ignore_cursor_events(new_value)
        .map_err(|e| e.to_string())?;

    update_tray_exit_lock_enabled(&app, new_value);

    app.emit("locked-changed", new_value)
        .map_err(|e| e.to_string())?;
    Ok(new_value)
}

#[tauri::command]
pub async fn set_url(
    state: tauri::State<'_, AppState>,
    url: String,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "set_url")?;
    let url = normalize_url(&url)?;
    persist_recent_url(&state, &url)
}

#[tauri::command]
pub async fn save_window_geometry(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "save_window_geometry")?;
    persist_window_geometry(&window, &state)
}

#[tauri::command]
pub async fn snap_window(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    position: String,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "snap_window")?;

    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("No monitor found")?;

    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let win_size = window.outer_size().map_err(|e| e.to_string())?;

    let padding = (16.0 * scale) as i32;
    let mx = mon_pos.x;
    let my = mon_pos.y;
    let mw = mon_size.width as i32;
    let mh = mon_size.height as i32;
    let ww = win_size.width as i32;
    let wh = win_size.height as i32;

    let (x, y) = match position.as_str() {
        "top-left" => (mx + padding, my + padding),
        "top-right" => (mx + mw - ww - padding, my + padding),
        "bottom-left" => (mx + padding, my + mh - wh - padding),
        "bottom-right" => (mx + mw - ww - padding, my + mh - wh - padding),
        "center" => (mx + (mw - ww) / 2, my + (mh - wh) / 2),
        _ => return Err("Invalid snap position".to_string()),
    };

    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())?;
    }

    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
        .map_err(|e| e.to_string())?;

    persist_window_geometry(&window, &state)?;
    Ok(())
}

#[tauri::command]
pub async fn open_settings(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "open_settings")?;
    window.emit("open-settings", ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn minimize_window(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "minimize_window")?;
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn close_window(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "close_window")?;
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn maximize_toggle(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "maximize_toggle")?;
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn get_version(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<String, String> {
    authorize_command(&state, &token, "get_version")?;
    Ok(app.package_info().version.to_string())
}

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    version: String,
    body: Option<String>,
}

#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<Option<UpdateInfo>, String> {
    authorize_command(&state, &token, "check_for_updates")?;
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
pub async fn exit_click_through(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "exit_click_through")?;
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    if config.window.locked {
        config.window.locked = false;
        save_config(&state, &config);
        drop(config);

        window
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;

        update_tray_exit_lock_enabled(&app, false);

        app.emit("locked-changed", false)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_window_title(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
    title: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "set_window_title")?;
    window
        .set_title(&truncate_title(&title))
        .map_err(|e| e.to_string())
}

/// Truncate a window title to a Win32-safe byte length, respecting UTF-8 char
/// boundaries. A naive `&s[..253]` panics when byte 253 lands inside a
/// multi-byte codepoint, which any page can trigger by crafting a title.
fn truncate_title(title: &str) -> String {
    const MAX_BYTES: usize = 256;
    if title.len() <= MAX_BYTES {
        return title.to_string();
    }
    let ellipsis = "...";
    let budget = MAX_BYTES - ellipsis.len();
    let mut cut = budget;
    while cut > 0 && !title.is_char_boundary(cut) {
        cut -= 1;
    }
    let mut out = String::with_capacity(cut + ellipsis.len());
    out.push_str(&title[..cut]);
    out.push_str(ellipsis);
    out
}

#[tauri::command]
pub async fn add_bookmark(
    state: tauri::State<'_, AppState>,
    url: String,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "add_bookmark")?;
    let url = normalize_url(&url)?;
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    if config.bookmarks.iter().any(|b| urls_match(b, &url)) {
        return Ok(());
    }
    if config.bookmarks.len() >= 50 {
        return Err("Bookmark limit reached (max 50)".to_string());
    }
    config.bookmarks.push(url);
    save_config(&state, &config);
    drop(config);
    Ok(())
}

#[tauri::command]
pub async fn remove_bookmark(
    state: tauri::State<'_, AppState>,
    url: String,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "remove_bookmark")?;
    let url = normalize_url(&url)?;
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.bookmarks.retain(|u| !urls_match(u, &url));
    save_config(&state, &config);
    drop(config);
    Ok(())
}

#[tauri::command]
pub async fn set_crop(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "set_crop")?;
    if !(x.is_finite() && y.is_finite() && width.is_finite() && height.is_finite()) {
        return Err("Crop values must be finite".to_string());
    }
    let width = width.clamp(CROP_MIN_DIM, 1.0);
    let height = height.clamp(CROP_MIN_DIM, 1.0);
    let x = x.clamp(0.0, 1.0 - width);
    let y = y.clamp(0.0, 1.0 - height);

    let snapshot = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.crop = Some(CropConfig { x, y, width, height });
        save_config(&state, &config);
        config.clone()
    };
    app.emit("config-changed", &snapshot)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn clear_crop(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "clear_crop")?;
    let snapshot = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        if config.crop.is_none() {
            return Ok(());
        }
        config.crop = None;
        save_config(&state, &config);
        config.clone()
    };
    app.emit("config-changed", &snapshot)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn clear_site_data(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "clear_site_data")?;
    browsing_data::clear_all(&window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_title_passes_short_titles_unchanged() {
        let title = "Short title";
        assert_eq!(truncate_title(title), title);
    }

    #[test]
    fn truncate_title_appends_ellipsis_past_limit() {
        let title = "a".repeat(300);
        let truncated = truncate_title(&title);
        assert!(truncated.len() <= 256);
        assert!(truncated.ends_with("..."));
    }

    #[test]
    fn truncate_title_respects_utf8_char_boundary() {
        // A naive `&s[..253]` panics here: byte 253 lands inside a 3-byte
        // CJK codepoint. truncate_title must back up to a boundary.
        let mut title = "a".repeat(252);
        title.push_str("日本語テスト");
        let truncated = truncate_title(&title);
        assert!(truncated.is_char_boundary(truncated.len() - "...".len()));
        assert!(truncated.ends_with("..."));
    }

    #[test]
    fn truncate_title_handles_edge_case_all_multibyte() {
        let title = "漢".repeat(200); // 3 bytes * 200 = 600 bytes
        let truncated = truncate_title(&title);
        assert!(truncated.len() <= 256);
        assert!(truncated.ends_with("..."));
        // Must not split a codepoint
        assert!(std::str::from_utf8(truncated.as_bytes()).is_ok());
    }
}
