//! Config persistence pipeline: load, sanitize, save-via-channel,
//! synchronous shutdown flush, and path discovery.
//!
//! All writes go through an atomic `write-tmp -> rename` with a `.bak`
//! snapshot of the previous file kept for crash recovery. Saves during
//! normal operation are serialized through a background thread so
//! command handlers never block on disk I/O while holding the config
//! mutex. `shutdown()` drops the sender, joins the thread, and writes
//! one final copy synchronously.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
use tracing::{error, warn};

use crate::config::{clamp_opacity, AppConfig, CropConfig};
use crate::state::AppState;
use crate::urls::{normalize_url, DEFAULT_HOME_URL};
use crate::window_state::normalize_startup_window_size;

pub const MAX_HOTKEY_LEN: usize = 64;

/// Minimum crop dimension as a fraction of viewport. Below this, applyCrop's
/// 1/w scale blows up toward infinity; injection.js's interactive selector
/// already rejects anything under 5% (0.05), so 1% is a defensive floor for
/// tampered configs.
pub const CROP_MIN_DIM: f64 = 0.01;

/// Resolve the path where `config.json` lives. Creates the directory if
/// it doesn't exist yet. Falls back to the CWD if neither platform
/// `app_config_dir` nor `app_log_dir` is accessible.
pub fn get_config_path(app: &AppHandle) -> PathBuf {
    let app_dir = match app.path().app_config_dir() {
        Ok(path) => path,
        Err(e) => {
            warn!("Failed to resolve app config dir: {}", e);
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        }
    };
    if let Err(e) = fs::create_dir_all(&app_dir) {
        warn!("Failed to create config directory: {}", e);
    }
    app_dir.join("config.json")
}

/// Best-effort rescue of a corrupt/missing config by resetting bad fields
/// to their defaults. Specifically:
///
/// - Clamps window geometry / opacity / monitor index.
/// - Rejects non-http(s) URLs in `home_url`, `last_url`, `recent_urls`,
///   `bookmarks`; normalizes the rest.
/// - Enforces 50-bookmark and 10-recent-URL caps.
/// - Restores missing or too-short hotkeys to their defaults.
/// - Clamps crop region within `[0, 1]`, enforces a minimum size, and
///   drops the crop entirely if any component is non-finite (NaN/Inf
///   would panic in `f64::clamp` further down the pipeline).
pub fn sanitize_config(mut config: AppConfig) -> AppConfig {
    let (width, height) = normalize_startup_window_size(config.window.width, config.window.height);
    config.window.width = width;
    config.window.height = height;
    config.window.opacity = clamp_opacity(config.window.opacity);
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
    config.hotkeys.media_play_pause =
        sanitize_hotkey(&config.hotkeys.media_play_pause, "Alt+Shift+P");
    config.hotkeys.media_next = sanitize_hotkey(&config.hotkeys.media_next, "Alt+Shift+Right");
    config.hotkeys.media_previous =
        sanitize_hotkey(&config.hotkeys.media_previous, "Alt+Shift+Left");

    let mut deduped_bookmarks = Vec::new();
    let mut seen_bookmarks = HashSet::new();
    for url in std::mem::take(&mut config.bookmarks) {
        if let Ok(normalized) = normalize_url(&url) {
            if seen_bookmarks.insert(normalized.clone()) {
                deduped_bookmarks.push(normalized);
            }
        }
        if deduped_bookmarks.len() >= 50 {
            break;
        }
    }
    config.bookmarks = deduped_bookmarks;

    // Drop non-finite crop values up-front: f64::clamp panics when max is NaN,
    // and we don't want non-finite values reaching applyCrop anyway.
    if let Some(crop) = config.crop.take() {
        if crop.x.is_finite()
            && crop.y.is_finite()
            && crop.width.is_finite()
            && crop.height.is_finite()
        {
            let width = crop.width.clamp(CROP_MIN_DIM, 1.0);
            let height = crop.height.clamp(CROP_MIN_DIM, 1.0);
            // Ensure crop stays within viewport bounds after width/height clamp.
            let x = crop.x.clamp(0.0, 1.0 - width);
            let y = crop.y.clamp(0.0, 1.0 - height);
            config.crop = Some(CropConfig { x, y, width, height });
        }
    }

    config
}

fn sanitize_hotkey(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_HOTKEY_LEN {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Load `config.json` from disk, or return a sanitized default if the file
/// is missing / unreadable / malformed.
pub fn load_config(path: &Path) -> AppConfig {
    if path.exists() {
        match fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(config) => return sanitize_config(config),
                Err(e) => warn!("Failed to parse config: {}", e),
            },
            Err(e) => warn!("Failed to read config: {}", e),
        }
    }
    sanitize_config(AppConfig::default())
}

