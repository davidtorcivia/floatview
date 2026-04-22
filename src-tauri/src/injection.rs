//! Webview initialization script + the small media-control JS snippets
//! executed by direct-action helpers.
//!
//! The big control strip lives in `injection.js`. Two placeholders are
//! replaced at build time: the per-session command token, and the
//! configured home URL.

/// Full control-strip script, embedded at compile time.
const INJECTION_SCRIPT: &str = include_str!("injection.js");

const COMMAND_TOKEN_PLACEHOLDER: &str = "__FLOATVIEW_COMMAND_TOKEN__";
const HOME_URL_PLACEHOLDER: &str = "\"__FLOATVIEW_HOME_URL__\"";

/// Build the initialization script for a new webview by substituting the
/// per-session command token and the home URL into the embedded template.
///
/// The token is a v4 UUID (alphanumerics + hyphens) so a plain `replace`
/// is safe for it. The home URL is substituted as a full JS string literal
/// via `serde_json` so quotes/backslashes/control chars in a tampered-with
/// config can't escape the quoting and become executable code.
pub fn build_injection_script(command_token: &str, home_url: &str) -> String {
    let home_literal = serde_json::to_string(home_url)
        .unwrap_or_else(|_| "\"\"".to_string());
    INJECTION_SCRIPT
        .replace(COMMAND_TOKEN_PLACEHOLDER, command_token)
        .replace(HOME_URL_PLACEHOLDER, &home_literal)
}

/// Build a JS snippet that navigates the webview to the given URL.
///
/// The URL is serialized as a JSON string literal so any character is
/// safely quoted. Callers should still pre-normalize via
/// `crate::urls::normalize_url` to enforce the http/https allowlist.
pub fn js_navigate(url: &str) -> String {
    let literal = serde_json::to_string(url).unwrap_or_else(|_| "\"\"".to_string());
    format!("window.location.href = {};", literal)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_navigate_quotes_special_characters() {
        // The URL we produce always comes from url::Url::to_string, but this
        // test pins the defensive quoting so a future refactor doesn't
        // introduce a JS-injection hole.
        let js = js_navigate("https://example.com/\"break out");
        // The inner quote must be escaped so it stays inside the string
        // literal that wraps it.
        assert!(js.contains("\\\""), "double quotes must be escaped: {}", js);
    }

    #[test]
    fn js_navigate_produces_valid_statement() {
        let js = js_navigate("https://example.com/");
        assert_eq!(js, r#"window.location.href = "https://example.com/";"#);
    }

    #[test]
    fn build_injection_script_substitutes_home_url_as_literal() {
        let script = build_injection_script("tkn", "https://host.test/");
        assert!(
            script.contains(r#"EMBEDDED_HOME_URL = "https://host.test/""#),
            "home URL must be substituted as a JSON string literal"
        );
        assert!(script.contains("COMMAND_TOKEN = 'tkn'"));
    }

    #[test]
    fn build_injection_script_escapes_hostile_home_url() {
        // Sanitization should never let this through, but belt-and-braces:
        // even if a malicious home URL reaches here, the embedded value
        // must be a closed string literal (no line breaks, no unescaped
        // quote that could terminate the assignment).
        let script = build_injection_script("tkn", "\";alert(1);//");
        let expected = serde_json::to_string("\";alert(1);//").unwrap();
        let needle = format!("EMBEDDED_HOME_URL = {}", expected);
        assert!(
            script.contains(&needle),
            "hostile home_url must appear as a JSON-encoded literal"
        );
    }

    #[test]
    fn build_injection_script_escapes_line_breaks_in_home_url() {
        // Newlines would otherwise let a hostile string terminate the
        // line-based assignment. serde_json turns them into \n escapes.
        let script = build_injection_script("tkn", "https://x/\n//evil");
        assert!(!script.contains("https://x/\n//evil"));
        assert!(script.contains(r"https://x/\n//evil"));
    }
}
