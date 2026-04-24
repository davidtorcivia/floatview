use serde::{Deserialize, Serialize};

/// Minimum opacity. Below this the window becomes effectively invisible,
/// which is a click-through-style trap we don't want to reach by accident.
pub const MIN_OPACITY: f64 = 0.1;

/// Clamp an opacity value into the permitted range, snapping near-opaque
/// values to exactly 1.0 so the Windows backend can drop the layered flag
/// for clean rendering. Non-finite inputs (NaN/Inf) resolve to fully opaque.
pub fn clamp_opacity(opacity: f64) -> f64 {
    if !opacity.is_finite() {
        return 1.0;
    }
    if opacity > 0.99 {
        1.0
    } else {
        opacity.clamp(MIN_OPACITY, 1.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowConfig {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub monitor: i32,
    pub always_on_top: bool,
    pub opacity: f64,
    pub locked: bool,
}

impl Default for WindowConfig {
    fn default() -> Self {
        Self {
            x: 100,
            y: 100,
            width: 1280,
            height: 720,
            monitor: 0,
            always_on_top: true,
            opacity: 1.0,
            locked: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HotkeyConfig {
    pub toggle_on_top: String,
    pub toggle_locked: String,
    pub opacity_up: String,
    pub opacity_down: String,
    pub toggle_visibility: String,
    pub media_play_pause: String,
    pub media_next: String,
    pub media_previous: String,
    #[serde(default = "default_media_mute")]
    pub media_mute: String,
    #[serde(default = "default_zoom_video")]
    pub zoom_video: String,
    /// Emergency "force-show the control strip" hotkey. Always-works
    /// escape hatch for pathological page states (SPA DOM wipes, stray
    /// fullscreen layers, click-through left on). See also the
    /// [`ZOOM_VIDEO_SCRIPT`](crate::injection::ZOOM_VIDEO_SCRIPT)
    /// sibling scripts.
    #[serde(default = "default_show_strip")]
    pub show_strip: String,
}

fn default_media_mute() -> String {
    "Alt+Shift+M".to_string()
}

fn default_zoom_video() -> String {
    "Alt+Shift+V".to_string()
}

fn default_show_strip() -> String {
    "Alt+Shift+S".to_string()
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            toggle_on_top: "Alt+Shift+T".to_string(),
            toggle_locked: "Alt+Shift+D".to_string(),
            opacity_up: "Alt+Shift+Up".to_string(),
            opacity_down: "Alt+Shift+Down".to_string(),
            toggle_visibility: "Alt+Shift+H".to_string(),
            media_play_pause: "Alt+Shift+P".to_string(),
            media_next: "Alt+Shift+Right".to_string(),
            media_previous: "Alt+Shift+Left".to_string(),
            media_mute: default_media_mute(),
            zoom_video: default_zoom_video(),
            show_strip: default_show_strip(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CropConfig {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub window: WindowConfig,
    pub last_url: Option<String>,
    pub recent_urls: Option<Vec<String>>,
    pub hotkeys: HotkeyConfig,
    #[serde(default = "default_home_url")]
    pub home_url: String,
    #[serde(default = "default_true")]
    pub first_run: bool,
    #[serde(default)]
    pub auto_refresh_minutes: u32,
    #[serde(default)]
    pub bookmarks: Vec<String>,
    #[serde(default)]
    pub crop: Option<CropConfig>,
}

fn default_home_url() -> String {
    "https://www.google.com".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            window: WindowConfig::default(),
            last_url: None,
            recent_urls: Some(Vec::new()),
            hotkeys: HotkeyConfig::default(),
            home_url: default_home_url(),
            first_run: true,
            auto_refresh_minutes: 0,
            bookmarks: Vec::new(),
            crop: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_opacity_snaps_near_opaque() {
        assert_eq!(clamp_opacity(0.999), 1.0);
        assert_eq!(clamp_opacity(1.0), 1.0);
        assert_eq!(clamp_opacity(2.0), 1.0);
    }

    #[test]
    fn clamp_opacity_enforces_floor() {
        assert_eq!(clamp_opacity(0.0), MIN_OPACITY);
        assert_eq!(clamp_opacity(-5.0), MIN_OPACITY);
    }

    #[test]
    fn clamp_opacity_handles_non_finite() {
        assert_eq!(clamp_opacity(f64::NAN), 1.0);
        assert_eq!(clamp_opacity(f64::INFINITY), 1.0);
        assert_eq!(clamp_opacity(f64::NEG_INFINITY), 1.0);
    }

    #[test]
    fn clamp_opacity_preserves_mid_range() {
        assert_eq!(clamp_opacity(0.5), 0.5);
        assert_eq!(clamp_opacity(0.3), 0.3);
    }
}