/// Write `config` to disk atomically. Copies the existing file to `.bak`
/// first, writes to a `.tmp` sibling, then renames. On rename failure the
/// existing file is preserved and the temp is left for manual recovery.
pub fn do_save_config(path: &Path, config: &AppConfig) {
    match serde_json::to_string_pretty(config) {
        Ok(content) => {
            if path.exists() {
                let _ = fs::copy(path, path.with_extension("json.bak"));
            }
            let tmp_path = path.with_extension("json.tmp");
            if let Err(e) = fs::write(&tmp_path, content) {
                warn!("Failed to save config: {}", e);
                return;
            }
            if let Err(e) = fs::rename(&tmp_path, path) {
                error!("Failed to finalize config save: {}", e);
                // Keep existing config file; temp file remains for manual recovery
            }
        }
        Err(e) => error!("Failed to serialize config: {}", e),
    }
}

/// Queue a save for the background saver thread. Cheap: clones the config
/// and pushes it onto an unbounded mpsc. A no-op after `shutdown()`.
pub fn save_config(state: &AppState, config: &AppConfig) {
    if let Ok(guard) = state.save_tx.lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(config.clone());
        }
    }
}

/// Update `last_url` / `recent_urls` and enqueue a save if anything changed.
///
/// Early-returns without a save if the url is already at the head of recents
/// and already recorded as `last_url`, avoiding redundant disk writes from
/// the injection script's 3-second polling loop.
pub fn persist_recent_url(state: &AppState, url: &str) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let last_url_unchanged = config.last_url.as_deref() == Some(url);
    if !last_url_unchanged {
        config.last_url = Some(url.to_string());
    }

    let recent = config.recent_urls.get_or_insert_with(Vec::new);
    let recent_unchanged = recent.first().is_some_and(|u| u == url);
    if !recent_unchanged {
        recent.retain(|u| u != url);
        recent.insert(0, url.to_string());
        if recent.len() > 10 {
            recent.truncate(10);
        }
    }

    if last_url_unchanged && recent_unchanged {
        return Ok(());
    }

    save_config(state, &config);
    drop(config);
    Ok(())
}

/// Graceful shutdown. Signals background workers, drops the save channel
/// sender so the saver thread exits its recv loop after draining any
/// pending messages, joins the thread, then writes the current in-memory
/// config directly. After this runs `save_config` becomes a no-op. Safe to
/// call multiple times (idempotent on already-taken Options and on a
/// latched shutdown flag).
pub fn shutdown(state: &AppState) {
    state.shutdown_flag.store(true, Ordering::Release);
    if let Ok(mut guard) = state.save_tx.lock() {
        guard.take();
    }
    if let Ok(mut guard) = state.save_thread.lock() {
        if let Some(handle) = guard.take() {
            if let Err(e) = handle.join() {
                error!("Saver thread panicked during shutdown: {:?}", e);
            }
        }
    }
    if let Ok(config) = state.config.lock() {
        do_save_config(&state.config_path, &config);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CropConfig;
    use crate::window_state::{
        DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH, MAX_WINDOW_SIZE, MIN_WINDOW_SIZE,
    };

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
    fn sanitize_config_restores_default_size_from_minimized_geometry() {
        let mut config = AppConfig::default();
        config.window.width = 0;
        config.window.height = 0;

        let sanitized = sanitize_config(config);
        assert_eq!(sanitized.window.width, DEFAULT_WINDOW_WIDTH);
        assert_eq!(sanitized.window.height, DEFAULT_WINDOW_HEIGHT);
    }

    #[test]
    fn sanitize_config_clamps_crop_and_keeps_it_in_bounds() {
        let config = AppConfig {
            crop: Some(CropConfig {
                x: 0.9,
                y: 0.9,
                width: 0.5,
                height: 0.5,
            }),
            ..AppConfig::default()
        };
        let sanitized = sanitize_config(config);
        let crop = sanitized.crop.expect("crop should be preserved");
        assert!((crop.x + crop.width) <= 1.0 + f64::EPSILON);
        assert!((crop.y + crop.height) <= 1.0 + f64::EPSILON);
    }

    #[test]
    fn sanitize_config_clamps_tiny_crop_dims() {
        let config = AppConfig {
            crop: Some(CropConfig {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0001,
            }),
            ..AppConfig::default()
        };
        let sanitized = sanitize_config(config);
        let crop = sanitized.crop.expect("crop should be preserved");
        assert!(crop.width >= CROP_MIN_DIM);
        assert!(crop.height >= CROP_MIN_DIM);
    }

    #[test]
    fn sanitize_config_drops_non_finite_crop() {
        let config = AppConfig {
            crop: Some(CropConfig {
                x: f64::NAN,
                y: 0.0,
                width: 0.5,
                height: 0.5,
            }),
            ..AppConfig::default()
        };
        let sanitized = sanitize_config(config);
        assert!(sanitized.crop.is_none());
    }

    #[test]
    fn sanitize_config_enforces_bookmark_limit() {
        let config = AppConfig {
            bookmarks: (0..100).map(|i| format!("https://site{}.com/", i)).collect(),
            ..AppConfig::default()
        };
        let sanitized = sanitize_config(config);
        assert_eq!(sanitized.bookmarks.len(), 50);
    }
}
