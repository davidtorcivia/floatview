//! Webview initialization script + the small media-control JS snippets
//! executed by direct-action helpers.
//!
//! The big control strip lives in `injection.js`. Two placeholders are
//! replaced at build time: the per-session command token, and the
//! configured home URL.

/// Full control-strip script, embedded at compile time.
const INJECTION_SCRIPT: &str = include_str!("injection.js");

const COMMAND_TOKEN_PLACEHOLDER: &str = "__FLOATVIEW_COMMAND_TOKEN__";
const HOME_URL_PLACEHOLDER: &str = "__FLOATVIEW_HOME_URL__";

/// Build the initialization script for a new webview by substituting the
/// per-session command token and the home URL into the embedded template.
pub fn build_injection_script(command_token: &str, home_url: &str) -> String {
    INJECTION_SCRIPT
        .replace(COMMAND_TOKEN_PLACEHOLDER, command_token)
        .replace(HOME_URL_PLACEHOLDER, home_url)
}

/// Toggle play/pause on the most recently interacted media element, or the
/// first `<video>`/`<audio>` if no interaction has been tracked yet.
pub const MEDIA_PLAY_PAUSE_SCRIPT: &str = r#"
(() => {
  const media = window.__floatViewLastMedia || document.querySelector('video, audio');
  if (!media) return;
  if (media.paused) {
    media.play().catch(() => {});
  } else {
    media.pause();
  }
})();
"#;

/// Seek forward 30 seconds. Guards against live streams (non-finite duration)
/// and non-finite `currentTime`.
pub const MEDIA_NEXT_SCRIPT: &str = r#"
(() => {
  const media = window.__floatViewLastMedia || document.querySelector('video, audio');
  if (!media) return;
  if (Number.isFinite(media.duration) && Number.isFinite(media.currentTime)) {
    media.currentTime = Math.min(media.duration, media.currentTime + 30);
  } else if (Number.isFinite(media.currentTime)) {
    media.currentTime = media.currentTime + 30;
  }
})();
"#;

/// Seek backward 15 seconds. Guards against non-finite `currentTime`.
pub const MEDIA_PREVIOUS_SCRIPT: &str = r#"
(() => {
  const media = window.__floatViewLastMedia || document.querySelector('video, audio');
  if (!media) return;
  if (Number.isFinite(media.currentTime)) {
    media.currentTime = Math.max(0, media.currentTime - 15);
  }
})();
"#;

/// User-Agent override. Set to Edge on Windows so Emby/Plex serve Direct Play.
#[cfg(target_os = "windows")]
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

#[cfg(target_os = "macos")]
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
