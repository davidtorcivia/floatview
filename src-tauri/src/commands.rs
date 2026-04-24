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
use crate::ops;
use crate::state::{authorize_command, AppState};
use crate::urls::{normalize_url, urls_match};
use crate::window_state::{persist_window_geometry, MIN_WINDOW_SIZE};

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
    let hotkeys_changed = {
        let mut current = state.config.lock().map_err(|e| e.to_string())?;
        let changed = current.hotkeys != config.hotkeys;
        *current = config.clone();
        save_config(&state, &current);
        changed
    };

    if hotkeys_changed {
        crate::hotkeys::re_register_hotkeys(&app);
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
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<bool, String> {
    authorize_command(&state, &token, "navigate_home")?;
    ops::navigate_home(&app)?;
    Ok(true)
}

#[tauri::command]
pub async fn toggle_always_on_top(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<bool, String> {
    authorize_command(&state, &token, "toggle_always_on_top")?;
    ops::toggle_always_on_top(&app)
}

#[tauri::command]
pub async fn set_opacity(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    opacity: f64,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "set_opacity")?;
    ops::set_opacity(&app, opacity)?;
    Ok(())
}

#[tauri::command]
pub async fn set_opacity_live(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    opacity: f64,
    token: String,
) -> Result<(), String> {
    // Intentionally skips persistence and the `opacity-changed` emit: this
    // is the slider-drag path, throttled from JS at ~30 Hz. Persist/emit
    // happens on `change` via `set_opacity`.
    authorize_command(&state, &token, "set_opacity_live")?;
    let opacity = clamp_opacity(opacity);
    opacity::set_window_opacity(&window, opacity);
    Ok(())
}

#[tauri::command]
pub async fn toggle_locked(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<bool, String> {
    authorize_command(&state, &token, "toggle_locked")?;
    ops::toggle_locked(&app)
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

/// Drop all global shortcut registrations until `resume_global_hotkeys`
/// is called. Used by the settings UI's hotkey-rebind capture so an
/// existing binding doesn't fire while the user is recording a new one.
#[tauri::command]
pub async fn pause_global_hotkeys(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "pause_global_hotkeys")?;
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _ = app.global_shortcut().unregister_all();
    Ok(())
}

/// Re-register global shortcuts from the current config. Pair with
/// `pause_global_hotkeys`; safe to call when nothing is paused (the
/// underlying register is idempotent on overwrite).
#[tauri::command]
pub async fn resume_global_hotkeys(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "resume_global_hotkeys")?;
    crate::hotkeys::register_hotkeys(&app);
    Ok(())
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

    // Halves/thirds/aspect resize. Corners and center don't take a size
    // here directly — they restore the pre-snap size if one was saved
    // (so corner snap after a half/third feels like "back to my normal
    // size in this corner"), otherwise keep current size.
    //
    // For corners/center we recompute position below using the size
    // we'll actually apply; ww/wh are recomputed after the size lookup.
    //
    // Padding budget per layout: edges + inter-tile gaps. Halves use
    // 3*padding (left edge, gap, right edge), thirds use 4*padding.
    let restored_size: Option<(i32, i32)> = match position.as_str() {
        "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center" => state
            .pre_snap_size
            .lock()
            .ok()
            .and_then(|mut g| g.take())
            .map(|(w, h)| (w as i32, h as i32)),
        _ => None,
    };

    let (eff_w, eff_h) = restored_size.unwrap_or((ww, wh));

    let (x, y, new_size) = match position.as_str() {
        "top-left" => (
            mx + padding,
            my + padding,
            restored_size.map(|(w, h)| (w, h)),
        ),
        "top-right" => (
            mx + mw - eff_w - padding,
            my + padding,
            restored_size.map(|(w, h)| (w, h)),
        ),
        "bottom-left" => (
            mx + padding,
            my + mh - eff_h - padding,
            restored_size.map(|(w, h)| (w, h)),
        ),
        "bottom-right" => (
            mx + mw - eff_w - padding,
            my + mh - eff_h - padding,
            restored_size.map(|(w, h)| (w, h)),
        ),
        "center" => (
            mx + (mw - eff_w) / 2,
            my + (mh - eff_h) / 2,
            restored_size.map(|(w, h)| (w, h)),
        ),
        "left-half" => {
            let w = ((mw - 3 * padding) / 2).max(MIN_WINDOW_SIZE);
            let h = (mh - 2 * padding).max(MIN_WINDOW_SIZE);
            (mx + padding, my + padding, Some((w, h)))
        }
        "right-half" => {
            let w = ((mw - 3 * padding) / 2).max(MIN_WINDOW_SIZE);
            let h = (mh - 2 * padding).max(MIN_WINDOW_SIZE);
            (mx + mw - padding - w, my + padding, Some((w, h)))
        }
        "top-half" => {
            let w = (mw - 2 * padding).max(MIN_WINDOW_SIZE);
            let h = ((mh - 3 * padding) / 2).max(MIN_WINDOW_SIZE);
            (mx + padding, my + padding, Some((w, h)))
        }
        "bottom-half" => {
            let w = (mw - 2 * padding).max(MIN_WINDOW_SIZE);
            let h = ((mh - 3 * padding) / 2).max(MIN_WINDOW_SIZE);
            (mx + padding, my + mh - padding - h, Some((w, h)))
        }
        "left-third" => {
            let w = ((mw - 4 * padding) / 3).max(MIN_WINDOW_SIZE);
            let h = (mh - 2 * padding).max(MIN_WINDOW_SIZE);
            (mx + padding, my + padding, Some((w, h)))
        }
        "center-third" => {
            let w = ((mw - 4 * padding) / 3).max(MIN_WINDOW_SIZE);
            let h = (mh - 2 * padding).max(MIN_WINDOW_SIZE);
            (mx + (mw - w) / 2, my + padding, Some((w, h)))
        }
        "right-third" => {
            let w = ((mw - 4 * padding) / 3).max(MIN_WINDOW_SIZE);
            let h = (mh - 2 * padding).max(MIN_WINDOW_SIZE);
            (mx + mw - padding - w, my + padding, Some((w, h)))
        }
        _ => return Err("Invalid snap position".to_string()),
    };

    // Halves/thirds (resizing) snaps mark the start of a snap chain.
    // Save current size so a follow-up corner snap can restore it.
    if matches!(
        position.as_str(),
        "left-half" | "right-half" | "top-half" | "bottom-half"
            | "left-third" | "center-third" | "right-third"
    ) {
        if let Ok(mut pre) = state.pre_snap_size.lock() {
            if pre.is_none() {
                *pre = Some((ww as u32, wh as u32));
            }
        }
    }

    use std::sync::atomic::Ordering;
    state.snap_resize_in_progress.store(true, Ordering::Release);

    let resize_result = (|| -> Result<(), String> {
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|e| e.to_string())?;
        }
        if let Some((w, h)) = new_size {
            window
                .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                    width: w as u32,
                    height: h as u32,
                }))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();

    state.snap_resize_in_progress.store(false, Ordering::Release);
    resize_result?;

    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
        .map_err(|e| e.to_string())?;

    persist_window_geometry(&window, &state)?;
    Ok(())
}

