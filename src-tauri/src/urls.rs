//! URL parsing, normalization, and comparison helpers.
//!
//! Used by command handlers, config sanitization, and bookmark dedup.

use url::Url;

pub const MAX_URL_LEN: usize = 2048;
pub const DEFAULT_HOME_URL: &str = "https://www.google.com";

/// Normalize a user-supplied URL string.
///
/// - Trims whitespace.
/// - Rejects empty / overly-long input.
/// - Prepends `https://` if no scheme is present.
/// - Rejects everything except http/https (no file://, javascript:, etc.).
/// - Requires a host.
/// - Returns the canonical parsed form via `Url::to_string()`.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty".to_string());
    }
    if trimmed.len() > MAX_URL_LEN {
        return Err("URL is too long".to_string());
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };

    let parsed = Url::parse(&candidate).map_err(|_| "Invalid URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Only http and https URLs are allowed".to_string()),
    }
    if parsed.host_str().is_none() {
        return Err("URL must include a host".to_string());
    }

    Ok(parsed.to_string())
}

/// Compare two URLs for bookmark-style equivalence.
///
/// Equal if identical, or if origin + path (trailing-slash-insensitive) +
/// query match. Fragments are ignored. Used to dedup bookmarks and recent
/// history across minor variations that the user would consider "the same
/// page."
pub fn urls_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let Ok(ua) = Url::parse(a) else { return false };
    let Ok(ub) = Url::parse(b) else { return false };
    ua.origin() == ub.origin()
        && ua.path().trim_end_matches('/') == ub.path().trim_end_matches('/')
        && ua.query() == ub.query()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_url_adds_https_scheme() {
        let normalized = normalize_url("example.com").expect("url should normalize");
        assert_eq!(normalized, "https://example.com/");
    }

    #[test]
    fn normalize_url_rejects_non_http_schemes() {
        assert!(normalize_url("file:///tmp/test").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn normalize_url_rejects_empty_and_overlong() {
        assert!(normalize_url("").is_err());
        assert!(normalize_url("   ").is_err());
        let too_long = "https://example.com/".to_string() + &"a".repeat(MAX_URL_LEN);
        assert!(normalize_url(&too_long).is_err());
    }

    #[test]
    fn urls_match_compares_normalized_forms() {
        assert!(urls_match("https://example.com/", "https://example.com"));
        assert!(urls_match(
            "https://example.com/path",
            "https://example.com/path/"
        ));
        assert!(urls_match(
            "https://example.com/?q=1",
            "https://example.com?q=1"
        ));
        assert!(!urls_match(
            "https://example.com/a",
            "https://example.com/b"
        ));
        assert!(!urls_match("https://example.com/", "http://example.com/"));
        assert!(!urls_match(
            "https://example.com/?q=1",
            "https://example.com/?q=2"
        ));
    }

    #[test]
    fn urls_match_handles_unparseable() {
        assert!(!urls_match("not a url", "https://example.com/"));
        assert!(urls_match("not a url", "not a url"));
    }
}
