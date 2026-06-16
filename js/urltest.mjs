// Pure-function copies of the URL helpers that live inside FloatView's
// injected control strip (src-tauri/src/injection.js). Extracted here so
// they can be exercised under `node --test` without booting the webview.
//
// KEEP IN SYNC with:
//   - injection.js `urlsMatch` (~line 3346)
//   - injection.js URL-bar normalization logic (~line 3087)
//   - src-tauri/src/urls.rs `urls_match` / `normalize_url` (the Rust
//     authoritative copy)
//
// The shared Rust/JS truth table lives in src-tauri/src/url_fixtures.rs
// (`URL_MATCH_CASES`) and is duplicated (with a cross-reference comment)
// in urltest.test.mjs. Drift between the two is exactly what these tests
// exist to catch.

/// Compare two URLs for bookmark-style equivalence.
///
/// Equal if identical, or if origin + userinfo + path
/// (trailing-slash-insensitive) + query match. Fragments are ignored.
///
/// Userinfo (username/password) is compared explicitly because
/// `URL.origin` excludes it (RFC 6454): without the check,
/// `https://user:pass@host/` would silently dedup against plain
/// `https://host/`. Mirrors Rust `urls::urls_match`.
export function urlsMatch(a, b) {
    if (a === b) return true;
    try {
        const ua = new URL(a);
        const ub = new URL(b);
        return (
            ua.origin === ub.origin &&
            ua.username === ub.username &&
            ua.password === ub.password &&
            ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '') &&
            ua.search === ub.search
        );
    } catch {
        return false;
    }
}

/// Normalize a URL-bar input the way the injected strip does: prepend
/// `https://` when no scheme is present, and send anything that isn't a
/// clean http(s) URL (spaces, no dots, an explicit non-http scheme) to
/// DuckDuckGo as a search. Returns the final href string.
///
/// Mirrors the URL-bar handler in injection.js and the normalize+search
/// fallback in src/main.js.
export function normalizeUrlInput(raw) {
    const trimmed = String(raw).trim();
    if (!trimmed) return null;

    let url = trimmed;
    if (!/^https?:\/\//.test(url)) {
        if (url.includes(' ') || (!url.includes('.') && !url.includes(':'))) {
            return 'https://duckduckgo.com/?q=' + encodeURIComponent(trimmed);
        }
        url = 'https://' + url;
    }

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        return 'https://duckduckgo.com/?q=' + encodeURIComponent(trimmed);
    }
    return parsed.toString();
}