/// Parse an "N:M" aspect ratio string into a `(width, height)` pair.
/// Both components must be non-zero positive integers ≤ 1000 to filter
/// out absurd inputs that could overflow the resize math.
fn parse_aspect_ratio(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.splitn(2, ':');
    let w: u32 = parts.next()?.trim().parse().ok()?;
    let h: u32 = parts.next()?.trim().parse().ok()?;
    if w == 0 || h == 0 || w > 1000 || h > 1000 {
        return None;
    }
    Some((w, h))
}

/// Compute the new window size for a target aspect ratio. Picks the
/// "shrink the over-sized side" interpretation: if the window is too
/// wide for the target ratio, shrink width and keep height; if too tall,
/// shrink height and keep width. Always shrinks, never grows, so the
/// result never exceeds the original on either axis (apart from a 1px
/// rounding wiggle).
fn aspect_resize(cur_w: i32, cur_h: i32, rw: u32, rh: u32) -> (i32, i32) {
    let rw_i = rw as i64;
    let rh_i = rh as i64;
    let cw = cur_w as i64;
    let ch = cur_h as i64;
    // cw/ch > rw/rh  ⇔  cw*rh > ch*rw  (no float division)
    if cw * rh_i > ch * rw_i {
        let new_w = ((ch * rw_i + rh_i / 2) / rh_i) as i32;
        (new_w, cur_h)
    } else {
        let new_h = ((cw * rh_i + rw_i / 2) / rw_i) as i32;
        (cur_w, new_h)
    }
}

