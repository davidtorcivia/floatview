use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyConfig {
    pub toggle_on_top: String,
    pub toggle_locked: String,
    pub opacity_up: String,
    pub opacity_down: String,
    pub toggle_visibility: String,
    pub media_play_pause: String,
    pub media_next: String,
    pub media_previous: String,
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
