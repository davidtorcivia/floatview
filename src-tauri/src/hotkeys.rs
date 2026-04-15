//! Global hotkey parsing and registration.
//!
//! Hotkey strings are of the form `Ctrl+Shift+T` / `Alt+F4` / etc. Parsing
//! is case-insensitive for both modifier and key names. Unknown keys
//! return `None` and the caller logs a warning rather than refusing to
//! start; this way a typo in one binding doesn't break the others.

use std::collections::HashMap;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tracing::{error, warn};

use crate::actions::{
    do_media_action, do_opacity_change, do_toggle_always_on_top, do_toggle_locked,
};
use crate::injection::{MEDIA_NEXT_SCRIPT, MEDIA_PLAY_PAUSE_SCRIPT, MEDIA_PREVIOUS_SCRIPT};
use crate::state::AppState;

/// Lowercased keyname → `Code` lookup. Populated lazily on first parse.
///
/// New keys go in the slice — entries are grouped alphabetically within
/// each class (letters, digits, arrows, whitespace-ish, navigation, F-keys,
/// punctuation) so insertions are obvious.
fn hotkey_code_map() -> &'static HashMap<&'static str, Code> {
    static MAP: OnceLock<HashMap<&'static str, Code>> = OnceLock::new();
    MAP.get_or_init(|| {
        let entries: &[(&'static str, Code)] = &[
            ("a", Code::KeyA), ("b", Code::KeyB), ("c", Code::KeyC), ("d", Code::KeyD),
            ("e", Code::KeyE), ("f", Code::KeyF), ("g", Code::KeyG), ("h", Code::KeyH),
            ("i", Code::KeyI), ("j", Code::KeyJ), ("k", Code::KeyK), ("l", Code::KeyL),
            ("m", Code::KeyM), ("n", Code::KeyN), ("o", Code::KeyO), ("p", Code::KeyP),
            ("q", Code::KeyQ), ("r", Code::KeyR), ("s", Code::KeyS), ("t", Code::KeyT),
            ("u", Code::KeyU), ("v", Code::KeyV), ("w", Code::KeyW), ("x", Code::KeyX),
            ("y", Code::KeyY), ("z", Code::KeyZ),
            ("0", Code::Digit0), ("1", Code::Digit1), ("2", Code::Digit2), ("3", Code::Digit3),
            ("4", Code::Digit4), ("5", Code::Digit5), ("6", Code::Digit6), ("7", Code::Digit7),
            ("8", Code::Digit8), ("9", Code::Digit9),
            ("up", Code::ArrowUp), ("down", Code::ArrowDown),
            ("left", Code::ArrowLeft), ("right", Code::ArrowRight),
            ("space", Code::Space), ("enter", Code::Enter),
            ("tab", Code::Tab), ("backspace", Code::Backspace), ("delete", Code::Delete),
            ("esc", Code::Escape), ("escape", Code::Escape),
            ("home", Code::Home), ("end", Code::End),
            ("pageup", Code::PageUp), ("pagedown", Code::PageDown),
            ("f1", Code::F1), ("f2", Code::F2), ("f3", Code::F3), ("f4", Code::F4),
            ("f5", Code::F5), ("f6", Code::F6), ("f7", Code::F7), ("f8", Code::F8),
            ("f9", Code::F9), ("f10", Code::F10), ("f11", Code::F11), ("f12", Code::F12),
            ("[", Code::BracketLeft), ("]", Code::BracketRight),
            (";", Code::Semicolon), ("'", Code::Quote),
            (",", Code::Comma), (".", Code::Period),
            ("/", Code::Slash), ("\\", Code::Backslash),
            ("`", Code::Backquote), ("-", Code::Minus), ("=", Code::Equal),
        ];
        entries.iter().copied().collect()
    })
}

/// Parse a hotkey string like `Ctrl+Shift+T` into a `(Modifiers, Code)`.
/// Returns `None` if the final component isn't a known key. Unknown
/// modifier tokens are silently ignored, not rejected.
pub fn parse_hotkey(s: &str) -> Option<(Modifiers, Code)> {
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

    let key = parts.last()?.trim().to_lowercase();
    let code = *hotkey_code_map().get(key.as_str())?;
    Some((modifiers, code))
}

/// Register all configured global hotkeys. Each binding is independent:
/// a registration failure on one doesn't prevent the others from being
/// set up, and a bad parse just skips that binding with a warning.
pub fn register_hotkeys(app: &AppHandle) {
    let hotkeys = {
        let state = app.state::<AppState>();
        let hotkeys = match state.config.lock() {
            Ok(config) => config.hotkeys.clone(),
            Err(e) => {
                error!("Failed to lock config while registering hotkeys: {}", e);
                return;
            }
        };
        hotkeys
    };

    register_one(app, &hotkeys.toggle_on_top, "toggle_on_top", {
        let app_h = app.clone();
        move || do_toggle_always_on_top(&app_h)
    });

    register_one(app, &hotkeys.toggle_locked, "toggle_locked", {
        let app_h = app.clone();
        move || do_toggle_locked(&app_h)
    });

    register_one(app, &hotkeys.opacity_up, "opacity_up", {
        let app_h = app.clone();
        move || do_opacity_change(&app_h, 0.05)
    });

    register_one(app, &hotkeys.opacity_down, "opacity_down", {
        let app_h = app.clone();
        move || do_opacity_change(&app_h, -0.05)
    });

    register_one(app, &hotkeys.toggle_visibility, "toggle_visibility", {
        let app_h = app.clone();
        move || {
            if let Some(window) = app_h.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        }
    });

    register_one(app, &hotkeys.media_play_pause, "media_play_pause", {
        let app_h = app.clone();
        move || do_media_action(&app_h, MEDIA_PLAY_PAUSE_SCRIPT)
    });

    register_one(app, &hotkeys.media_next, "media_next", {
        let app_h = app.clone();
        move || do_media_action(&app_h, MEDIA_NEXT_SCRIPT)
    });

    register_one(app, &hotkeys.media_previous, "media_previous", {
        let app_h = app.clone();
        move || do_media_action(&app_h, MEDIA_PREVIOUS_SCRIPT)
    });
}

/// Internal: parse + register one hotkey binding, logging on failure.
///
/// `action` takes no arguments — captures are up to the caller. This
/// keeps the 8 registration sites above to a single boilerplate-free
/// call each.
fn register_one<F>(app: &AppHandle, hotkey_str: &str, name: &'static str, action: F)
where
    F: Fn() + Send + Sync + 'static,
{
    let Some((modifiers, code)) = parse_hotkey(hotkey_str) else {
        warn!(hotkey = %hotkey_str, name, "hotkey did not parse");
        return;
    };
    let shortcut = Shortcut::new(Some(modifiers), code);
    if let Err(e) = app
        .global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                action();
            }
        })
    {
        warn!(
            hotkey = %hotkey_str,
            name,
            error = %e,
            "Failed to register hotkey"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hotkey_map_covers_alphabet_and_digits() {
        let map = hotkey_code_map();
        for c in 'a'..='z' {
            assert!(map.contains_key(c.to_string().as_str()), "missing {}", c);
        }
        for d in '0'..='9' {
            assert!(map.contains_key(d.to_string().as_str()), "missing {}", d);
        }
        for n in 1..=12 {
            assert!(map.contains_key(format!("f{}", n).as_str()), "missing f{}", n);
        }
    }

    #[test]
    fn hotkey_map_aliases_escape() {
        let map = hotkey_code_map();
        assert_eq!(map.get("esc"), map.get("escape"));
    }

    #[test]
    fn parse_hotkey_handles_modifiers_and_case() {
        let (mods, code) = parse_hotkey("Ctrl+Shift+T").expect("parse");
        assert!(mods.contains(Modifiers::CONTROL));
        assert!(mods.contains(Modifiers::SHIFT));
        assert_eq!(code, Code::KeyT);

        let (mods, _) = parse_hotkey("alt+shift+up").expect("parse");
        assert!(mods.contains(Modifiers::ALT));
        assert!(mods.contains(Modifiers::SHIFT));
    }

    #[test]
    fn parse_hotkey_rejects_unknown_key() {
        assert!(parse_hotkey("Ctrl+🎹").is_none());
        assert!(parse_hotkey("Alt+nope").is_none());
    }

    #[test]
    fn parse_hotkey_accepts_punctuation_and_fkeys() {
        assert!(parse_hotkey("Ctrl+-").is_some());
        assert!(parse_hotkey("Ctrl+=").is_some());
        assert!(parse_hotkey("F11").is_some());
    }
}