/// Resize the window to honor a target aspect ratio. Picks whichever
/// dimension is over-sized for the ratio and shrinks just that one,
/// keeping the other untouched (so a wide window narrows, a tall window
/// shortens). Result is re-centered on the original window center and
/// clamped to monitor bounds.
#[tauri::command]
pub async fn set_aspect_ratio(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    ratio: String,
    token: String,
) -> Result<(), String> {
    authorize_command(&state, &token, "set_aspect_ratio")?;

    let (rw, rh) = parse_aspect_ratio(&ratio)
        .ok_or_else(|| format!("Invalid aspect ratio: {}", ratio))?;

    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("No monitor found")?;

    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let cur_size = window.outer_size().map_err(|e| e.to_string())?;
    let cur_pos = window.outer_position().map_err(|e| e.to_string())?;

    let padding = (16.0 * scale) as i32;
    let max_w = (mon_size.width as i32 - 2 * padding).max(MIN_WINDOW_SIZE);
    let max_h = (mon_size.height as i32 - 2 * padding).max(MIN_WINDOW_SIZE);

    let (mut new_w, mut new_h) =
        aspect_resize(cur_size.width as i32, cur_size.height as i32, rw, rh);

    // Defensive: if the window started larger than the monitor, the
    // shrink-only result might still overflow. Scale both dims down
    // proportionally to fit.
    if new_h > max_h {
        new_h = max_h;
        new_w = ((new_h as f64) * (rw as f64) / (rh as f64)).round() as i32;
    }
    if new_w > max_w {
        new_w = max_w;
        new_h = ((new_w as f64) * (rh as f64) / (rw as f64)).round() as i32;
    }
    new_w = new_w.max(MIN_WINDOW_SIZE);
    new_h = new_h.max(MIN_WINDOW_SIZE);

    let center_x = cur_pos.x + cur_size.width as i32 / 2;
    let center_y = cur_pos.y + cur_size.height as i32 / 2;
    let mut new_x = center_x - new_w / 2;
    let mut new_y = center_y - new_h / 2;

    let min_x = mon_pos.x + padding;
    let max_x = mon_pos.x + mon_size.width as i32 - new_w - padding;
    let min_y = mon_pos.y + padding;
    let max_y = mon_pos.y + mon_size.height as i32 - new_h - padding;
    if max_x >= min_x {
        new_x = new_x.clamp(min_x, max_x);
    }
    if max_y >= min_y {
        new_y = new_y.clamp(min_y, max_y);
    }

    // Aspect-ratio snap is also a resize — start of a snap chain. Save
    // pre-snap size if not already saved so a corner snap can restore.
    if let Ok(mut pre) = state.pre_snap_size.lock() {
        if pre.is_none() {
            *pre = Some((cur_size.width, cur_size.height));
        }
    }

    use std::sync::atomic::Ordering;
    state.snap_resize_in_progress.store(true, Ordering::Release);

    let resize_result = (|| -> Result<(), String> {
        if window.is_maximized().unwrap_or(false) {
            window.unmaximize().map_err(|e| e.to_string())?;
        }
        window
            .set_size(tauri::Size::Physical(tauri::PhysicalSize {
                width: new_w as u32,
                height: new_h as u32,
            }))
            .map_err(|e| e.to_string())?;
        Ok(())
    })();

    state.snap_resize_in_progress.store(false, Ordering::Release);
    resize_result?;

    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: new_x, y: new_y }))
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
    let result = match updater.check().await {
        Ok(Some(update)) => Some(UpdateInfo {
            version: update.version.clone(),
            body: update.body.clone(),
        }),
        Ok(None) => None,
        Err(e) => return Err(e.to_string()),
    };
    // Keep the tray label in sync with whatever the settings UI just
    // found. The settings UI drives most "Check" clicks, but if the
    // user then closes settings without installing, the tray still
    // reflects availability.
    crate::state::update_tray_update_available(&app, result.as_ref().map(|u| u.version.as_str()));
    Ok(result)
}

