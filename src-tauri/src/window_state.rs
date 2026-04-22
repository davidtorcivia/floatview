//! Window geometry constants, clamping, persistence, and startup state
//! restoration.
//!
//! `persist_window_geometry` is called from explicit commands, the
//! CloseRequested handler, and the periodic auto-save thread. It skips
//! minimized/maximized windows (whose reported size wouldn't reflect
//! user intent) and anything unreasonably small, to avoid overwriting
//! good geometry with a transient bad measurement.

use tauri::{Monitor, WebviewWindow};
use tracing::{debug, warn};

use crate::config::AppConfig;
use crate::config_io::save_config;
use crate::state::AppState;

pub const DEFAULT_WINDOW_WIDTH: i32 = 1280;
pub const DEFAULT_WINDOW_HEIGHT: i32 = 720;
pub const MIN_WINDOW_SIZE: i32 = 200;
pub const MAX_WINDOW_SIZE: i32 = 10_000;

/// Clamp a persisted size to sane bounds. If both dimensions match the
/// minimum (typically meaning the window was saved while minimized) we
/// reset to the default size rather than come back up as a 200x200 square.
pub fn normalize_startup_window_size(width: i32, height: i32) -> (i32, i32) {
    let width = width.clamp(MIN_WINDOW_SIZE, MAX_WINDOW_SIZE);
    let height = height.clamp(MIN_WINDOW_SIZE, MAX_WINDOW_SIZE);
    if width == MIN_WINDOW_SIZE && height == MIN_WINDOW_SIZE {
        (DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT)
    } else {
        (width, height)
    }
}

/// Update the geometry fields of an `AppConfig` in place, clamping size to
/// sane bounds.
pub fn update_window_geometry_config(
    config: &mut AppConfig,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) {
    config.window.x = x;
    config.window.y = y;
    config.window.width = width.clamp(MIN_WINDOW_SIZE, MAX_WINDOW_SIZE);
    config.window.height = height.clamp(MIN_WINDOW_SIZE, MAX_WINDOW_SIZE);
}

/// Snapshot the current window geometry and enqueue a config save.
///
/// Skips minimized/maximized windows (preserving whatever was saved last
/// time the window was a normal restorable size) and windows reporting
/// dimensions below `MIN_WINDOW_SIZE` (treated as a transient bad read).
pub fn persist_window_geometry(
    window: &WebviewWindow,
    state: &AppState,
) -> Result<(), String> {
    if window.is_minimized().map_err(|e| e.to_string())? {
        debug!("Skipping geometry persistence because window is minimized");
        return Ok(());
    }
    if window.is_maximized().map_err(|e| e.to_string())? {
        debug!("Skipping geometry persistence because window is maximized");
        return Ok(());
    }

    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    if size.width < MIN_WINDOW_SIZE as u32 || size.height < MIN_WINDOW_SIZE as u32 {
        warn!(
            width = size.width,
            height = size.height,
            "Skipping geometry persistence due to unexpectedly small window size"
        );
        return Ok(());
    }

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    update_window_geometry_config(
        &mut config,
        position.x,
        position.y,
        size.width as i32,
        size.height as i32,
    );
    save_config(state, &config);
    drop(config);
    Ok(())
}

/// Is the saved geometry within a reasonable overlap of *any* current
/// monitor? Used to avoid restoring a window onto a now-disconnected
/// display, where it would be invisible.
pub fn is_position_visible(
    monitors: &[Monitor],
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> bool {
    const MIN_OVERLAP: i32 = 50;
    for monitor in monitors {
        let mp = monitor.position();
        let ms = monitor.size();
        let mx = mp.x;
        let my = mp.y;
        let mw = ms.width as i32;
        let mh = ms.height as i32;
        let overlap_x = (x + width).min(mx + mw) - x.max(mx);
        let overlap_y = (y + height).min(my + mh) - y.max(my);
        if overlap_x >= MIN_OVERLAP && overlap_y >= MIN_OVERLAP {
            return true;
        }
    }
    false
}

/// Apply persisted window state (always-on-top, click-through, size, and
/// position) to a freshly-created window. If the saved position isn't on
/// any currently connected monitor, center the window instead.
pub fn apply_window_state(window: &WebviewWindow, config: &AppConfig) {
    let _ = window.set_always_on_top(config.window.always_on_top);
    let _ = window.set_ignore_cursor_events(config.window.locked);

    let (width, height) = normalize_startup_window_size(config.window.width, config.window.height);

    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: width as u32,
        height: height as u32,
    }));

    let monitors = window.available_monitors().unwrap_or_default();
    if !monitors.is_empty()
        && !is_position_visible(&monitors, config.window.x, config.window.y, width, height)
    {
        let _ = window.center();
    } else {
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: config.window.x,
            y: config.window.y,
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
