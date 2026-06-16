// Test suite for the JS URL helpers, run via `node --test`
// (or `npm test`, which the package.json "test" script wires to
// `node --test js/`).
//
// The URL_MATCH_CASES array below is a MANUAL DUPLICATE of
// src-tauri/src/url_fixtures.rs::URL_MATCH_CASES. The Rust file is the
// source of truth — when you change a case there, change it here too.
// A shared JSON file would avoid the duplication but would add a build
// step; a duplicated array with this cross-reference is the pragmatic
// zero-dependency choice. The Rust side independently asserts its own
// table in urls::tests::urls_match_matches_shared_truth_table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlsMatch, normalizeUrlInput } from './urltest.mjs';

const URL_MATCH_CASES = [
    ['https://example.com/', 'https://example.com/', true],
    ['https://example.com/', 'https://example.com', true],
    ['https://example.com/path', 'https://example.com/path/', true],
    ['https://example.com/?q=1', 'https://example.com?q=1', true],
    ['https://example.com/a', 'https://example.com/b', false],
    ['https://example.com/', 'http://example.com/', false],
    ['https://example.com/?q=1', 'https://example.com/?q=2', false],
    ['https://example.com/a#frag', 'https://example.com/a', true],
    ['https://a.example.com/', 'https://b.example.com/', false],
    ['https://user:pass@example.com/', 'https://example.com/', false],
    ['https://alice@example.com/', 'https://bob@example.com/', false],
    ['https://user:pass@example.com/path', 'https://user:pass@example.com/path/', true],
    ['https://u@example.com/', 'https://example.com/', false],
    ['not a url', 'not a url', true],
    ['not a url', 'https://example.com/', false],
];

test('urlsMatch agrees with the shared Rust/JS truth table', () => {
    URL_MATCH_CASES.forEach(([a, b, expected], i) => {
        assert.equal(
            urlsMatch(a, b),
            expected,
            `case #${i}: urlsMatch(${JSON.stringify(a)}, ${JSON.stringify(b)}) expected ${expected}`,
        );
    });
});

test('normalizeUrlInput adds https scheme to bare hosts', () => {
    assert.equal(normalizeUrlInput('example.com'), 'https://example.com/');
});

test('normalizeUrlInput sends multi-word input to DuckDuckGo', () => {
    assert.equal(
        normalizeUrlInput('rust web framework'),
        'https://duckduckgo.com/?q=rust%20web%20framework',
    );
});

test('normalizeUrlInput sends dotless non-port input to DuckDuckGo', () => {
    assert.equal(
        normalizeUrlInput('localhost search term'),
        'https://duckduckgo.com/?q=localhost%20search%20term',
    );
});

test('normalizeUrlInput keeps an explicit https URL canonical', () => {
    assert.equal(normalizeUrlInput('https://example.com/foo?q=1'), 'https://example.com/foo?q=1');
});

test('normalizeUrlInput prepends https to a dotted non-http scheme (matches injection.js URL bar)', () => {
    // The injected URL bar's heuristic only special-cases spaces and
    // dotless/portless input; anything else with a `.` gets `https://`
    // prepended. So `ftp://example.com` (which contains a dot) becomes
    // `https://ftp//example.com` — odd, but it's the documented URL-bar
    // behavior, NOT a search. (The landing page `src/main.js` is stricter
    // and would send this to search; the two paths genuinely differ.)
    // Pinning the URL-bar semantics here so a future "cleanup" doesn't
    // silently change what the strip does.
    assert.equal(normalizeUrlInput('ftp://example.com'), 'https://ftp//example.com');
});

test('normalizeUrlInput trims whitespace', () => {
    assert.equal(normalizeUrlInput('  example.com  '), 'https://example.com/');
});

test('normalizeUrlInput rejects empty input', () => {
    assert.equal(normalizeUrlInput(''), null);
    assert.equal(normalizeUrlInput('   '), null);
});