/// Download + install the latest available update, emitting progress
/// events so the settings UI can show a progress bar. On success the
/// app restarts into the new version (via `app.restart()`).
///
/// Exposed to JS as a first-class command so users can drive the full
/// flow from the settings panel instead of having to dig into the tray.
/// Returns `Ok(false)` when no update is available — the UI shows a
/// "You're up to date" message without an error.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<bool, String> {
    authorize_command(&state, &token, "install_update")?;

    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => u,
        None => return Ok(false),
    };

    let _ = app.emit("update-install-status", "Downloading update…");

    let app_for_progress = app.clone();
    let mut downloaded: u64 = 0;
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let payload = UpdateProgress {
                    downloaded,
                    total: total.unwrap_or(0),
                };
                let _ = app_for_progress.emit("update-progress", payload);
            },
            || {},
        )
        .await;

    match result {
        Ok(()) => {
            let _ = app.emit("update-install-status", "Installing… restarting.");
            app.restart();
        }
        Err(e) => {
            let msg = format!("Install failed: {}", e);
            let _ = app.emit("update-install-status", &msg);
            Err(msg)
        }
    }
}

#[derive(serde::Serialize, Clone)]
struct UpdateProgress {
    downloaded: u64,
    total: u64,
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
    fn parse_aspect_ratio_accepts_common_ratios() {
        assert_eq!(parse_aspect_ratio("16:9"), Some((16, 9)));
        assert_eq!(parse_aspect_ratio("4:3"), Some((4, 3)));
        assert_eq!(parse_aspect_ratio(" 21 : 9 "), Some((21, 9)));
        assert_eq!(parse_aspect_ratio("1:1"), Some((1, 1)));
    }

    #[test]
    fn aspect_resize_shrinks_width_when_too_wide() {
        // 2000x500 → 16:9 should keep height and pull width to 16/9*500 ≈ 889
        let (w, h) = aspect_resize(2000, 500, 16, 9);
        assert_eq!(h, 500, "height must be preserved when window is too wide");
        assert!((w - 889).abs() <= 1, "width should shrink to ~889, got {}", w);
        assert!(w < 2000, "width should shrink, not grow");
    }

    #[test]
    fn aspect_resize_shrinks_height_when_too_tall() {
        // 400x1200 → 16:9 should keep width and pull height to 9/16*400 = 225
        let (w, h) = aspect_resize(400, 1200, 16, 9);
        assert_eq!(w, 400, "width must be preserved when window is too tall");
        assert!((h - 225).abs() <= 1, "height should shrink to ~225, got {}", h);
        assert!(h < 1200, "height should shrink, not grow");
    }

    #[test]
    fn aspect_resize_already_at_ratio_is_a_noop() {
        let (w, h) = aspect_resize(1600, 900, 16, 9);
        assert_eq!((w, h), (1600, 900));
    }

    #[test]
    fn aspect_resize_handles_square_target() {
        // 1600x900 → 1:1 should pick the smaller dim (height) and shrink width
        let (w, h) = aspect_resize(1600, 900, 1, 1);
        assert_eq!(h, 900);
        assert_eq!(w, 900);
    }

    #[test]
    fn aspect_resize_handles_tall_target() {
        // 1000x800 → 9:16: current ratio (1.25) > target (0.5625), so too wide
        // → keep height, shrink width to 800 * 9/16 = 450
        let (w, h) = aspect_resize(1000, 800, 9, 16);
        assert_eq!(h, 800);
        assert!((w - 450).abs() <= 1, "got width {}", w);
    }

    #[test]
    fn parse_aspect_ratio_rejects_garbage() {
        assert!(parse_aspect_ratio("16x9").is_none());
        assert!(parse_aspect_ratio("0:9").is_none());
        assert!(parse_aspect_ratio("16:0").is_none());
        assert!(parse_aspect_ratio("9999:1").is_none());
        assert!(parse_aspect_ratio("nope").is_none());
        assert!(parse_aspect_ratio("").is_none());
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
