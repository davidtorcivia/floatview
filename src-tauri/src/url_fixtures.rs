//! Shared truth table for URL equivalence cases.
//!
//! [`URL_MATCH_CASES`] is the single source of truth for what
//! [`crate::urls::urls_match`] (and its JS mirror in `injection.js`,
//! exported for testing from `js/urltest.mjs`) must consider equivalent.
//! Driven by the loop test in [`crate::urls::tests`] and duplicated (with
//! a cross-reference comment) in `js/urltest.test.mjs`.
//!
//! When you add a case here, add the same case to the JS test file so the
//! Rust and JS implementations stay in lockstep — they are the two copies
//! of the bookmark-equivalence heuristic, and silent drift between them is
//! exactly what this table exists to prevent.

/// `(a, b, expected)` triples for `urls_match`.
///
/// - Trailing-slash on the path is insignificant.
/// - Origin (scheme + host + port) must match.
/// - Query must match.
/// - Fragment is ignored.
/// - Userinfo (username/password) is significant — a credentialed URL is
///   NOT equivalent to an uncredentialed one, because `Url::origin()`
///   (RFC 6454) excludes userinfo and we don't want a `user:pass@host`
///   bookmark to silently dedup against plain `host`.
pub const URL_MATCH_CASES: &[(&str, &str, bool)] = &[
    // Identical strings short-circuit before any parsing.
    ("https://example.com/", "https://example.com/", true),
    // Trailing slash on the root or a path is insignificant.
    ("https://example.com/", "https://example.com", true),
    (
        "https://example.com/path",
        "https://example.com/path/",
        true,
    ),
    // Query match (the `?` vs no-separator forms normalize the same).
    ("https://example.com/?q=1", "https://example.com?q=1", true),
    // Different paths don't match.
    ("https://example.com/a", "https://example.com/b", false),
    // Different scheme (http vs https) doesn't match.
    ("https://example.com/", "http://example.com/", false),
    // Different query values don't match.
    (
        "https://example.com/?q=1",
        "https://example.com/?q=2",
        false,
    ),
    // Fragments are ignored.
    ("https://example.com/a#frag", "https://example.com/a", true),
    // Different hosts don't match.
    ("https://a.example.com/", "https://b.example.com/", false),
    // Userinfo is significant.
    (
        "https://user:pass@example.com/",
        "https://example.com/",
        false,
    ),
    (
        "https://alice@example.com/",
        "https://bob@example.com/",
        false,
    ),
    (
        "https://user:pass@example.com/path",
        "https://user:pass@example.com/path/",
        true,
    ),
    // Bare username still distinguishes from no-credentials.
    ("https://u@example.com/", "https://example.com/", false),
    // Unparseable inputs: equal strings still match (short-circuit),
    // otherwise false.
    ("not a url", "not a url", true),
    ("not a url", "https://example.com/", false),
];
