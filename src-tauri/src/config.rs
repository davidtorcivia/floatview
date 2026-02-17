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
            width: 800,
            height: 450,
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
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            toggle_on_top: "Alt+Shift+T".to_string(),
            toggle_locked: "Alt+Shift+D".to_string(),
            opacity_up: "Alt+Shift+Up".to_string(),
            opacity_down: "Alt+Shift+Down".to_string(),
            toggle_visibility: "Alt+Shift+H".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub window: WindowConfig,
    pub last_url: Option<String>,
    pub recent_urls: Option<Vec<String>>,
    pub audio_device_id: Option<String>,
    pub launch_at_startup: bool,
    pub hotkeys: HotkeyConfig,
    #[serde(default = "default_home_url")]
    pub home_url: String,
    #[serde(default = "default_true")]
    pub first_run: bool,
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
            audio_device_id: None,
            launch_at_startup: false,
            hotkeys: HotkeyConfig::default(),
            home_url: default_home_url(),
            first_run: true,
        }
    }
}
