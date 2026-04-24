/* ==========================================================================
 * FloatView control strip — injected into every page by Tauri's
 * `initialization_script`. Runs inside a closed Shadow DOM so the strip can't
 * leak styles or event listeners to the host page, and the host page cannot
 * reach into ours.
 *
 * Table of contents (all in one IIFE so the host page sees no globals):
 *
 *   1. Constants & utilities
 *   2. Media-element interaction tracking (for global hotkeys)
 *   3. Shadow DOM container + stylesheet
 *   4. Control strip markup & icons
 *   5. Popups (snap, recent, bookmarks, context menu)
 *   6. Settings modal + tutorial modal
 *   7. Element queries (btn-*, url-input, opacity-slider)
 *   8. Auto-refresh timer
 *   9. Crop / zoom selection + apply
 *  10. Show/hide strip animation
 *  11. Tauri `invoke` wrapper (holds closure-scoped COMMAND_TOKEN)
 *  12. Button handlers (pin, bookmark, navigation, opacity, settings, etc.)
 *  13. URL tracking + recent dropdown
 *  14. Bookmark dropdown
 *  15. Window title observer
 *  16. Error-page detection + auto-recovery
 *  17. Config init + `__floatViewUpdate` Rust->JS callback
 *  18. Tauri event listener setup (with retry for external pages)
 *  19. Container re-prepend observer (survives SPA DOM wipes)
 *  20. DOM-ready init polling
 * ========================================================================== */
(function() {
    'use strict';

    if (window.__floatViewInitialized) return;
    window.__floatViewInitialized = true;

    // --------------------------------------------------------------------
    // [0] Trusted Types / innerHTML safety
    //
    // Some hosts (YouTube, GitHub, many Google properties) ship
    // `Content-Security-Policy: require-trusted-types-for 'script'`,
    // which blocks every `element.innerHTML = stringValue` assignment
    // with a TypeError. Our IIFE used to throw on its very first
    // `strip.innerHTML = …` and die, leaving the user with no strip,
    // no hotzone, no event listeners, no recovery affordances.
    //
    // Two-tier strategy:
    // 1. Try to register a named Trusted Types policy. Works on sites
    //    with permissive `trusted-types` directives.
    // 2. Fall back to DOMParser, whose output document is not subject
    //    to the current document's CSP — so its innerHTML is honored
    //    and we can graft the parsed nodes in via replaceChildren.
    // --------------------------------------------------------------------
    let _ttPolicy = null;
    if (typeof window.trustedTypes !== 'undefined' && window.trustedTypes.createPolicy) {
        try {
            _ttPolicy = window.trustedTypes.createPolicy('floatview', {
                createHTML: (s) => s,
                createScript: (s) => s,
                createScriptURL: (s) => s,
            });
        } catch (_) {
            // Named-policy creation rejected by CSP — DOMParser fallback
            // will handle it.
        }
    }

    function setInner(el, html) {
        if (_ttPolicy) {
            el.innerHTML = _ttPolicy.createHTML(html);
            return;
        }
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString('<!DOCTYPE html><body>' + html, 'text/html');
            el.replaceChildren(...doc.body.childNodes);
        } catch (e) {
            console.warn('FloatView: setInner fallback failed', e);
        }
    }

    // --------------------------------------------------------------------
    // [1] Constants & utilities
    // --------------------------------------------------------------------

    const DRAG_BAR_HEIGHT = 10;
    const HOTZONE_HEIGHT = 32;
    const STRIP_HEIGHT = 48;
    const DWELL_DELAY = 100;
    const HIDE_DELAY = 300;
    const IS_MAC = navigator.platform.includes('Mac');
    const COMMAND_TOKEN = '__FLOATVIEW_COMMAND_TOKEN__';
    // Emitted as a full JS string literal by the Rust side via serde_json,
    // so the placeholder must NOT be wrapped in quotes here.
    const EMBEDDED_HOME_URL = "__FLOATVIEW_HOME_URL__";

    function formatKey(shortcut) {
        if (!IS_MAC) return shortcut;
        return shortcut
            .replace(/Ctrl\+/g, '⌘')
            .replace(/Alt\+/g, '⌥')
            .replace(/Shift\+/g, '⇧');
    }

    let stripVisible = false;
    let dwellTimer = null;
    let hideTimer = null;
    let config = null;

    // --------------------------------------------------------------------
    // [2] Media-element interaction tracking
    // --------------------------------------------------------------------

    // Track most recently interacted media element for global hotkeys.
    // Script runs at document_created so document.body may not exist yet —
    // defer the observer until DOM is ready.
    window.__floatViewLastMedia = null;
    (function trackMediaInteractions() {
        const updateLast = (e) => { window.__floatViewLastMedia = e.target; };
        const attach = (m) => {
            if (!m.dataset.floatviewTracked) {
                m.dataset.floatviewTracked = '1';
                m.addEventListener('play', updateLast, { passive: true });
                m.addEventListener('pause', updateLast, { passive: true });
                m.addEventListener('volumechange', updateLast, { passive: true });
                m.addEventListener('click', updateLast, { passive: true });
            }
        };
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((m) => {
                m.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) {
                        if (node.matches && (node.matches('video') || node.matches('audio'))) attach(node);
                        if (node.querySelectorAll) node.querySelectorAll('video, audio').forEach(attach);
                    }
                });
            });
        });
        const start = () => {
            document.querySelectorAll('video, audio').forEach(attach);
            const root = document.documentElement || document.body;
            if (root) observer.observe(root, { childList: true, subtree: true });
        };
        if (document.body) {
            start();
        } else if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start, { once: true });
        } else {
            // documentElement exists even pre-body; observe it immediately so we
            // catch the <body> insertion and any media added before DOMContentLoaded.
            start();
        }
    })();

    // --------------------------------------------------------------------
    // [3] Shadow DOM container + stylesheet
    // --------------------------------------------------------------------

    const container = document.createElement('div');
    container.id = 'floatview-root';
    container.style.cssText = 'position:fixed;top:0;left:0;right:0;height:0;z-index:2147483647;pointer-events:none;';

    const shadow = container.attachShadow({ mode: 'closed' });

    // Page-side stylesheet: fades the page's own body children (but not
    // our shadow-DOM container) via a CSS custom property on :root. Pairs
    // with the Win32 / macOS window-alpha floor in opacity.rs so the
    // toolbar stays readable even when the slider is near the bottom.
    // Substituted at init-script build time from
    // `crate::opacity::WINDOW_ALPHA_FLOOR` so Rust stays the sole source
    // of truth; parseFloat keeps the template valid JS pre-substitution.
    const WINDOW_ALPHA_FLOOR = parseFloat("__FLOATVIEW_ALPHA_FLOOR__");
    (function injectContentOpacityStyle() {
        const fvStyle = document.createElement('style');
        fvStyle.id = 'floatview-content-opacity';
        fvStyle.textContent =
            'body > *:not(#floatview-root) { opacity: var(--fv-content-opacity, 1) !important; }';
        const attach = () => {
            const parent = document.head || document.documentElement;
            if (parent && !document.getElementById('floatview-content-opacity')) {
                parent.appendChild(fvStyle);
            }
        };
        attach();
        // `<head>` may not exist yet at document_created; try again when
        // the DOM is further along.
        if (!document.head) {
            document.addEventListener('DOMContentLoaded', attach, { once: true });
        }
    })();

    // Compute the CSS opacity we apply to page content so the *combined*
    // visibility (window alpha * content CSS opacity) matches the raw
    // slider value. With the floor at 0.55, raw=0.1 -> window 0.595,
    // content_css 0.168, final 0.1 (toolbar stays at 0.595).
    function computeContentOpacity(raw) {
        const r = Math.max(0, Math.min(1, raw));
        const windowAlpha = WINDOW_ALPHA_FLOOR + (1 - WINDOW_ALPHA_FLOOR) * r;
        if (windowAlpha <= 0) return 0;
        return Math.min(1, r / windowAlpha);
    }

    function applyContentOpacity(raw) {
        const css = computeContentOpacity(raw);
        document.documentElement.style.setProperty('--fv-content-opacity', css.toString());
    }

    const style = document.createElement('style');
    style.textContent = `
        :host, :root {
            /* Crafted easing curves. swift = brisk hover; spring = playful
               snap with overshoot; out = smooth-into-place. */
            --fv-swift: cubic-bezier(0.4, 0, 0.2, 1);
            --fv-out:   cubic-bezier(0.22, 0.9, 0.36, 1.05);
            --fv-spring: cubic-bezier(0.34, 1.4, 0.64, 1);
            --fv-press: cubic-bezier(0.4, 0, 0.6, 1);

            --fv-accent:        rgba(200, 140, 80, 1);
            --fv-accent-glow:   rgba(220, 170, 110, 0.55);
            --fv-accent-soft:   rgba(200, 140, 80, 0.18);
            --fv-accent-fill:   rgba(200, 140, 80, 0.4);
            --fv-accent-text:   #e8b87a;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        .drag-bar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: ${DRAG_BAR_HEIGHT}px;
            background: linear-gradient(to bottom, rgba(80, 80, 84, 0.5), transparent);
            pointer-events: auto;
            z-index: 2147483647;
            cursor: grab;
            -webkit-app-region: drag;
        }

        .drag-bar:active {
            cursor: grabbing;
        }

        .hotzone {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            height: ${HOTZONE_HEIGHT}px;
            pointer-events: auto;
            z-index: 2147483646;
            -webkit-app-region: drag;
            cursor: grab;
        }

        .strip {
            position: fixed;
            top: ${DRAG_BAR_HEIGHT}px;
            left: 20px;
            right: 20px;
            height: ${STRIP_HEIGHT}px;
            background: linear-gradient(135deg, rgba(46, 46, 52, 0.62), rgba(36, 36, 42, 0.52));
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            display: flex;
            align-items: center;
            padding: 0 12px;
            gap: 6px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            color: #fff;
            transform: translateY(-${STRIP_HEIGHT + DRAG_BAR_HEIGHT + 20}px) scale(0.96);
            transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.15s ease-out;
            opacity: 0;
            pointer-events: auto;
            user-select: none;
            -webkit-app-region: no-drag;
            border: none;
            border-radius: 12px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.15), 0 2px 4px rgba(0,0,0,0.1);
            z-index: 2147483647;
        }

        .strip.visible {
            transform: translateY(0) scale(1);
            opacity: 1;
            transition: transform 0.3s cubic-bezier(0.22, 0.9, 0.36, 1.12), opacity 0.2s ease-out;
        }

        .btn {
            -webkit-app-region: no-drag;
            background: transparent;
            border: none;
            color: #ccc;
            min-width: 36px;
            height: 36px;
            padding: 0;
            border-radius: 10px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            line-height: 0;
            transition:
                background 0.18s var(--fv-swift),
                color 0.18s var(--fv-swift),
                transform 0.18s var(--fv-out),
                box-shadow 0.22s var(--fv-out);
        }

        .btn svg {
            width: 16px;
            height: 16px;
            stroke: currentColor;
            fill: none;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
            transition: transform 0.2s var(--fv-spring);
        }

        .btn:hover {
            background: rgba(255,255,255,0.1);
            color: #fff;
            transform: translateY(-1px);
        }

        .btn:hover svg {
            transform: scale(1.06);
        }

        .btn:active {
            background: rgba(255,255,255,0.18);
            transform: translateY(0) scale(0.92);
            transition:
                background 0.06s var(--fv-press),
                transform 0.06s var(--fv-press);
        }

        .btn:active svg {
            transform: scale(0.94);
            transition: transform 0.06s var(--fv-press);
        }

        .btn.active {
            background:
                linear-gradient(135deg, rgba(200, 140, 80, 0.42), rgba(220, 170, 110, 0.34));
            color: var(--fv-accent-text);
            box-shadow:
                inset 0 0 0 1px rgba(220, 170, 110, 0.18),
                0 0 14px -4px var(--fv-accent-glow);
        }

        .btn.active:hover {
            background:
                linear-gradient(135deg, rgba(210, 150, 90, 0.5), rgba(230, 180, 120, 0.42));
            box-shadow:
                inset 0 0 0 1px rgba(220, 170, 110, 0.28),
                0 0 18px -3px var(--fv-accent-glow);
        }

        /* Brief visual "nope" for feature buttons that couldn't act
           (e.g. zoom-to-video with no detectable video). */
        .btn.zoom-not-found {
            background: rgba(244, 67, 54, 0.35);
            color: #fff;
            transition: background 0.15s ease-out, color 0.15s ease-out;
        }

        /* Refresh-on-click spin. Triggered by JS — page navigation
           starts immediately, so the animation is mostly visual
           confirmation in the brief window before reload kicks in. */
        @keyframes fv-spin-once {
            to { transform: rotate(360deg); }
        }
        .btn.spinning svg {
            animation: fv-spin-once 0.5s var(--fv-out);
            transform-origin: 50% 50%;
        }

        /* Bookmark star pop on toggle. */
        @keyframes fv-pop {
            0%   { transform: scale(1); }
            40%  { transform: scale(1.35); }
            100% { transform: scale(1); }
        }
        .btn.popping svg {
            animation: fv-pop 0.34s var(--fv-spring);
        }

        .url-display {
            -webkit-app-region: no-drag;
            flex: 1;
            min-width: 0;
            height: 36px;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.1);
            color: #fff;
            padding: 0 14px;
            border-radius: 10px;
            font-size: 13px;
            font-family: inherit;
            line-height: 36px;
            outline: none;
            transition:
                background 0.18s var(--fv-swift),
                border-color 0.2s var(--fv-out),
                box-shadow 0.24s var(--fv-out);
        }

        .url-display:hover:not(:focus) {
            background: rgba(255,255,255,0.10);
            border-color: rgba(255,255,255,0.16);
        }

        .url-display:focus {
            background: rgba(255,255,255,0.14);
            border-color: rgba(220, 170, 110, 0.55);
            box-shadow: 0 0 0 3px rgba(200, 140, 80, 0.14);
        }

        .url-display::placeholder {
            color: rgba(255,255,255,0.4);
        }

        .opacity-slider {
            -webkit-app-region: no-drag;
            width: 120px;
            height: 36px;
            padding: 0 4px;
            -webkit-appearance: none;
            background: transparent;
            outline: none;
        }

        .opacity-slider::-webkit-slider-runnable-track {
            height: 3px;
            background: rgba(255,255,255,0.15);
            border-radius: 1.5px;
        }

        .opacity-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 16px;
            height: 16px;
            background: #fff;
            border-radius: 50%;
            cursor: pointer;
            margin-top: -6.5px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            transition:
                box-shadow 0.2s var(--fv-out),
                transform 0.18s var(--fv-spring);
        }

        .opacity-slider:hover::-webkit-slider-thumb {
            transform: scale(1.12);
            box-shadow: 0 2px 6px rgba(0,0,0,0.28), 0 0 0 4px rgba(200, 140, 80, 0.18);
        }

        .opacity-slider:active::-webkit-slider-thumb {
            transform: scale(1.18);
            box-shadow: 0 2px 8px rgba(0,0,0,0.35), 0 0 0 5px rgba(200, 140, 80, 0.28);
        }

        .divider {
            width: 1px;
            height: 28px;
            background: rgba(255,255,255,0.15);
            margin: 0 4px;
        }

        .recent-dropdown {
            position: fixed;
            top: 0;
            left: 0;
            background: linear-gradient(160deg, rgba(46, 46, 52, 0.78), rgba(36, 36, 42, 0.72));
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: none;
            border-radius: 12px;
            min-width: 240px;
            max-width: min(360px, calc(100vw - 60px));
            max-height: 280px;
            overflow-y: auto;
            opacity: 0;
            transform: translateY(-4px) scale(0.97);
            pointer-events: none;
            transition: opacity 0.18s ease-out, transform 0.18s ease-out;
            box-shadow: 0 10px 30px rgba(0,0,0,0.15), 0 2px 6px rgba(0,0,0,0.1);
        }

        .recent-dropdown.visible {
            opacity: 1;
            transform: translateY(0) scale(1);
            pointer-events: auto;
        }

        .recent-item {
            padding: 12px 16px;
            font-size: 13px;
            color: #fff;
            cursor: pointer;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            border-bottom: 1px solid rgba(255,255,255,0.05);
            position: relative;
            transition:
                background 0.16s var(--fv-swift),
                padding-left 0.18s var(--fv-out),
                color 0.16s var(--fv-swift);
        }

        .recent-item::before {
            content: '';
            position: absolute;
            left: 0;
            top: 6px;
            bottom: 6px;
            width: 3px;
            background: var(--fv-accent);
            border-radius: 0 2px 2px 0;
            opacity: 0;
            transform: scaleY(0.4);
            transition:
                opacity 0.18s var(--fv-out),
                transform 0.22s var(--fv-spring);
        }

        .recent-item:last-child {
            border-bottom: none;
        }

        .recent-item:hover {
            background: rgba(200, 140, 80, 0.12);
            padding-left: 22px;
            color: #fff;
        }

        .recent-item:hover::before {
            opacity: 1;
            transform: scaleY(1);
        }

        .recent-item.current {
            color: rgba(255,255,255,0.5);
        }

        .recent-empty {
            padding: 16px;
            font-size: 13px;
            color: rgba(255,255,255,0.4);
            text-align: center;
        }

        .settings-modal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, calc(-50% + 6px)) scale(0.95);
            background: linear-gradient(160deg, rgba(46, 46, 52, 0.78), rgba(36, 36, 42, 0.68));
            backdrop-filter: blur(28px);
            -webkit-backdrop-filter: blur(28px);
            border: none;
            border-radius: 16px;
            padding: 0;
            min-width: 360px;
            max-width: 440px;
            max-height: 80vh;
            overflow: visible;
            box-shadow: 0 20px 60px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.1);
            z-index: 2147483647;
            pointer-events: none;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #fff;
            opacity: 0;
            transition:
                opacity 0.22s var(--fv-out),
                transform 0.32s var(--fv-spring);
        }

        .settings-modal.visible {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
            pointer-events: auto;
        }

        .settings-modal.hidden {
            opacity: 0;
            transform: translate(-50%, calc(-50% + 6px)) scale(0.95);
        }

        .settings-scroll {
            max-height: 80vh;
            overflow-y: auto;
            padding: 24px 10px 24px 24px;
        }

        .settings-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 20px;
            padding-bottom: 16px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }

        .settings-close-btn {
            position: absolute;
            top: 0;
            right: -48px;
            background: rgba(60, 60, 66, 0.95);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: none;
            color: rgba(255,255,255,0.7);
            width: 36px;
            height: 36px;
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            transition: all 0.15s ease;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 1;
        }

        .settings-close-btn svg {
            width: 16px;
            height: 16px;
            stroke: currentColor;
            fill: none;
            stroke-width: 2.5;
            stroke-linecap: round;
            stroke-linejoin: round;
        }

        .settings-close-btn:hover {
            background: rgba(220, 60, 50, 0.9);
            color: #fff;
            transform: rotate(90deg) scale(1.06);
            box-shadow: 0 4px 16px rgba(220, 60, 50, 0.4);
        }

        .settings-close-btn:active {
            transform: rotate(90deg) scale(0.94);
        }

        .settings-section {
            margin-bottom: 20px;
        }

        .settings-section-title {
            font-size: 11px;
            font-weight: 600;
            color: rgba(255,255,255,0.5);
            text-transform: uppercase;
            letter-spacing: 0.8px;
            margin-bottom: 12px;
        }

        .settings-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 0;
            min-height: 44px;
        }

        .settings-label {
            font-size: 14px;
            color: #fff;
        }

        .settings-value {
            font-size: 13px;
            color: rgba(255,255,255,0.5);
            font-family: 'SF Mono', Monaco, monospace;
        }

        .hotkey-btn {
            font-size: 12px;
            color: rgba(255,255,255,0.7);
            font-family: 'SF Mono', Monaco, monospace;
            background: rgba(255,255,255,0.06);
            border: 1px solid transparent;
            padding: 5px 10px;
            border-radius: 6px;
            cursor: pointer;
            min-width: 130px;
            text-align: center;
            transition:
                background 0.16s var(--fv-swift),
                color 0.16s var(--fv-swift),
                border-color 0.18s var(--fv-out),
                transform 0.16s var(--fv-out),
                box-shadow 0.22s var(--fv-out);
        }

        .hotkey-btn:hover {
            background: rgba(255,255,255,0.14);
            color: #fff;
            transform: translateY(-1px);
            box-shadow: 0 3px 10px rgba(0,0,0,0.18);
        }

        .hotkey-btn:active {
            transform: translateY(0) scale(0.97);
        }

        .hotkey-btn.capturing {
            background: rgba(200, 140, 80, 0.18);
            border-color: rgba(200, 140, 80, 0.7);
            color: #fff;
            animation: hotkey-pulse 1.2s ease-in-out infinite;
        }

        @keyframes hotkey-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(200, 140, 80, 0.0); }
            50%      { box-shadow: 0 0 0 3px rgba(200, 140, 80, 0.18); }
        }

        .hotkey-controls {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .hotkey-reset-btn {
            background: transparent;
            border: none;
            padding: 4px;
            cursor: pointer;
            color: rgba(255,255,255,0.4);
            opacity: 0.6;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.12s;
        }

        .hotkey-reset-btn:hover {
            background: rgba(255,255,255,0.08);
            color: #fff;
            opacity: 1;
        }

        .hotkey-reset-btn svg {
            width: 14px;
            height: 14px;
            stroke: currentColor;
            stroke-width: 2;
            fill: none;
            stroke-linecap: round;
            stroke-linejoin: round;
        }

        .hotkey-reset-btn.appearing {
            animation: hotkey-reset-appear 0.36s var(--fv-spring);
        }

        @keyframes hotkey-reset-appear {
            0%   { opacity: 0; transform: translateX(8px) scale(0.6); }
            60%  { opacity: 1; transform: translateX(-1px) scale(1.08); }
            100% { opacity: 0.6; transform: translateX(0) scale(1); }
        }

        .toggle-switch {
            position: relative;
            width: 50px;
            height: 28px;
            background: rgba(255,255,255,0.14);
            border-radius: 14px;
            cursor: pointer;
            transition:
                background 0.28s var(--fv-out),
                box-shadow 0.28s var(--fv-out);
        }

        .toggle-switch:hover {
            background: rgba(255,255,255,0.18);
        }

        .toggle-switch.active {
            background: linear-gradient(135deg, rgba(200, 140, 80, 0.88), rgba(220, 170, 110, 0.95));
            box-shadow: 0 0 16px -3px var(--fv-accent-glow);
        }

        .toggle-switch.active:hover {
            box-shadow: 0 0 20px -2px var(--fv-accent-glow);
        }

        .toggle-switch::after {
            content: '';
            position: absolute;
            top: 3px;
            left: 3px;
            width: 22px;
            height: 22px;
            background: #fff;
            border-radius: 50%;
            transition: transform 0.32s var(--fv-spring), box-shadow 0.28s var(--fv-out);
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }

        .toggle-switch.active::after {
            transform: translateX(22px);
            box-shadow: 0 2px 6px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.4);
        }

        .toggle-switch:active::after {
            transform: scale(0.92);
        }
        .toggle-switch.active:active::after {
            transform: translateX(22px) scale(0.92);
        }

        .settings-slider-row {
            padding: 10px 0;
        }

        .settings-slider-row .settings-label {
            margin-bottom: 10px;
        }

        .settings-slider {
            width: 100%;
            height: 4px;
            -webkit-appearance: none;
            background: rgba(255,255,255,0.15);
            border-radius: 2px;
            outline: none;
        }

        .settings-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 18px;
            height: 18px;
            background: #fff;
            border-radius: 50%;
            cursor: pointer;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }

        .settings-btn {
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.12);
            color: #fff;
            padding: 10px 20px;
            border-radius: 10px;
            font-size: 14px;
            font-family: inherit;
            cursor: pointer;
            transition:
                background 0.18s var(--fv-swift),
                border-color 0.18s var(--fv-swift),
                transform 0.16s var(--fv-out),
                box-shadow 0.22s var(--fv-out);
            min-height: 44px;
        }

        .settings-btn:hover {
            background: rgba(255,255,255,0.12);
            border-color: rgba(255,255,255,0.22);
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.16);
        }

        .settings-btn:active {
            transform: translateY(0) scale(0.97);
            transition:
                background 0.06s var(--fv-press),
                transform 0.06s var(--fv-press);
        }

        .settings-btn.danger {
            background: rgba(244, 67, 54, 0.2);
            border-color: rgba(244, 67, 54, 0.4);
        }

        .settings-btn.danger:hover {
            background: rgba(244, 67, 54, 0.38);
            border-color: rgba(244, 67, 54, 0.6);
            box-shadow: 0 4px 14px rgba(244, 67, 54, 0.22);
        }

        .settings-btn.primary {
            background: linear-gradient(135deg, rgba(200, 140, 80, 0.4), rgba(220, 170, 110, 0.32));
            border-color: rgba(200, 140, 80, 0.6);
            color: #fff;
        }

        .settings-btn.primary:hover {
            background: linear-gradient(135deg, rgba(210, 150, 90, 0.55), rgba(230, 180, 120, 0.45));
            border-color: rgba(220, 170, 110, 0.75);
            box-shadow: 0 4px 16px -2px var(--fv-accent-glow);
        }

        .settings-footer {
            margin-top: 20px;
            padding-top: 16px;
            border-top: 1px solid rgba(255,255,255,0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .context-menu {
            position: fixed;
            background: linear-gradient(160deg, rgba(46, 46, 52, 0.78), rgba(36, 36, 42, 0.68));
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: none;
            border-radius: 12px;
            min-width: 180px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.15), 0 2px 6px rgba(0,0,0,0.1);
            z-index: 2147483647;
            pointer-events: none;
            padding: 6px 0;
            opacity: 0;
            transform: scale(0.97);
            transition: opacity 0.15s ease-out, transform 0.15s ease-out;
        }

        .context-menu.visible {
            opacity: 1;
            transform: scale(1);
            pointer-events: auto;
        }

        .context-menu-item {
            padding: 12px 16px;
            font-size: 14px;
            color: #fff;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            transition:
                background 0.16s var(--fv-swift),
                padding-left 0.18s var(--fv-out),
                color 0.16s var(--fv-swift);
        }

        .context-menu-item svg {
            width: 18px;
            height: 18px;
            stroke: currentColor;
            fill: none;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
            opacity: 0.7;
            transition: opacity 0.16s var(--fv-swift), transform 0.2s var(--fv-spring);
        }

        .context-menu-item:hover {
            background: rgba(200, 140, 80, 0.14);
            padding-left: 22px;
        }

        .context-menu-item:hover svg {
            opacity: 1;
            transform: scale(1.06);
        }

        .context-menu-item.disabled {
            color: rgba(255,255,255,0.3);
            pointer-events: none;
        }

        .context-menu-divider {
            height: 1px;
            background: rgba(255,255,255,0.08);
            margin: 6px 0;
        }

        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.3);
            backdrop-filter: blur(0px);
            -webkit-backdrop-filter: blur(0px);
            z-index: 2147483646;
            pointer-events: none;
            opacity: 0;
            transition:
                opacity 0.28s var(--fv-out),
                backdrop-filter 0.32s var(--fv-out),
                -webkit-backdrop-filter 0.32s var(--fv-out);
        }

        .modal-overlay.visible {
            opacity: 1;
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            pointer-events: auto;
        }

        .hotkey-info {
            font-size: 12px;
            color: rgba(255,255,255,0.4);
            margin-top: 12px;
            line-height: 1.6;
        }

        .hotkey-info kbd {
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.08);
            padding: 3px 8px;
            border-radius: 5px;
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 11px;
            margin: 0 2px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.12);
        }

        .settings-version {
            font-size: 12px;
            color: rgba(255,255,255,0.3);
        }

        .update-section {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
        }

        .update-status {
            font-size: 13px;
            color: rgba(255,255,255,0.5);
        }

        .update-status.available {
            color: rgba(200, 140, 80, 0.9);
        }

        .update-status.error {
            color: rgba(244, 67, 54, 0.8);
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .update-spinner {
            display: inline-block;
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255,255,255,0.2);
            border-top-color: rgba(255,255,255,0.6);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            vertical-align: middle;
            margin-right: 6px;
        }

        .tutorial-modal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, calc(-50% + 6px)) scale(0.95);
            background: linear-gradient(160deg, rgba(46, 46, 52, 0.78), rgba(36, 36, 42, 0.68));
            backdrop-filter: blur(28px);
            -webkit-backdrop-filter: blur(28px);
            border: none;
            border-radius: 16px;
            padding: 32px;
            width: 480px;
            max-width: 90vw;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 20px 60px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.1);
            z-index: 2147483647;
            pointer-events: none;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #fff;
            opacity: 0;
            transition:
                opacity 0.22s var(--fv-out),
                transform 0.32s var(--fv-spring);
        }

        .tutorial-modal.visible {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
            pointer-events: auto;
        }

        .tutorial-modal.hidden {
            opacity: 0;
            transform: translate(-50%, calc(-50% + 6px)) scale(0.95);
        }

        .tutorial-step {
            display: none;
        }

        .tutorial-step.active {
            display: block;
        }

        .tutorial-step h2 {
            font-size: 20px;
            font-weight: 600;
            margin-bottom: 16px;
        }

        .tutorial-step p {
            font-size: 14px;
            line-height: 1.6;
            color: rgba(255,255,255,0.8);
            margin-bottom: 12px;
        }

        .tutorial-diagram {
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 16px;
            margin: 16px 0;
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 12px;
            color: rgba(255,255,255,0.7);
            text-align: center;
            line-height: 1.8;
            overflow-x: auto;
        }

        .tutorial-shortcut-table {
            width: 100%;
            margin: 12px 0;
            border-collapse: collapse;
        }

        .tutorial-shortcut-table td {
            padding: 8px 12px;
            font-size: 13px;
            border-bottom: 1px solid rgba(255,255,255,0.06);
        }

        .tutorial-shortcut-table td:first-child {
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 12px;
            color: rgba(255,255,255,0.6);
            white-space: nowrap;
            width: 45%;
        }

        .tutorial-shortcut-table td:last-child {
            color: rgba(255,255,255,0.8);
        }

        .tutorial-nav {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-top: 24px;
            padding-top: 16px;
            border-top: 1px solid rgba(255,255,255,0.1);
        }

        .tutorial-nav-buttons {
            display: flex;
            gap: 10px;
        }

        .tutorial-btn {
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.12);
            color: #fff;
            padding: 10px 20px;
            border-radius: 10px;
            font-size: 14px;
            font-family: inherit;
            cursor: pointer;
            transition: all 0.15s ease;
            min-height: 40px;
        }

        .tutorial-btn:hover {
            background: rgba(255,255,255,0.12);
            border-color: rgba(255,255,255,0.2);
        }

        .tutorial-btn.primary {
            background: rgba(200, 140, 80, 0.5);
            border-color: rgba(200, 140, 80, 0.7);
        }

        .tutorial-btn.primary:hover {
            background: rgba(200, 140, 80, 0.7);
        }

        .tutorial-skip {
            background: none;
            border: none;
            color: rgba(255,255,255,0.4);
            font-size: 13px;
            font-family: inherit;
            cursor: pointer;
            padding: 8px 4px;
            transition: color 0.1s;
        }

        .tutorial-skip:hover {
            color: rgba(255,255,255,0.7);
        }

        .tutorial-dots {
            display: flex;
            gap: 8px;
            justify-content: center;
            margin-top: 20px;
        }

        .tutorial-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: rgba(255,255,255,0.2);
            transition:
                background 0.28s var(--fv-out),
                box-shadow 0.32s var(--fv-out),
                width 0.28s var(--fv-spring);
        }

        .tutorial-dot.active {
            background: var(--fv-accent);
            width: 22px;
            border-radius: 4px;
            box-shadow: 0 0 12px -2px var(--fv-accent-glow);
        }

        .snap-popup {
            position: fixed;
            top: 0;
            left: 0;
            background: linear-gradient(160deg, rgba(46, 46, 52, 0.88), rgba(36, 36, 42, 0.82));
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: none;
            border-radius: 12px;
            padding: 8px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.15), 0 2px 6px rgba(0,0,0,0.1);
            z-index: 2147483647;
            pointer-events: none;
            opacity: 0;
            transform: translateY(-4px) scale(0.97);
            transition: opacity 0.18s ease-out, transform 0.18s ease-out;
            display: flex;
            flex-direction: column;
            gap: 6px;
            min-width: 156px;
        }

        .snap-popup.visible {
            opacity: 1;
            transform: translateY(0) scale(1);
            pointer-events: auto;
        }

        .snap-section {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .snap-section + .snap-section {
            border-top: 1px solid rgba(255,255,255,0.06);
            padding-top: 6px;
        }

        .snap-section-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: rgba(255,255,255,0.45);
            padding: 0 4px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .snap-grid {
            display: grid;
            gap: 4px;
        }

        .snap-grid.pos-grid {
            grid-template-columns: repeat(3, 36px);
            grid-template-rows: repeat(2, 28px);
        }

        .snap-grid.half-grid {
            grid-template-columns: repeat(4, 36px);
            grid-template-rows: 28px;
        }

        .snap-grid.third-grid {
            grid-template-columns: repeat(3, 36px);
            grid-template-rows: 28px;
        }

        .snap-grid.aspect-grid {
            grid-template-columns: repeat(3, 1fr);
            grid-auto-rows: 24px;
        }

        .snap-cell {
            background: rgba(255,255,255,0.06);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            color: rgba(255,255,255,0.55);
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            transition:
                background 0.16s var(--fv-swift),
                color 0.16s var(--fv-swift),
                transform 0.18s var(--fv-spring),
                box-shadow 0.18s var(--fv-out);
        }

        .snap-cell:hover {
            background: rgba(200, 140, 80, 0.3);
            color: #fff;
            transform: scale(1.06);
            box-shadow: 0 2px 8px -2px rgba(200, 140, 80, 0.45);
        }

        .snap-cell:active {
            transform: scale(0.94);
            transition:
                background 0.06s var(--fv-press),
                transform 0.06s var(--fv-press);
        }

        .snap-cell.aspect-cell {
            font-size: 11px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-weight: 500;
            letter-spacing: 0.02em;
        }

        /* Stagger sub-section reveal when snap popup opens. The section
           starts slightly offset and fades up; ordering by section gives
           a satisfying cascade without feeling slow. */
        @keyframes fv-section-rise {
            from { opacity: 0; transform: translateY(4px); }
            to   { opacity: 1; transform: translateY(0); }
        }

        .snap-popup.visible .snap-section {
            animation: fv-section-rise 0.28s var(--fv-out) both;
        }
        .snap-popup.visible .snap-section:nth-child(1) { animation-delay: 0.00s; }
        .snap-popup.visible .snap-section:nth-child(2) { animation-delay: 0.04s; }
        .snap-popup.visible .snap-section:nth-child(3) { animation-delay: 0.08s; }
        .snap-popup.visible .snap-section:nth-child(4) { animation-delay: 0.12s; }

        .crop-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 2147483646;
            cursor: crosshair;
            pointer-events: auto;
            background: rgba(0,0,0,0.3);
        }

        .crop-selection {
            position: absolute;
            border: 2px dashed rgba(200, 140, 80, 0.9);
            background: rgba(200, 140, 80, 0.08);
            pointer-events: none;
            border-radius: 4px;
        }

        .crop-instructions {
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(36, 36, 42, 0.9);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            color: rgba(255,255,255,0.8);
            padding: 10px 20px;
            border-radius: 10px;
            font-size: 13px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            pointer-events: none;
            white-space: nowrap;
        }

        .settings-select {
            -webkit-app-region: no-drag;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.1);
            color: #fff;
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 13px;
            font-family: inherit;
            outline: none;
            cursor: pointer;
        }

        .settings-select option {
            background: #2e2e34;
            color: #fff;
        }

        .volume-popup {
            position: fixed;
            top: 0;
            left: 0;
            background: linear-gradient(160deg, rgba(46, 46, 52, 0.92), rgba(36, 36, 42, 0.86));
            backdrop-filter: blur(28px) saturate(1.15);
            -webkit-backdrop-filter: blur(28px) saturate(1.15);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 14px;
            padding: 12px 8px 8px 8px;
            box-shadow: 0 12px 32px rgba(0,0,0,0.3), 0 2px 6px rgba(0,0,0,0.15);
            z-index: 2147483647;
            pointer-events: none;
            opacity: 0;
            transform-origin: top center;
            /* Start as a tiny point at the icon's position; grow out from
               there. Near-zero scale + a small upward nudge so the first
               frame visually lives inside the mute button. */
            transform: scale(0.08) translateY(-10px);
            transition:
                opacity 0.16s ease-out,
                transform 0.32s cubic-bezier(0.16, 1, 0.3, 1);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            will-change: transform, opacity;
        }

        .volume-popup.visible {
            opacity: 1;
            transform: scale(1) translateY(0);
            pointer-events: auto;
        }

        /* Tiny "pointer" joining the popup to the mute button so it
           reads as one continuous element rather than a floating panel.
           Solid color (not backdrop-filtered) so it matches the popup's
           top edge without a rendering seam. pointer-events:none so it
           never intercepts clicks aimed at the mute button above. */
        .volume-popup::before {
            content: '';
            position: absolute;
            top: -5px;
            left: 50%;
            width: 10px;
            height: 10px;
            margin-left: -5px;
            background: rgba(46, 46, 52, 0.92);
            border-top: 1px solid rgba(255,255,255,0.08);
            border-left: 1px solid rgba(255,255,255,0.08);
            transform: rotate(45deg);
            border-top-left-radius: 2px;
            pointer-events: none;
        }

        /* Highlight the toolbar mute button while the popup is open,
           so the two read as a single expanded control. */
        .btn.dropdown-open {
            background: rgba(255,255,255,0.12);
            color: #fff;
        }

        .volume-slider {
            -webkit-app-region: no-drag;
            position: relative;
            width: 28px;
            height: 140px;
            padding: 7px 0;
            cursor: grab;
            touch-action: none;
            outline: none;
        }

        .volume-slider:focus-visible .volume-slider-track {
            box-shadow: 0 0 0 2px rgba(200, 140, 80, 0.45);
        }

        .volume-slider.dragging { cursor: grabbing; }
        /* .inactive dims the slider when the page has no media, but
           keeps it interactive — dragging still updates its visual so
           the control never feels broken. */
        .volume-slider.inactive { opacity: 0.45; }

        .volume-slider-track {
            position: absolute;
            left: 50%;
            top: 7px;
            bottom: 7px;
            width: 4px;
            margin-left: -2px;
            background: rgba(255,255,255,0.14);
            border-radius: 2px;
            overflow: hidden;
        }

        .volume-slider-fill {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: var(--vol-pct, 100%);
            background: linear-gradient(to top,
                rgba(200, 140, 80, 0.95),
                rgba(220, 170, 110, 0.8));
            border-radius: 2px;
        }

        .volume-slider-fill,
        .volume-slider-thumb {
            transition:
                bottom 0.09s cubic-bezier(0.22, 1, 0.36, 1),
                height 0.09s cubic-bezier(0.22, 1, 0.36, 1);
        }

        .volume-slider.dragging .volume-slider-fill,
        .volume-slider.dragging .volume-slider-thumb {
            transition: none;
        }

        .volume-slider-thumb {
            position: absolute;
            left: 50%;
            bottom: var(--vol-pct, 100%);
            width: 14px;
            height: 14px;
            margin-left: -7px;
            margin-bottom: -7px;
            background: #fff;
            border-radius: 50%;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.04);
            pointer-events: none;
        }

        .volume-slider.dragging .volume-slider-thumb {
            box-shadow: 0 3px 10px rgba(0,0,0,0.35), 0 0 0 3px rgba(200, 140, 80, 0.25);
            transform: none;
        }
    `;
    shadow.appendChild(style);

    // --------------------------------------------------------------------
    // [4] Control strip markup & icons
    // --------------------------------------------------------------------

    // Persistent drag bar at top
    const dragBar = document.createElement('div');
    dragBar.className = 'drag-bar';
    shadow.appendChild(dragBar);

    const hotzone = document.createElement('div');
    hotzone.className = 'hotzone';
    shadow.appendChild(hotzone);

    // SVG icons
    const icons = {
        pin: `<svg viewBox="0 0 24 24"><path d="M9 3v6l-2 4v2h4v4l1 1 1-1v-4h4v-2l-2-4V3"/><line x1="8" y1="3" x2="16" y2="3"/></svg>`,
        pinActive: `<svg viewBox="0 0 24 24"><path d="M9 3v6l-2 4v2h4v4l1 1 1-1v-4h4v-2l-2-4V3" fill="currentColor"/><line x1="8" y1="3" x2="16" y2="3"/></svg>`,
        recent: `<svg viewBox="0 0 24 24"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>`,
        lock: `<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
        lockActive: `<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" fill="currentColor"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
        settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
        minimize: `<svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
        close: `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        home: `<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
        snap: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
        refresh: `<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>`,
        crop: `<svg viewBox="0 0 24 24"><path d="M6.13 1L6 16a2 2 0 002 2h15"/><path d="M1 6.13L16 6a2 2 0 012 2v15"/></svg>`,
        back: `<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>`,
        forward: `<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>`,
        bookmark: `<svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>`,
        bookmarkActive: `<svg viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" fill="currentColor"/></svg>`,
        volume: `<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/></svg>`,
        volumeMuted: `<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
        zoomVideo: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="8 9 8 12 11 12"/><polyline points="16 15 16 12 13 12"/></svg>`,
        zoomVideoActive: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="currentColor" fill-opacity="0.25"/><polyline points="8 9 8 12 11 12"/><polyline points="16 15 16 12 13 12"/></svg>`,
    };

    const strip = document.createElement('div');
    strip.className = 'strip';
    setInner(strip, `
        <button class="btn" id="btn-back" title="Go Back">${icons.back}</button>
        <button class="btn" id="btn-forward" title="Go Forward">${icons.forward}</button>
        <button class="btn" id="btn-refresh" title="Refresh Page">${icons.refresh}</button>
        <button class="btn" id="btn-pin" title="Always on Top (${formatKey('Alt+Shift+T')})">${icons.pin}</button>
        <button class="btn" id="btn-recent" title="Recent URLs">${icons.recent}</button>
        <button class="btn" id="btn-home" title="Go Home">${icons.home}</button>
        <input type="text" class="url-display" id="url-input" placeholder="Enter URL or search...">
        <button class="btn" id="btn-bookmark" title="Bookmark this page">${icons.bookmark}</button>
        <button class="btn" id="btn-lock" title="Click-through mode (${formatKey('Alt+Shift+D')})">${icons.lock}</button>
        <button class="btn" id="btn-snap" title="Snap to corner">${icons.snap}</button>
        <button class="btn" id="btn-crop" title="Crop/Zoom region">${icons.crop}</button>
        <button class="btn" id="btn-zoom-video" title="Zoom to video (${formatKey('Alt+Shift+V')})">${icons.zoomVideo}</button>
        <div class="divider"></div>
        <button class="btn" id="btn-mute" title="Mute (${formatKey('Alt+Shift+M')})">${icons.volume}</button>
        <input type="range" class="opacity-slider" id="opacity-slider" min="10" max="100" value="100" title="Opacity">
        <button class="btn" id="btn-settings" title="Settings">${icons.settings}</button>
        <button class="btn" id="btn-minimize" title="Minimize">${icons.minimize}</button>
        <button class="btn" id="btn-close" title="Close">${icons.close}</button>
    `);
    shadow.appendChild(strip);

    const recentDropdown = document.createElement('div');
    recentDropdown.className = 'recent-dropdown';
    recentDropdown.id = 'recent-dropdown';
    shadow.appendChild(recentDropdown);

    const bookmarksDropdown = document.createElement('div');
    bookmarksDropdown.className = 'recent-dropdown';
    bookmarksDropdown.id = 'bookmarks-dropdown';
    shadow.appendChild(bookmarksDropdown);

    // --------------------------------------------------------------------
    // [5] Popups (snap, recent, bookmarks, context menu)
    // --------------------------------------------------------------------

    const snapPopup = document.createElement('div');
    snapPopup.className = 'snap-popup';
    setInner(snapPopup, `
        <div class="snap-section">
            <div class="snap-section-label">Position</div>
            <div class="snap-grid pos-grid">
                <button class="snap-cell" data-pos="top-left" title="Top Left">&#8598;</button>
                <button class="snap-cell" data-pos="center" title="Center">&#9678;</button>
                <button class="snap-cell" data-pos="top-right" title="Top Right">&#8599;</button>
                <button class="snap-cell" data-pos="bottom-left" title="Bottom Left">&#8601;</button>
                <button class="snap-cell" data-pos="bottom-right" title="Bottom Right" style="grid-column:3;">&#8600;</button>
            </div>
        </div>
        <div class="snap-section">
            <div class="snap-section-label">Halves</div>
            <div class="snap-grid half-grid">
                <button class="snap-cell" data-pos="left-half" title="Left Half">&#9680;</button>
                <button class="snap-cell" data-pos="right-half" title="Right Half">&#9681;</button>
                <button class="snap-cell" data-pos="top-half" title="Top Half">&#9683;</button>
                <button class="snap-cell" data-pos="bottom-half" title="Bottom Half">&#9682;</button>
            </div>
        </div>
        <div class="snap-section">
            <div class="snap-section-label">Thirds</div>
            <div class="snap-grid third-grid">
                <button class="snap-cell aspect-cell" data-pos="left-third" title="Left Third">L &#8531;</button>
                <button class="snap-cell aspect-cell" data-pos="center-third" title="Center Third">C &#8531;</button>
                <button class="snap-cell aspect-cell" data-pos="right-third" title="Right Third">R &#8531;</button>
            </div>
        </div>
        <div class="snap-section">
            <div class="snap-section-label">Aspect</div>
            <div class="snap-grid aspect-grid">
                <button class="snap-cell aspect-cell" data-aspect="16:9" title="Resize to 16:9">16:9</button>
                <button class="snap-cell aspect-cell" data-aspect="4:3" title="Resize to 4:3">4:3</button>
                <button class="snap-cell aspect-cell" data-aspect="21:9" title="Resize to 21:9">21:9</button>
                <button class="snap-cell aspect-cell" data-aspect="1:1" title="Resize to 1:1">1:1</button>
                <button class="snap-cell aspect-cell" data-aspect="9:16" title="Resize to 9:16">9:16</button>
            </div>
        </div>
    `);
    shadow.appendChild(snapPopup);

    const volumePopup = document.createElement('div');
    volumePopup.className = 'volume-popup';
    setInner(volumePopup, `
        <div class="volume-slider" id="volume-slider" tabindex="0" role="slider"
             aria-label="Volume" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100" title="Volume">
            <div class="volume-slider-track">
                <div class="volume-slider-fill"></div>
            </div>
            <div class="volume-slider-thumb"></div>
        </div>
        <button class="btn" id="btn-volume-mute" title="Toggle mute (${formatKey('Alt+Shift+M')})">${icons.volume}</button>
    `);
    shadow.appendChild(volumePopup);

    // --------------------------------------------------------------------
    // [6] Settings modal + tutorial modal
    // --------------------------------------------------------------------

    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'modal-overlay';
    shadow.appendChild(modalOverlay);

    const settingsModal = document.createElement('div');
    settingsModal.className = 'settings-modal hidden';
    setInner(settingsModal, `
        <button class="settings-close-btn" id="btn-close-settings-x" title="Close">${icons.close}</button>
        <div class="settings-scroll">
        <div class="settings-title">Settings</div>

        <div class="settings-section">
            <div class="settings-section-title">Window</div>
            <div class="settings-row">
                <span class="settings-label">Always on Top</span>
                <div class="toggle-switch" id="setting-ontop"></div>
            </div>
            <div class="settings-row">
                <span class="settings-label">Click-Through Mode</span>
                <div class="toggle-switch" id="setting-locked"></div>
            </div>
            <div class="settings-slider-row">
                <div class="settings-label">Opacity: <span id="setting-opacity-value">100</span>%</div>
                <input type="range" class="settings-slider" id="setting-opacity" min="10" max="100" value="100">
            </div>
            <div class="settings-row">
                <span class="settings-label">Auto-Refresh</span>
                <select class="settings-select" id="setting-auto-refresh">
                    <option value="0">Off</option>
                    <option value="1">1 min</option>
                    <option value="2">2 min</option>
                    <option value="5">5 min</option>
                    <option value="10">10 min</option>
                    <option value="15">15 min</option>
                    <option value="30">30 min</option>
                    <option value="60">1 hour</option>
                </select>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">Keyboard Shortcuts</div>
            <div id="hotkey-list"></div>
            <div class="settings-row">
                <span class="settings-label" style="color:rgba(255,255,255,0.5);font-size:12px;">Click a binding to record a new combination. Modifier required (Ctrl/Alt/Shift).</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Reset all to defaults</span>
                <button class="settings-btn" id="btn-reset-hotkeys">Reset</button>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">Navigation</div>
            <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px;">
                <span class="settings-label">Home URL</span>
                <input type="text" class="url-display" id="setting-home-url" placeholder="https://www.google.com" style="width:100%;height:36px;">
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">Data</div>
            <div class="settings-row">
                <span class="settings-label">Clear Recent URLs</span>
                <button class="settings-btn danger" id="btn-clear-recent">Clear</button>
            </div>
            <div class="settings-row">
                <span class="settings-label">Clear Bookmarks</span>
                <button class="settings-btn danger" id="btn-clear-bookmarks">Clear</button>
            </div>
            <div class="settings-row">
                <span class="settings-label">Clear Site Data</span>
                <button class="settings-btn danger" id="btn-clear-site-data">Clear</button>
            </div>
        </div>

        <div class="hotkey-info">
            Tip: Use <kbd>Ctrl+L</kbd> to show the control bar and focus the URL input.
        </div>

        <div class="settings-section">
            <div class="settings-section-title">Updates</div>
            <div class="settings-row">
                <div class="update-section">
                    <button class="settings-btn" id="btn-check-updates">Check for Updates</button>
                    <span class="update-status" id="update-status"></span>
                </div>
            </div>
        </div>

        <div class="settings-footer">
            <span class="settings-version" id="settings-version"></span>
            <button class="settings-btn" id="btn-close-settings">Close</button>
        </div>
        </div>
    `);
    shadow.appendChild(settingsModal);

    const tutorialModal = document.createElement('div');
    tutorialModal.className = 'tutorial-modal hidden';
    setInner(tutorialModal, `
        <div class="tutorial-step active" data-step="0">
            <h2>Welcome to FloatView!</h2>
            <p>A floating browser that stays on top of everything. Perfect for picture-in-picture video, dashboards, chat windows, or anything you want to keep visible.</p>
            <p>Let's take a quick tour of the key features.</p>
            <div class="tutorial-nav">
                <button class="tutorial-skip" id="tutorial-skip">Skip tutorial</button>
                <div class="tutorial-nav-buttons">
                    <button class="tutorial-btn primary" id="tutorial-next">Next</button>
                </div>
            </div>
            <div class="tutorial-dots">
                <div class="tutorial-dot active"></div>
                <div class="tutorial-dot"></div>
                <div class="tutorial-dot"></div>
                <div class="tutorial-dot"></div>
            </div>
        </div>
        <div class="tutorial-step" data-step="1">
            <h2>The Control Strip</h2>
            <p>Hover the <strong>top edge</strong> of the window to reveal the control strip. It slides down with all your controls:</p>
            <div class="tutorial-diagram">[Pin] [Recent] [Home] [____URL bar____] [Lock] | [Opacity] [Settings] [-] [x]</div>
            <p><strong>Pin</strong> toggles always-on-top &bull; <strong>Home</strong> goes to your home page &bull; <strong>Lock</strong> enables click-through mode &bull; <strong>Opacity</strong> adjusts transparency</p>
            <p>You can also press <strong>Ctrl+L</strong> to reveal the strip and focus the URL bar.</p>
            <div class="tutorial-nav">
                <button class="tutorial-skip" id="tutorial-skip">Skip tutorial</button>
                <div class="tutorial-nav-buttons">
                    <button class="tutorial-btn" id="tutorial-back">Back</button>
                    <button class="tutorial-btn primary" id="tutorial-next">Next</button>
                </div>
            </div>
            <div class="tutorial-dots">
                <div class="tutorial-dot"></div>
                <div class="tutorial-dot active"></div>
                <div class="tutorial-dot"></div>
                <div class="tutorial-dot"></div>
            </div>
        </div>
        <div class="tutorial-step" data-step="2">
            <h2>Shortcuts &amp; Tray</h2>
            <p>Global hotkeys work even when FloatView isn't focused:</p>
            <table class="tutorial-shortcut-table">
                <tr><td>${formatKey('Alt+Shift+T')}</td><td>Toggle always-on-top</td></tr>
                <tr><td>${formatKey('Alt+Shift+D')}</td><td>Toggle click-through mode</td></tr>
                <tr><td>${formatKey('Alt+Shift+Up/Down')}</td><td>Adjust opacity</td></tr>
                <tr><td>${formatKey('Alt+Shift+H')}</td><td>Show/hide window</td></tr>
                <tr><td>${formatKey('Alt+Shift+P')}</td><td>Play/pause media</td></tr>
                <tr><td>${formatKey('Alt+Shift+Right')}</td><td>Skip forward</td></tr>
                <tr><td>${formatKey('Alt+Shift+Left')}</td><td>Skip back</td></tr>
                <tr><td>${formatKey('Ctrl+L')}</td><td>Show strip &amp; focus URL bar</td></tr>
            </table>
            <p>FloatView lives in your <strong>system tray</strong> &mdash; right-click the tray icon for quick controls, or left-click to show/hide the window.</p>
            <div class="tutorial-nav">
                <button class="tutorial-skip" id="tutorial-skip">Skip tutorial</button>
                <div class="tutorial-nav-buttons">
                    <button class="tutorial-btn" id="tutorial-back">Back</button>
                    <button class="tutorial-btn primary" id="tutorial-next">Next</button>
                </div>
            </div>
            <div class="tutorial-dots">
                <div class="tutorial-dot"></div>
                <div class="tutorial-dot"></div>
                <div class="tutorial-dot active"></div>
                <div class="tutorial-dot"></div>
            </div>
        </div>
        <div class="tutorial-step" data-step="3">
            <h2>Get Started</h2>
            <p>Set your home page in <strong>Settings</strong> (gear icon in the control strip), or just start browsing by typing a URL.</p>
            <p>Drag the window by grabbing the thin bar at the very top edge. Resize by dragging any edge or corner.</p>
            <p>You can always reopen Settings from the control strip or by right-clicking the tray icon.</p>
            <div class="tutorial-nav">
                <span></span>
                <div class="tutorial-nav-buttons">
                    <button class="tutorial-btn" id="tutorial-back">Back</button>
                    <button class="tutorial-btn primary" id="tutorial-finish">Get Started</button>
                </div>
            </div>
            <div class="tutorial-dots">
                <div class="tutorial-dot"></div>
                <div class="tutorial-dot"></div>
                <div class="tutorial-dot"></div>
                <div class="tutorial-dot active"></div>
            </div>
        </div>
    `);
    shadow.appendChild(tutorialModal);

    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    setInner(contextMenu, `
        <div class="context-menu-item" id="ctx-settings">${icons.settings}Settings</div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" id="ctx-ontop">${icons.pin}Toggle Always on Top</div>
        <div class="context-menu-item" id="ctx-locked">${icons.lock}Toggle Click-Through</div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" id="ctx-snap-tl">&#8598;&ensp;Snap Top Left</div>
        <div class="context-menu-item" id="ctx-snap-tr">&#8599;&ensp;Snap Top Right</div>
        <div class="context-menu-item" id="ctx-snap-bl">&#8601;&ensp;Snap Bottom Left</div>
        <div class="context-menu-item" id="ctx-snap-br">&#8600;&ensp;Snap Bottom Right</div>
        <div class="context-menu-item" id="ctx-snap-center">&#9678;&ensp;Snap Center</div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" id="ctx-minimize">${icons.minimize}Minimize</div>
        <div class="context-menu-item" id="ctx-close">${icons.close}Close</div>
    `);
    shadow.appendChild(contextMenu);

    // --------------------------------------------------------------------
    // [7] Element queries
    // --------------------------------------------------------------------

    const btnBack = strip.querySelector('#btn-back');
    const btnForward = strip.querySelector('#btn-forward');
    const btnRefresh = strip.querySelector('#btn-refresh');
    const btnPin = strip.querySelector('#btn-pin');
    const btnRecent = strip.querySelector('#btn-recent');
    const urlInput = strip.querySelector('#url-input');
    const btnBookmark = strip.querySelector('#btn-bookmark');
    const btnLock = strip.querySelector('#btn-lock');
    const opacitySlider = strip.querySelector('#opacity-slider');
    const btnSettings = strip.querySelector('#btn-settings');
    const btnHome = strip.querySelector('#btn-home');
    const btnMinimize = strip.querySelector('#btn-minimize');
    const btnClose = strip.querySelector('#btn-close');
    const btnSnap = strip.querySelector('#btn-snap');
    const btnCrop = strip.querySelector('#btn-crop');
    const btnZoomVideo = strip.querySelector('#btn-zoom-video');
    const btnMute = strip.querySelector('#btn-mute');
    const volumeSlider = volumePopup.querySelector('#volume-slider');
    const volumeSliderTrack = volumePopup.querySelector('.volume-slider-track');
    const btnVolumeMute = volumePopup.querySelector('#btn-volume-mute');

    // --------------------------------------------------------------------
    // [8] Auto-refresh timer
    // --------------------------------------------------------------------

    let autoRefreshTimer = null;
    function startAutoRefresh(minutes) {
        stopAutoRefresh();
        if (!minutes || minutes <= 0) return;
        autoRefreshTimer = setInterval(() => {
            if (!settingsModal.classList.contains('hidden')) return;
            if (urlInput === document.activeElement) return;
            window.location.reload();
        }, minutes * 60 * 1000);
    }
    function stopAutoRefresh() {
        if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    }

    // --------------------------------------------------------------------
    // [9] Crop / zoom selection + apply
    // --------------------------------------------------------------------

    let cropActive = false;
    let cropOverlayEl = null;

    function enterCropSelection() {
        // Guard against repeat clicks. Without this, each click stacks
        // another overlay (each with its own dimming + listeners), and
        // the compounded background opacity blacks out the page in a
        // way only Esc-spam can recover.
        if (cropOverlayEl) return;
        cropOverlayEl = document.createElement('div');
        cropOverlayEl.className = 'crop-overlay';
        const instructions = document.createElement('div');
        instructions.className = 'crop-instructions';
        instructions.textContent = 'Click and drag to select a region. Press Escape to cancel.';
        cropOverlayEl.appendChild(instructions);
        const sel = document.createElement('div');
        sel.className = 'crop-selection';
        sel.style.display = 'none';
        cropOverlayEl.appendChild(sel);
        let sx, sy, dragging = false;
        cropOverlayEl.addEventListener('mousedown', (e) => {
            sx = e.clientX; sy = e.clientY; dragging = true;
            sel.style.display = 'block';
            sel.style.left = sx + 'px'; sel.style.top = sy + 'px';
            sel.style.width = '0'; sel.style.height = '0';
        });
        cropOverlayEl.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            sel.style.left = Math.min(sx, e.clientX) + 'px';
            sel.style.top = Math.min(sy, e.clientY) + 'px';
            sel.style.width = Math.abs(e.clientX - sx) + 'px';
            sel.style.height = Math.abs(e.clientY - sy) + 'px';
        });
        cropOverlayEl.addEventListener('mouseup', (e) => {
            if (!dragging) return;
            dragging = false;
            const vw = window.innerWidth, vh = window.innerHeight;
            const x = Math.min(sx, e.clientX) / vw;
            const y = Math.min(sy, e.clientY) / vh;
            const w = Math.abs(e.clientX - sx) / vw;
            const h = Math.abs(e.clientY - sy) / vh;
            exitCropSelection();
            if (w < 0.05 || h < 0.05) return;
            applyCrop(x, y, w, h, true);
        });
        cropOverlayEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { exitCropSelection(); e.preventDefault(); }
        });
        cropOverlayEl.setAttribute('tabindex', '0');
        shadow.appendChild(cropOverlayEl);
        cropOverlayEl.focus();
    }

    function exitCropSelection() {
        if (cropOverlayEl) { cropOverlayEl.remove(); cropOverlayEl = null; }
    }

    // Track whether the active crop came from the "Zoom to Video"
    // feature. Used to keep its lifecycle ephemeral (no invoke('set_crop'))
    // and to toggle the zoom button's active state independently from
    // the manual-crop button.
    let zoomVideoActive = false;

    // `persist` controls whether the crop reaches the saved config.
    // Default true preserves the historical behavior for user-initiated
    // crops; zoom-to-video passes false so videos that move/disappear
    // don't strand a stale crop across sessions.
    function applyCrop(x, y, w, h, animate, persist) {
        if (persist === undefined) persist = animate;
        // Move our container out of body so it's not affected by the transform
        if (container.parentNode === document.body) {
            document.documentElement.appendChild(container);
        }
        const vw = window.innerWidth, vh = window.innerHeight;
        const scale = Math.min(1/w, 1/h);
        const tx = -x * vw * scale;
        const ty = -y * vh * scale;
        document.body.style.transformOrigin = '0 0';
        document.body.style.overflow = 'hidden';
        if (animate) {
            document.body.style.transition = 'transform 0.4s cubic-bezier(0.22, 0.9, 0.36, 1.12)';
            requestAnimationFrame(() => {
                document.body.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
            });
            setTimeout(() => { document.body.style.transition = ''; }, 450);
        } else {
            document.body.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
        }
        cropActive = true;
        btnCrop.classList.add('active');
        if (persist) {
            invoke('set_crop', { x, y, width: w, height: h });
        }
    }

    // `persist` controls whether to clear the persisted crop from
    // config. Ephemeral removes (zoom-to-video unzoom) pass false so
    // they don't wipe a manual crop the user saved earlier.
    function removeCrop(persist) {
        if (persist === undefined) persist = true;
        document.body.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
        document.body.style.transform = '';
        setTimeout(() => {
            document.body.style.transition = '';
            document.body.style.transformOrigin = '';
            document.body.style.overflow = '';
            if (container.parentNode !== document.body && document.body) {
                document.body.prepend(container);
            }
        }, 320);
        cropActive = false;
        btnCrop.classList.remove('active');
        if (persist) {
            invoke('clear_crop');
        }
    }

    window.addEventListener('resize', () => {
        if (cropActive && !zoomVideoActive && config && config.crop) {
            applyCrop(config.crop.x, config.crop.y, config.crop.width, config.crop.height, false, false);
        }
    });

    // Pick the largest `<video>` element with a non-zero layout area.
    // `requireOnScreen` biases the first pass to videos the user can
    // currently see — otherwise we'll pick the largest one anywhere in
    // the document, which we'll then scroll into view. Ignores
    // cross-origin iframes (we can't read their DOM).
    function findLargestVideo(requireOnScreen) {
        const videos = document.querySelectorAll('video');
        let best = null;
        let bestArea = 0;
        for (const v of videos) {
            const r = v.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            if (requireOnScreen) {
                if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
                if (r.right <= 0 || r.left >= window.innerWidth) continue;
            }
            const area = r.width * r.height;
            if (area > bestArea) {
                best = v;
                bestArea = area;
            }
        }
        return best;
    }

    // Briefly flash the zoom button red so a hotkey press that didn't
    // find a usable video still gives visible feedback.
    let _zoomNotFoundTimer = null;
    function flashZoomNotFound() {
        btnZoomVideo.classList.add('zoom-not-found');
        if (_zoomNotFoundTimer) clearTimeout(_zoomNotFoundTimer);
        _zoomNotFoundTimer = setTimeout(() => {
            btnZoomVideo.classList.remove('zoom-not-found');
            _zoomNotFoundTimer = null;
        }, 700);
    }

    // Apply the crop for a specific video. Assumes `video` is already
    // visible in the viewport — callers handle the scroll-into-view
    // step so the bounding rect is in its final position.
    function applyZoomToVideoRect(video) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const rect = video.getBoundingClientRect();
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(vw, rect.right);
        const bottom = Math.min(vh, rect.bottom);
        const w = (right - left) / vw;
        const h = (bottom - top) / vh;
        if (w < 0.05 || h < 0.05) {
            console.warn('FloatView: zoom-to-video target too small after scroll', { w, h });
            flashZoomNotFound();
            return;
        }
        if (w > 0.98 && h > 0.98) {
            console.info('FloatView: zoom-to-video target already fills viewport');
            flashZoomNotFound();
            return;
        }
        const x = left / vw;
        const y = top / vh;
        applyCrop(x, y, w, h, true, false);
        zoomVideoActive = true;
        btnZoomVideo.classList.add('active');
        setInner(btnZoomVideo, icons.zoomVideoActive);
    }

    // Wait for a smooth-scrolled element's position to stop changing,
    // then call `cb`. Polls the bounding rect rather than relying on
    // the `scrollend` event, which can fire on a nested scroller (not
    // the one we're watching) or not at all if a scrollable ancestor
    // has its own CSS scroll-behavior.
    //
    // Bails out after `maxWaitMs` regardless, so a page that continues
    // to reflow indefinitely doesn't trap us.
    function waitForScrollSettle(el, cb, maxWaitMs) {
        const deadline = Date.now() + (maxWaitMs || 800);
        let lastTop = el.getBoundingClientRect().top;
        let stable = 0;
        const tick = () => {
            const r = el.getBoundingClientRect();
            if (Math.abs(r.top - lastTop) < 0.5) {
                stable++;
                if (stable >= 3) { cb(); return; }
            } else {
                stable = 0;
            }
            lastTop = r.top;
            if (Date.now() >= deadline) { cb(); return; }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    // Guards against double-activation while the scroll-then-zoom
    // sequence is in flight. Without this a frenzied user (or a
    // double-fired hotkey) could start two scrolls and two crops.
    let zoomToVideoPending = false;

    // Toggle zoom-to-video. Finds the largest <video>, scrolls it into
    // view (smooth), then animates a crop onto its bounding rect. The
    // full sequence is: locate → smooth-scroll (~400ms) → settle →
    // animated crop (~400ms). On toggle off, restores the user's saved
    // manual crop (if any) so layering the two features is lossless.
    //
    // Prefers an on-screen video (what the user is currently looking
    // at) but falls back to the largest one anywhere in the document,
    // so the feature works even if the user has scrolled past the
    // player or the player is below the fold.
    function zoomToVideo() {
        if (zoomToVideoPending) return;
        if (zoomVideoActive) {
            zoomVideoActive = false;
            btnZoomVideo.classList.remove('active');
            setInner(btnZoomVideo, icons.zoomVideo);
            if (config && config.crop) {
                const c = config.crop;
                applyCrop(c.x, c.y, c.width, c.height, true, false);
            } else {
                removeCrop(false);
            }
            return;
        }

        let video = findLargestVideo(true);
        if (!video) video = findLargestVideo(false);
        if (!video) {
            console.warn('FloatView: zoom-to-video found no <video> on page');
            flashZoomNotFound();
            return;
        }

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const initial = video.getBoundingClientRect();
        const offscreen =
            initial.top < 0 || initial.bottom > vh ||
            initial.left < 0 || initial.right > vw;

        if (!offscreen) {
            applyZoomToVideoRect(video);
            return;
        }

        // Smooth-scroll the video to the center of the viewport, then
        // crop once the scroll settles. The staged animation (scroll,
        // pause, crop) reads as "the app is taking me to the video"
        // rather than "the page just snapped."
        zoomToVideoPending = true;
        try {
            video.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        } catch (_) {
            // Old browsers: no options object → instant scroll.
            video.scrollIntoView();
        }
        waitForScrollSettle(video, () => {
            zoomToVideoPending = false;
            applyZoomToVideoRect(video);
        });
    }

    // Expose for Rust-side hotkey scripts (see injection.rs
    // ZOOM_VIDEO_SCRIPT).
    window.__floatViewZoomToVideo = zoomToVideo;

    // Emergency recovery: guarantee the control strip is visible and
    // interactive, regardless of whatever state the page has left us
    // in. Bound to a global hotkey (default Alt+Shift+S) via
    // injection.rs::SHOW_STRIP_SCRIPT. Pathological states this
    // resolves: click-through mode left on, container orphaned from
    // DOM, container hidden by `display:none`, container stranded
    // behind a fullscreen layer.
    window.__floatViewForceShowStrip = function() {
        try {
            // Un-hide the container (click-through mode's primary
            // failure mode).
            container.style.display = '';
            container.style.pointerEvents = '';
            // Re-home the container. Pick the fullscreen element if
            // one's active (see [19]), otherwise body.
            const home = containerHome();
            if (home && container.parentNode !== home) {
                home.prepend(container);
            } else if (!container.parentNode && document.body) {
                document.body.prepend(container);
            }
            // If the user is somehow still in click-through mode,
            // release it via the IPC layer so the container's display
            // stays visible next time.
            if (config && config.window && config.window.locked) {
                invoke('toggle_locked');
            }
            // Force the strip open. cancelHide in case a hide timer
            // is pending.
            cancelHide();
            stripVisible = false; // reset then re-show
            showStrip();
        } catch (e) {
            console.warn('FloatView: force-show-strip failed', e);
        }
    };

    btnZoomVideo.addEventListener('click', zoomToVideo);

    // Mute state tracking. Reflect whatever the page's media elements
    // are doing, even if the user muted from inside the page (YouTube
    // 'M' shortcut, Plex's own mute button, etc.). A periodic sweep
    // plus `volumechange` listeners keep the icon in sync.
    function anyMediaUnmuted() {
        const media = document.querySelectorAll('video, audio');
        if (media.length === 0) return null; // no media at all
        for (const m of media) {
            if (!m.muted) return true;
        }
        return false;
    }

    // Pick a representative volume to seed the dropdown slider. Returns
    // null if there's no media at all. Uses the first unmuted element's
    // volume if any; otherwise falls back to the first media's volume.
    function representativeVolume() {
        const media = document.querySelectorAll('video, audio');
        if (media.length === 0) return null;
        for (const m of media) {
            if (!m.muted) return m.volume;
        }
        return media[0].volume;
    }

    let _suppressVolumeSync = false;
    let _volumeValue = 1.0;

    // Paint the custom slider's fill/thumb from a 0..1 value.
    function renderVolumeSlider(value) {
        _volumeValue = Math.max(0, Math.min(1, value));
        const pct = (_volumeValue * 100);
        volumeSlider.style.setProperty('--vol-pct', pct.toFixed(2) + '%');
        volumeSlider.setAttribute('aria-valuenow', Math.round(pct));
    }

    // Visually dim the slider when there's no media on the page, but
    // keep pointer / keyboard input flowing — the control should never
    // feel broken, and the volume will apply as soon as media appears.
    function setVolumeInactive(inactive) {
        volumeSlider.classList.toggle('inactive', inactive);
    }

    function updateMuteIcon() {
        const state = anyMediaUnmuted();
        if (state === null) {
            // No media on page: show volume icon but dim the button.
            setInner(btnMute, icons.volume);
            btnMute.classList.remove('active');
            btnMute.style.opacity = '0.5';
            setInner(btnVolumeMute, icons.volume);
            btnVolumeMute.classList.remove('active');
            setVolumeInactive(true);
            return;
        }
        btnMute.style.opacity = '';
        setVolumeInactive(false);
        if (state) {
            setInner(btnMute, icons.volume);
            btnMute.classList.remove('active');
            setInner(btnVolumeMute, icons.volume);
            btnVolumeMute.classList.remove('active');
        } else {
            setInner(btnMute, icons.volumeMuted);
            btnMute.classList.add('active');
            setInner(btnVolumeMute, icons.volumeMuted);
            btnVolumeMute.classList.add('active');
        }
        // Keep the slider in sync with the page unless the user is
        // actively dragging it (handled via _suppressVolumeSync).
        if (!_suppressVolumeSync) {
            const v = representativeVolume();
            if (v !== null) renderVolumeSlider(v);
        }
    }

    function toggleMuteAll() {
        const media = document.querySelectorAll('video, audio');
        if (media.length === 0) return;
        const anyUnmuted = Array.from(media).some((m) => !m.muted);
        for (const m of media) m.muted = anyUnmuted;
        updateMuteIcon();
    }

    function setAllMediaVolume(vol) {
        const clamped = Math.max(0, Math.min(1, vol));
        const media = document.querySelectorAll('video, audio');
        for (const m of media) {
            m.volume = clamped;
            // Auto-unmute when the user drags the volume up from zero.
            if (clamped > 0 && m.muted) m.muted = false;
        }
    }

    function positionVolumePopup() {
        const rect = btnMute.getBoundingClientRect();
        // Snug against the button so the popup reads as an extension of
        // it rather than a floating panel. The ::before nub bridges any
        // residual gap.
        volumePopup.style.top = (rect.bottom + 4) + 'px';
        // Center the (narrow) popup horizontally under the mute button,
        // clamping to the viewport edge.
        const width = volumePopup.offsetWidth || 48;
        let left = rect.left + (rect.width - width) / 2;
        if (left < 8) left = 8;
        const maxLeft = window.innerWidth - width - 8;
        if (left > maxLeft) left = Math.max(8, maxLeft);
        volumePopup.style.left = left + 'px';
    }

    function showVolumePopup() {
        updateMuteIcon();
        positionVolumePopup();
        volumePopup.classList.add('visible');
        btnMute.classList.add('dropdown-open');
        recentDropdown.classList.remove('visible');
        bookmarksDropdown.classList.remove('visible');
        snapPopup.classList.remove('visible');
    }

    function hideVolumePopup() {
        volumePopup.classList.remove('visible');
        btnMute.classList.remove('dropdown-open');
    }

    btnMute.addEventListener('click', (e) => {
        e.stopPropagation();
        if (volumePopup.classList.contains('visible')) {
            hideVolumePopup();
        } else {
            showVolumePopup();
        }
    });

    btnVolumeMute.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMuteAll();
    });

    volumePopup.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // --- Custom vertical slider: pointer-driven drag ---
    // Native <input type=range> in `writing-mode: vertical-*` has flaky
    // drag tracking in current WebView2 builds; rolling our own keeps
    // behavior predictable and the visuals match the toolbar's glass
    // aesthetic.
    function volumeFromPointer(e) {
        const rect = volumeSliderTrack.getBoundingClientRect();
        if (rect.height <= 0) return _volumeValue;
        const y = e.clientY - rect.top;
        const ratio = 1 - Math.max(0, Math.min(rect.height, y)) / rect.height;
        return ratio;
    }

    let _sliderDragging = false;
    let _sliderPointerId = null;

    volumeSlider.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        _sliderDragging = true;
        _sliderPointerId = e.pointerId;
        _suppressVolumeSync = true;
        volumeSlider.classList.add('dragging');
        try { volumeSlider.setPointerCapture(e.pointerId); } catch (_) {}
        const v = volumeFromPointer(e);
        renderVolumeSlider(v);
        setAllMediaVolume(v);
    });

    volumeSlider.addEventListener('pointermove', (e) => {
        if (!_sliderDragging || e.pointerId !== _sliderPointerId) return;
        const v = volumeFromPointer(e);
        renderVolumeSlider(v);
        setAllMediaVolume(v);
    });

    function endVolumeDrag(e) {
        if (!_sliderDragging) return;
        if (e && e.pointerId !== _sliderPointerId) return;
        _sliderDragging = false;
        _sliderPointerId = null;
        volumeSlider.classList.remove('dragging');
        try { if (e) volumeSlider.releasePointerCapture(e.pointerId); } catch (_) {}
        _suppressVolumeSync = false;
        updateMuteIcon();
    }
    volumeSlider.addEventListener('pointerup', endVolumeDrag);
    volumeSlider.addEventListener('pointercancel', endVolumeDrag);
    volumeSlider.addEventListener('lostpointercapture', endVolumeDrag);

    // Keyboard control for accessibility: ↑/↓ nudge by 5%, PageUp/Down
    // by 10%, Home/End for 0% / 100%.
    volumeSlider.addEventListener('keydown', (e) => {
        let next = null;
        switch (e.key) {
            case 'ArrowUp':   next = _volumeValue + 0.05; break;
            case 'ArrowDown': next = _volumeValue - 0.05; break;
            case 'PageUp':    next = _volumeValue + 0.10; break;
            case 'PageDown':  next = _volumeValue - 0.10; break;
            case 'Home':      next = 0; break;
            case 'End':       next = 1; break;
            default: return;
        }
        e.preventDefault();
        next = Math.max(0, Math.min(1, next));
        renderVolumeSlider(next);
        setAllMediaVolume(next);
        updateMuteIcon();
    });

    // Scroll-wheel on the slider for quick fine adjustments.
    volumeSlider.addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = e.deltaY < 0 ? 0.05 : -0.05;
        const next = Math.max(0, Math.min(1, _volumeValue + step));
        renderVolumeSlider(next);
        setAllMediaVolume(next);
        updateMuteIcon();
    }, { passive: false });

    // Attach volumechange listeners to current and future media
    // elements so page-side mute toggles (YouTube 'M' shortcut etc.)
    // keep the button icon in sync.
    function attachVolumeListener(el) {
        if (el.dataset.floatviewMuteTracked) return;
        el.dataset.floatviewMuteTracked = '1';
        el.addEventListener('volumechange', updateMuteIcon, { passive: true });
    }

    // Attach volumechange listeners to newly-inserted media elements
    // so page-side mute toggles (e.g., YouTube's 'M' shortcut) keep
    // our button icon in sync. Only calls `updateMuteIcon` when media
    // is actually added or removed — YouTube-scale DOM churn would
    // otherwise hammer a full-document query on every mutation batch.
    const _muteObserver = new MutationObserver((mutations) => {
        let mediaChanged = false;
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                const isMedia = node.matches && (node.matches('video') || node.matches('audio'));
                if (isMedia) {
                    attachVolumeListener(node);
                    mediaChanged = true;
                }
                if (node.querySelectorAll) {
                    const nested = node.querySelectorAll('video, audio');
                    if (nested.length > 0) {
                        nested.forEach(attachVolumeListener);
                        mediaChanged = true;
                    }
                }
            }
            if (!mediaChanged) {
                for (const node of m.removedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches && (node.matches('video') || node.matches('audio'))) {
                        mediaChanged = true;
                        break;
                    }
                    if (node.querySelector && node.querySelector('video, audio')) {
                        mediaChanged = true;
                        break;
                    }
                }
            }
        }
        if (mediaChanged) updateMuteIcon();
    });
    (function startMuteObserver() {
        const root = document.documentElement || document.body;
        if (root) _muteObserver.observe(root, { childList: true, subtree: true });
        document.querySelectorAll('video, audio').forEach(attachVolumeListener);
        updateMuteIcon();
    })();

    function snapFlash() {
        document.documentElement.style.transition = 'opacity 0.1s ease-out';
        document.documentElement.style.opacity = '0.7';
        setTimeout(() => {
            document.documentElement.style.transition = 'opacity 0.2s ease-in';
            document.documentElement.style.opacity = '1';
            setTimeout(() => {
                document.documentElement.style.transition = '';
                document.documentElement.style.opacity = '';
            }, 220);
        }, 100);
    }

    // --------------------------------------------------------------------
    // [13] URL tracking + recent dropdown
    // --------------------------------------------------------------------

    function updateRecentDropdown() {
        recentDropdown.replaceChildren();

        if (!config || !config.recent_urls || config.recent_urls.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'recent-empty';
            empty.textContent = 'No recent URLs';
            recentDropdown.appendChild(empty);
            return;
        }

        const currentUrl = window.location.href;
        config.recent_urls.forEach((url) => {
            const item = document.createElement('div');
            item.className = 'recent-item';
            if (url === currentUrl) {
                item.classList.add('current');
            }
            item.dataset.url = url;
            item.textContent = url;
            item.addEventListener('click', async () => {
                if (url && !item.classList.contains('current')) {
                    await navigateToUrl(url);
                }
            });
            recentDropdown.appendChild(item);
        });
    }

    // --------------------------------------------------------------------
    // [10] Show/hide strip animation
    // --------------------------------------------------------------------

    function showStrip() {
        cancelHide();
        if (stripVisible) return;
        stripVisible = true;
        strip.classList.add('visible');
    }

    function hideStrip() {
        if (!stripVisible) return;
        stripVisible = false;
        strip.style.transform = '';
        strip.style.transition = '';
        strip.classList.remove('visible');
    }

    function scheduleHide() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            hideTimer = null;
            if (tutorialActive ||
                !settingsModal.classList.contains('hidden') ||
                recentDropdown.classList.contains('visible') ||
                bookmarksDropdown.classList.contains('visible') ||
                volumePopup.classList.contains('visible')) {
                return;
            }
            hideStrip();
        }, HIDE_DELAY);
    }

    function cancelHide() {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    }

    function updatePinIcon(isActive) {
        setInner(btnPin, isActive ? icons.pinActive : icons.pin);
    }

    function updateLockIcon(isLocked) {
        setInner(btnLock, isLocked ? icons.lockActive : icons.lock);
    }

    dragBar.addEventListener('dblclick', () => {
        invoke('maximize_toggle');
    });

    dragBar.addEventListener('mouseenter', () => {
        cancelHide();
    });

    hotzone.addEventListener('mouseenter', () => {
        cancelHide();
        dwellTimer = setTimeout(showStrip, DWELL_DELAY);
    });

    hotzone.addEventListener('mouseleave', (e) => {
        // Don't cancel if mouse moved into the strip or drag bar
        if (e.relatedTarget && (e.relatedTarget === strip || strip.contains(e.relatedTarget) || e.relatedTarget === dragBar)) {
            return;
        }
        if (dwellTimer) {
            clearTimeout(dwellTimer);
            dwellTimer = null;
        }
        if (stripVisible) {
            scheduleHide();
        }
    });

    strip.addEventListener('mouseleave', (e) => {
        // Don't hide if mouse moved to hotzone or drag bar
        if (e.relatedTarget === hotzone || e.relatedTarget === dragBar) {
            return;
        }
        // Don't hide if modal or dropdown is open
        if (!settingsModal.classList.contains('hidden') ||
            recentDropdown.classList.contains('visible') ||
            bookmarksDropdown.classList.contains('visible') ||
            volumePopup.classList.contains('visible')) {
            return;
        }
        scheduleHide();
    });

    strip.addEventListener('mouseenter', () => {
        cancelHide();
        if (dwellTimer) {
            clearTimeout(dwellTimer);
            dwellTimer = null;
        }
    });

    function positionDropdown() {
        const rect = btnRecent.getBoundingClientRect();
        recentDropdown.style.top = (rect.bottom + 8) + 'px';
        recentDropdown.style.left = rect.left + 'px';
    }

    btnRecent.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = recentDropdown.classList.contains('visible');
        if (!isVisible) {
            updateRecentDropdown();
            positionDropdown();
        }
        recentDropdown.classList.toggle('visible', !isVisible);
        bookmarksDropdown.classList.remove('visible');
    });

    document.addEventListener('click', (e) => {
        if (!strip.contains(e.target) && !recentDropdown.contains(e.target) && !bookmarksDropdown.contains(e.target)) {
            recentDropdown.classList.remove('visible');
            bookmarksDropdown.classList.remove('visible');
        }
        if (!strip.contains(e.target) && !snapPopup.contains(e.target)) {
            snapPopup.classList.remove('visible');
        }
        if (!strip.contains(e.target) && !volumePopup.contains(e.target)) {
            hideVolumePopup();
        }
    });

    recentDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // --------------------------------------------------------------------
    // [11] Tauri `invoke` wrapper
    // Holds the closure-scoped COMMAND_TOKEN. Never leaks to the host
    // page because both the token and this wrapper live inside the IIFE.
    // --------------------------------------------------------------------

    let tauriInvoke = null;

    async function invoke(cmd, args = {}) {
        if (!window.__TAURI__?.core) {
            // Wait for __TAURI__ to become available (race condition on external pages)
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 50));
                if (window.__TAURI__?.core) break;
            }
        }
        if (!tauriInvoke && window.__TAURI__?.core?.invoke) {
            tauriInvoke = window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
        }
        if (tauriInvoke) {
            try {
                return await tauriInvoke(cmd, { ...args, token: COMMAND_TOKEN });
            } catch (e) {
                console.warn('FloatView: IPC call failed for', cmd, e);
                return null;
            }
        }
        console.warn('FloatView: Tauri IPC not available for:', cmd);
        return null;
    }

    // --------------------------------------------------------------------
    // [12] Button handlers
    // --------------------------------------------------------------------

    btnPin.addEventListener('click', async () => {
        const result = await invoke('toggle_always_on_top');
        if (result !== null) {
            btnPin.classList.toggle('active', result);
            updatePinIcon(result);
        }
    });

    async function navigateToUrl(url) {
        const result = await invoke('navigate', { url });
        if (result === null) {
            // IPC failed (e.g., error page), navigate directly
            window.location.href = url;
        }
    }

    urlInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            let url = urlInput.value.trim();
            if (!url) return;
            if (!url.match(/^https?:\/\//)) {
                if (url.includes(' ') || (!url.includes('.') && !url.includes(':'))) {
                    url = 'https://duckduckgo.com/?q=' + encodeURIComponent(url);
                } else {
                    url = 'https://' + url;
                }
            }
            if (url) {
                await navigateToUrl(url);
            }
        }
    });

    btnHome.addEventListener('click', async () => {
        const result = await invoke('navigate_home');
        if (result === null) {
            let homeUrl = config?.home_url || EMBEDDED_HOME_URL || 'https://www.google.com';
            window.location.href = homeUrl;
        }
    });

    btnLock.addEventListener('click', async () => {
        const result = await invoke('toggle_locked');
        if (result !== null) {
            updateLockIcon(result);
            btnLock.classList.toggle('active', result);
            if (result) {
                hideStrip();
                container.style.display = 'none';
            }
        }
    });

    function sliderToOpacity(val) {
        const t = (val - 10) / 90;
        return 0.1 + 0.9 * (1 - (1 - t) * (1 - t));
    }

    function opacityToSlider(opacity) {
        const t = 1 - Math.sqrt(1 - (Math.min(1, Math.max(0.1, opacity)) - 0.1) / 0.9);
        return Math.round(10 + t * 90);
    }

    let _opacityThrottle = null;
    opacitySlider.addEventListener('input', (e) => {
        if (_opacityThrottle) return;
        _opacityThrottle = setTimeout(() => { _opacityThrottle = null; }, 32);
        const opacity = sliderToOpacity(parseInt(e.target.value, 10));
        applyContentOpacity(opacity);
        invoke('set_opacity_live', { opacity });
    });

    opacitySlider.addEventListener('change', async (e) => {
        const opacity = sliderToOpacity(parseInt(e.target.value, 10));
        applyContentOpacity(opacity);
        await invoke('set_opacity', { opacity });
    });

    btnSettings.addEventListener('click', async () => {
        if (settingsModal.classList.contains('visible')) {
            closeSettings();
        } else {
            openSettings();
        }
    });

    // Snap popup
    function positionSnapPopup() {
        const rect = btnSnap.getBoundingClientRect();
        snapPopup.style.top = (rect.bottom + 8) + 'px';
        // Anchor at the button's left, but keep the (now wider) popup
        // inside the viewport with an 8px margin.
        snapPopup.style.left = '0px';
        const popupWidth = snapPopup.getBoundingClientRect().width || 156;
        const maxLeft = Math.max(8, window.innerWidth - popupWidth - 8);
        snapPopup.style.left = Math.min(rect.left, maxLeft) + 'px';
    }

    btnSnap.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = snapPopup.classList.contains('visible');
        if (!isVisible) positionSnapPopup();
        snapPopup.classList.toggle('visible', !isVisible);
        recentDropdown.classList.remove('visible');
        bookmarksDropdown.classList.remove('visible');
    });

    snapPopup.addEventListener('click', async (e) => {
        e.stopPropagation();
        const target = e.target.closest('[data-pos], [data-aspect]');
        if (!target) return;
        snapPopup.classList.remove('visible');
        if (target.dataset.pos) {
            await invoke('snap_window', { position: target.dataset.pos });
        } else if (target.dataset.aspect) {
            await invoke('set_aspect_ratio', { ratio: target.dataset.aspect });
        }
        snapFlash();
    });

    // Context menu snap items
    ['tl', 'tr', 'bl', 'br', 'center'].forEach(id => {
        const posMap = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right', center: 'center' };
        const el = contextMenu.querySelector('#ctx-snap-' + id);
        if (el) el.addEventListener('click', async () => {
            hideContextMenu();
            await invoke('snap_window', { position: posMap[id] });
            snapFlash();
        });
    });

    // Crop button. If zoom-to-video is active, clicking the crop
    // button first exits zoom (restoring any saved manual crop). A
    // second click then clears the manual crop or enters selection,
    // matching the non-zoom flow.
    btnCrop.addEventListener('click', () => {
        if (zoomVideoActive) {
            zoomToVideo();
            return;
        }
        if (cropActive) {
            removeCrop();
        } else {
            enterCropSelection();
        }
    });

    // Navigation buttons
    btnBack.addEventListener('click', () => { window.history.back(); });
    btnForward.addEventListener('click', () => { window.history.forward(); });
    btnRefresh.addEventListener('click', () => {
        // Brief spin before reload — confirmation that the click landed.
        // The page reload arrives a few hundred ms later (network-dependent).
        btnRefresh.classList.remove('spinning');
        // Force reflow so re-adding the class re-fires the animation.
        void btnRefresh.offsetWidth;
        btnRefresh.classList.add('spinning');
        window.location.reload();
    });

    // Bookmark functions
    function isBookmarked(url) {
        return config && config.bookmarks && config.bookmarks.some(b => {
            if (b === url) return true;
            try {
                const bu = new URL(b);
                const uu = new URL(url);
                return bu.origin === uu.origin && bu.pathname.replace(/\/+$/, '') === uu.pathname.replace(/\/+$/, '') && bu.search === uu.search;
            } catch { return false; }
        });
    }

    function updateBookmarkIcon() {
        const currentUrl = window.location.href;
        const active = isBookmarked(currentUrl);
        setInner(btnBookmark, active ? icons.bookmarkActive : icons.bookmark);
        btnBookmark.classList.toggle('active', active);
    }

    // --------------------------------------------------------------------
    // [14] Bookmark dropdown
    // --------------------------------------------------------------------

    function updateBookmarksDropdown() {
        bookmarksDropdown.replaceChildren();
        if (!config || !config.bookmarks || config.bookmarks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'recent-empty';
            empty.textContent = 'No bookmarks';
            bookmarksDropdown.appendChild(empty);
            return;
        }
        config.bookmarks.forEach((url) => {
            const item = document.createElement('div');
            item.className = 'recent-item';
            item.style.display = 'flex';
            item.style.justifyContent = 'space-between';
            item.style.alignItems = 'center';
            item.style.gap = '8px';
            const label = document.createElement('span');
            label.style.overflow = 'hidden';
            label.style.textOverflow = 'ellipsis';
            label.style.whiteSpace = 'nowrap';
            label.style.flex = '1';
            label.textContent = url;
            const removeBtn = document.createElement('span');
            removeBtn.textContent = '×';
            removeBtn.style.cursor = 'pointer';
            removeBtn.style.opacity = '0.4';
            removeBtn.style.fontSize = '16px';
            removeBtn.style.flexShrink = '0';
            removeBtn.addEventListener('mouseenter', () => { removeBtn.style.opacity = '1'; });
            removeBtn.addEventListener('mouseleave', () => { removeBtn.style.opacity = '0.4'; });
            removeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await invoke('remove_bookmark', { url });
                if (config) {
                    config.bookmarks = config.bookmarks.filter(u => u !== url && !urlsMatch(u, url));
                }
                updateBookmarksDropdown();
                updateBookmarkIcon();
            });
            item.appendChild(label);
            item.appendChild(removeBtn);
            item.addEventListener('click', async () => {
                bookmarksDropdown.classList.remove('visible');
                await navigateToUrl(url);
            });
            bookmarksDropdown.appendChild(item);
        });
    }

    function positionBookmarksDropdown() {
        const rect = btnBookmark.getBoundingClientRect();
        bookmarksDropdown.style.top = (rect.bottom + 8) + 'px';
        bookmarksDropdown.style.left = rect.left + 'px';
    }

    function urlsMatch(a, b) {
        if (a === b) return true;
        try {
            const ua = new URL(a);
            const ub = new URL(b);
            return ua.origin === ub.origin && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '') && ua.search === ub.search;
        } catch { return false; }
    }

    async function getBookmarksFromRust() {
        const freshConfig = await invoke('get_config');
        return freshConfig ? freshConfig.bookmarks || [] : config ? config.bookmarks || [] : [];
    }

    function bookmarkPop() {
        btnBookmark.classList.remove('popping');
        void btnBookmark.offsetWidth;
        btnBookmark.classList.add('popping');
    }

    btnBookmark.addEventListener('click', async (e) => {
        e.stopPropagation();
        const currentUrl = window.location.href;
        bookmarkPop();
        if (isBookmarked(currentUrl)) {
            await invoke('remove_bookmark', { url: currentUrl });
            if (config) {
                config.bookmarks = config.bookmarks.filter(u => u !== currentUrl && !urlsMatch(u, currentUrl));
            }
            updateBookmarkIcon();
            updateBookmarksDropdown();
        } else {
            await invoke('add_bookmark', { url: currentUrl });
            if (config) {
                config.bookmarks = await getBookmarksFromRust();
            }
            updateBookmarkIcon();
            updateBookmarksDropdown();
        }
    });

    btnBookmark.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isVisible = bookmarksDropdown.classList.contains('visible');
        if (!isVisible) {
            updateBookmarksDropdown();
            positionBookmarksDropdown();
        }
        bookmarksDropdown.classList.toggle('visible', !isVisible);
        recentDropdown.classList.remove('visible');
    });

    // --------------------------------------------------------------------
    // [15] Window title observer
    // --------------------------------------------------------------------

    let _lastTitle = '';
    function updateWindowTitle() {
        const title = document.title || 'FloatView';
        if (title !== _lastTitle) {
            _lastTitle = title;
            invoke('set_window_title', { title });
        }
    }
    const _titleObserver = new MutationObserver(updateWindowTitle);
    function observeTitle() {
        const titleEl = document.querySelector('title');
        if (titleEl) {
            _titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
        }
    }
    setInterval(updateWindowTitle, 2000);

    // Track URL changes on navigation (back/forward/spa navigation)
    let _lastTrackedUrl = window.location.href;
    function trackUrlChange() {
        const currentUrl = window.location.href;
        if (currentUrl !== _lastTrackedUrl && /^https?:\/\//i.test(currentUrl)) {
            _lastTrackedUrl = currentUrl;
            urlInput.value = currentUrl;
            updateBookmarkIcon();
            invoke('set_url', { url: currentUrl });
        }
    }
    window.addEventListener('popstate', trackUrlChange);
    setInterval(trackUrlChange, 3000);

    const settingOntop = settingsModal.querySelector('#setting-ontop');
    const settingLocked = settingsModal.querySelector('#setting-locked');
    const settingOpacity = settingsModal.querySelector('#setting-opacity');
    const settingOpacityValue = settingsModal.querySelector('#setting-opacity-value');
    const settingHomeUrl = settingsModal.querySelector('#setting-home-url');
    const btnClearRecent = settingsModal.querySelector('#btn-clear-recent');
    const btnClearBookmarks = settingsModal.querySelector('#btn-clear-bookmarks');
    const btnClearSiteData = settingsModal.querySelector('#btn-clear-site-data');
    const btnCloseSettings = settingsModal.querySelector('#btn-close-settings');
    const hotkeyList = settingsModal.querySelector('#hotkey-list');
    const btnResetHotkeys = settingsModal.querySelector('#btn-reset-hotkeys');
    const btnCheckUpdates = settingsModal.querySelector('#btn-check-updates');
    const updateStatus = settingsModal.querySelector('#update-status');
    const settingsVersion = settingsModal.querySelector('#settings-version');

    // Load version into settings footer
    (async () => {
        const version = await invoke('get_version');
        if (version) settingsVersion.textContent = 'FloatView v' + version;
    })();

    // Stateful update button. Three modes:
    //   'check'    — "Check for Updates", fires check_for_updates
    //   'install'  — "Install vX.Y.Z", fires install_update (triggers
    //                download + install + restart)
    //   'busy'     — disabled + spinner, set during RPC calls
    // The background 24h check can also set the button into 'install'
    // mode via the update-available event listener below.
    let _updateMode = 'check';
    let _availableVersion = null;

    function setUpdateMode(mode, opts = {}) {
        _updateMode = mode;
        switch (mode) {
            case 'check':
                btnCheckUpdates.disabled = false;
                btnCheckUpdates.textContent = 'Check for Updates';
                btnCheckUpdates.classList.remove('primary');
                updateStatus.className = 'update-status';
                updateStatus.textContent = opts.message || '';
                break;
            case 'install':
                _availableVersion = opts.version;
                btnCheckUpdates.disabled = false;
                btnCheckUpdates.textContent = 'Install v' + opts.version;
                btnCheckUpdates.classList.add('primary');
                updateStatus.className = 'update-status available';
                updateStatus.textContent = opts.message || ('v' + opts.version + ' available');
                break;
            case 'busy':
                btnCheckUpdates.disabled = true;
                updateStatus.className = 'update-status';
                setInner(updateStatus, '<span class="update-spinner"></span>' + (opts.label || 'Working…'));
                break;
        }
    }

    btnCheckUpdates.addEventListener('click', async () => {
        if (_updateMode === 'install') {
            // Already know an update is available — kick off install.
            setUpdateMode('busy', { label: 'Downloading…' });
            try {
                const ok = await invoke('install_update');
                if (ok === false) {
                    // Raced: the update disappeared between our last
                    // check and this click. Drop back to check mode.
                    setUpdateMode('check', { message: 'You\'re up to date!' });
                }
                // If ok === true the app is about to restart; no
                // need to touch the UI further.
            } catch (e) {
                setUpdateMode('check');
                updateStatus.className = 'update-status error';
                updateStatus.textContent = 'Install failed: ' + e;
            }
            return;
        }

        // 'check' mode: run a fresh check.
        setUpdateMode('busy', { label: 'Checking…' });
        try {
            const result = await invoke('check_for_updates');
            if (result) {
                setUpdateMode('install', { version: result.version });
            } else {
                setUpdateMode('check', { message: 'You\'re up to date!' });
            }
        } catch (e) {
            setUpdateMode('check');
            updateStatus.className = 'update-status error';
            updateStatus.textContent = 'Check failed: ' + e;
        }
    });

    // Hotkey rebinding. Order matters — this is the order rows render
    // in the settings panel.
    const HOTKEY_DEFINITIONS = [
        { field: 'toggle_on_top',     label: 'Toggle Always on Top',    default: 'Alt+Shift+T' },
        { field: 'toggle_locked',     label: 'Toggle Click-Through',    default: 'Alt+Shift+D' },
        { field: 'opacity_up',        label: 'Opacity Up',              default: 'Alt+Shift+Up' },
        { field: 'opacity_down',      label: 'Opacity Down',            default: 'Alt+Shift+Down' },
        { field: 'toggle_visibility', label: 'Show/Hide Window',        default: 'Alt+Shift+H' },
        { field: 'media_play_pause',  label: 'Play/Pause Media',        default: 'Alt+Shift+P' },
        { field: 'media_next',        label: 'Skip Forward',            default: 'Alt+Shift+Right' },
        { field: 'media_previous',    label: 'Skip Back',               default: 'Alt+Shift+Left' },
        { field: 'media_mute',        label: 'Mute',                    default: 'Alt+Shift+M' },
        { field: 'zoom_video',        label: 'Zoom to Video',           default: 'Alt+Shift+V' },
        { field: 'show_strip',        label: 'Force-show Control Strip', default: 'Alt+Shift+S' },
    ];

    // Tracks isDefault per field across renders so we can fire the
    // fade-in animation only on the default → diverged transition,
    // not on every render (which would re-animate on settings open).
    let _prevHotkeyDefaultState = null;

    function renderHotkeyRows() {
        if (!hotkeyList) return;
        const hk = (config && config.hotkeys) || {};
        const newState = {};
        const rows = HOTKEY_DEFINITIONS.map(def => {
            const value = hk[def.field] || def.default;
            const display = formatKey(value);
            const isDefault = value === def.default;
            newState[def.field] = isDefault;
            // Reset icon only renders when the binding diverges from
            // default — avoids visual noise for the common case.
            const resetBtn = isDefault
                ? ''
                : '<button class="hotkey-reset-btn" data-reset-hotkey="' + def.field +
                  '" title="Reset to ' + formatKey(def.default) + '">' + icons.refresh + '</button>';
            return (
                '<div class="settings-row">' +
                    '<span class="settings-label">' + def.label + '</span>' +
                    '<div class="hotkey-controls">' +
                        resetBtn +
                        '<button class="hotkey-btn" data-hotkey="' + def.field + '" title="Click to rebind">' +
                            display +
                        '</button>' +
                    '</div>' +
                '</div>'
            );
        }).join('');
        setInner(hotkeyList, rows);

        // Animate icons that just appeared (default → non-default since
        // last render). Skip on first render so reopening settings with
        // pre-existing custom bindings doesn't trigger a wave of fade-ins.
        if (_prevHotkeyDefaultState) {
            for (const def of HOTKEY_DEFINITIONS) {
                if (_prevHotkeyDefaultState[def.field] && !newState[def.field]) {
                    const btn = hotkeyList.querySelector('[data-reset-hotkey="' + def.field + '"]');
                    if (btn) btn.classList.add('appearing');
                }
            }
        }
        _prevHotkeyDefaultState = newState;
    }

    // Translate a keydown event into the "Mod+Mod+Key" shape that
    // hotkeys.rs::parse_hotkey understands. Returns null if the event
    // can't be a valid binding (pure modifier, unknown key, no modifier
    // on a non-F-key).
    function keyEventToHotkeyString(e) {
        const mods = [];
        if (e.ctrlKey) mods.push('Ctrl');
        if (e.shiftKey) mods.push('Shift');
        if (e.altKey) mods.push('Alt');
        if (e.metaKey) mods.push('Super');

        const code = e.code || '';
        const key = e.key || '';

        let keyName = null;
        if (/^Key[A-Z]$/.test(code)) keyName = code.slice(3);
        else if (/^Digit[0-9]$/.test(code)) keyName = code.slice(5);
        else if (/^F([1-9]|1[0-2])$/.test(code)) keyName = code;
        else if (key === 'ArrowUp') keyName = 'Up';
        else if (key === 'ArrowDown') keyName = 'Down';
        else if (key === 'ArrowLeft') keyName = 'Left';
        else if (key === 'ArrowRight') keyName = 'Right';
        else if (code === 'Space' || key === ' ') keyName = 'Space';
        else if (key === 'Enter') keyName = 'Enter';
        else if (key === 'Tab') keyName = 'Tab';
        else if (key === 'Backspace') keyName = 'Backspace';
        else if (key === 'Delete') keyName = 'Delete';
        else if (key === 'Home') keyName = 'Home';
        else if (key === 'End') keyName = 'End';
        else if (key === 'PageUp') keyName = 'PageUp';
        else if (key === 'PageDown') keyName = 'PageDown';
        else if (code === 'BracketLeft') keyName = '[';
        else if (code === 'BracketRight') keyName = ']';
        else if (code === 'Semicolon') keyName = ';';
        else if (code === 'Quote') keyName = "'";
        else if (code === 'Comma') keyName = ',';
        else if (code === 'Period') keyName = '.';
        else if (code === 'Slash') keyName = '/';
        else if (code === 'Backslash') keyName = '\\';
        else if (code === 'Backquote') keyName = '`';
        else if (code === 'Minus') keyName = '-';
        else if (code === 'Equal') keyName = '=';

        if (!keyName) return null;
        // Bare F1-F12 is a useful exception; everything else needs a
        // modifier to avoid swallowing single keystrokes globally.
        if (mods.length === 0 && !/^F([1-9]|1[0-2])$/.test(keyName)) return null;
        return [...mods, keyName].join('+');
    }

    let _activeHotkeyCapture = null; // { button, keyHandler, blurHandler, original, savedHotkey }

    function endHotkeyCapture(restore) {
        if (!_activeHotkeyCapture) return;
        const cap = _activeHotkeyCapture;
        _activeHotkeyCapture = null;
        window.removeEventListener('keydown', cap.keyHandler, true);
        cap.button.removeEventListener('blur', cap.blurHandler);
        cap.button.classList.remove('capturing');
        if (restore) cap.button.textContent = cap.original;
        // Resume even if the user committed: the save path's
        // re_register_hotkeys also registers, but a second register on
        // top of the same set is harmless and keeps the cleanup simple.
        if (!cap.savedHotkey) {
            invoke('resume_global_hotkeys').catch(() => {});
        }
    }

    async function startHotkeyCapture(button) {
        if (_activeHotkeyCapture) endHotkeyCapture(true);
        const original = button.textContent;
        button.classList.add('capturing');
        button.textContent = 'Press keys…';
        // Pause OS-level hotkeys so pressing an existing binding while
        // capturing doesn't toggle pin/lock/etc.
        invoke('pause_global_hotkeys').catch(() => {});

        const blurHandler = () => endHotkeyCapture(true);

        const keyHandler = async (e) => {
            // Pure modifier: still composing.
            if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return;

            // Unmodified Escape cancels; modified Escape would be a valid
            // binding (Ctrl+Shift+Esc, etc.).
            if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
                endHotkeyCapture(true);
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            const hotkey = keyEventToHotkeyString(e);
            if (!hotkey) {
                button.textContent = 'Modifier required';
                setTimeout(() => {
                    if (_activeHotkeyCapture && _activeHotkeyCapture.button === button) {
                        button.textContent = 'Press keys…';
                    }
                }, 1000);
                return;
            }

            const field = button.dataset.hotkey;
            // Mark saved=true so endHotkeyCapture skips the resume call:
            // applyHotkey → update_config → re_register_hotkeys handles it.
            if (_activeHotkeyCapture) _activeHotkeyCapture.savedHotkey = true;
            endHotkeyCapture(false);
            button.textContent = formatKey(hotkey);
            await applyHotkey(field, hotkey);
        };

        _activeHotkeyCapture = { button, keyHandler, blurHandler, original, savedHotkey: false };
        window.addEventListener('keydown', keyHandler, true);
        button.addEventListener('blur', blurHandler);
        button.focus();
    }

    async function applyHotkey(field, value) {
        if (!config) return;
        if (!config.hotkeys) config.hotkeys = {};
        config.hotkeys[field] = value;
        await invoke('update_config', { config });
        // Re-render synchronously instead of waiting on the
        // config-changed event round-trip — that path can race with
        // the user's next action and leave the row showing the new
        // text but no reset icon until settings is reopened.
        renderHotkeyRows();
    }

    async function resetSingleHotkey(field) {
        const def = HOTKEY_DEFINITIONS.find(d => d.field === field);
        if (!def || !config) return;
        if (_activeHotkeyCapture) endHotkeyCapture(true);
        if (!config.hotkeys) config.hotkeys = {};
        if (config.hotkeys[field] === def.default) return;
        config.hotkeys[field] = def.default;
        await invoke('update_config', { config });
        renderHotkeyRows();
    }

    if (hotkeyList) {
        hotkeyList.addEventListener('click', (e) => {
            const resetTarget = e.target.closest('[data-reset-hotkey]');
            if (resetTarget) {
                e.stopPropagation();
                resetSingleHotkey(resetTarget.dataset.resetHotkey);
                return;
            }
            const btn = e.target.closest('.hotkey-btn');
            if (!btn) return;
            startHotkeyCapture(btn);
        });
    }

    if (btnResetHotkeys) {
        btnResetHotkeys.addEventListener('click', async () => {
            if (!config) return;
            if (_activeHotkeyCapture) endHotkeyCapture(true);
            const defaults = {};
            for (const def of HOTKEY_DEFINITIONS) defaults[def.field] = def.default;
            config.hotkeys = defaults;
            await invoke('update_config', { config });
            renderHotkeyRows();
        });
    }

    function openSettings() {
        if (config) {
            settingOntop.classList.toggle('active', config.window.always_on_top);
            settingLocked.classList.toggle('active', config.window.locked);
            settingOpacity.value = opacityToSlider(config.window.opacity);
            settingOpacityValue.textContent = Math.round(config.window.opacity * 100);
            renderHotkeyRows();
            settingHomeUrl.value = config.home_url || 'https://www.google.com';
            settingAutoRefresh.value = String(config.auto_refresh_minutes || 0);
        }
        settingsModal.classList.remove('hidden');
        settingsModal.classList.add('visible');
        modalOverlay.classList.add('visible');
    }

    function closeSettings() {
        if (_activeHotkeyCapture) endHotkeyCapture(true);
        settingsModal.classList.remove('visible');
        settingsModal.classList.add('hidden');
        modalOverlay.classList.remove('visible');
    }

    settingHomeUrl.addEventListener('change', async () => {
        if (config) {
            config.home_url = settingHomeUrl.value.trim() || 'https://www.google.com';
            await invoke('update_config', { config });
        }
    });

    settingOntop.addEventListener('click', async () => {
        const result = await invoke('toggle_always_on_top');
        settingOntop.classList.toggle('active', result);
        updatePinIcon(result);
        btnPin.classList.toggle('active', result);
    });

    settingLocked.addEventListener('click', async () => {
        const result = await invoke('toggle_locked');
        settingLocked.classList.toggle('active', result);
        updateLockIcon(result);
        btnLock.classList.toggle('active', result);
        if (result) {
            closeSettings();
            hideStrip();
            container.style.display = 'none';
        }
    });

    let _settingOpacityThrottle = null;
    settingOpacity.addEventListener('input', (e) => {
        const opacity = sliderToOpacity(parseInt(e.target.value, 10));
        settingOpacityValue.textContent = Math.round(opacity * 100);
        applyContentOpacity(opacity);
        if (_settingOpacityThrottle) return;
        _settingOpacityThrottle = setTimeout(() => { _settingOpacityThrottle = null; }, 32);
        invoke('set_opacity_live', { opacity });
    });

    settingOpacity.addEventListener('change', async (e) => {
        const opacity = sliderToOpacity(parseInt(e.target.value, 10));
        applyContentOpacity(opacity);
        await invoke('set_opacity', { opacity });
    });

    const settingAutoRefresh = settingsModal.querySelector('#setting-auto-refresh');
    settingAutoRefresh.addEventListener('change', async () => {
        if (config) {
            config.auto_refresh_minutes = parseInt(settingAutoRefresh.value, 10) || 0;
            await invoke('update_config', { config });
            startAutoRefresh(config.auto_refresh_minutes);
        }
    });

    btnClearRecent.addEventListener('click', async () => {
        if (config) {
            config.recent_urls = [];
            await invoke('update_config', { config });
            updateRecentDropdown();
        }
    });

    btnClearBookmarks.addEventListener('click', async () => {
        if (config) {
            config.bookmarks = [];
            await invoke('update_config', { config });
            updateBookmarksDropdown();
            updateBookmarkIcon();
        }
    });

    btnClearSiteData.addEventListener('click', async () => {
        try {
            localStorage.clear();
            sessionStorage.clear();
            document.cookie.split(';').forEach(c => {
                const name = c.replace(/^ +/, '').split('=')[0];
                document.cookie = name + '=;expires=' + new Date().toUTCString() + ';path=/';
            });
        } catch {}
        await invoke('clear_site_data');
        window.location.reload();
    });

    btnCloseSettings.addEventListener('click', closeSettings);
    settingsModal.querySelector('#btn-close-settings-x').addEventListener('click', closeSettings);
    modalOverlay.addEventListener('click', () => {
        if (tutorialActive) {
            dismissTutorial();
        } else {
            closeSettings();
        }
    });

    const ctxSettings = contextMenu.querySelector('#ctx-settings');
    const ctxOntop = contextMenu.querySelector('#ctx-ontop');
    const ctxLocked = contextMenu.querySelector('#ctx-locked');
    const ctxMinimize = contextMenu.querySelector('#ctx-minimize');
    const ctxClose = contextMenu.querySelector('#ctx-close');

    function showContextMenu(x, y) {
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        contextMenu.classList.add('visible');
    }

    function hideContextMenu() {
        contextMenu.classList.remove('visible');
    }

    strip.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.btn, .url-display, .opacity-slider')) return;
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY);
    });

    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });

    ctxSettings.addEventListener('click', () => {
        hideContextMenu();
        showStrip();
        openSettings();
    });

    ctxOntop.addEventListener('click', async () => {
        hideContextMenu();
        const result = await invoke('toggle_always_on_top');
        updatePinIcon(result);
        btnPin.classList.toggle('active', result);
    });

    ctxLocked.addEventListener('click', async () => {
        hideContextMenu();
        const result = await invoke('toggle_locked');
        updateLockIcon(result);
        btnLock.classList.toggle('active', result);
        if (result) {
            hideStrip();
            container.style.display = 'none';
        }
    });

    ctxMinimize.addEventListener('click', async () => {
        hideContextMenu();
        await invoke('minimize_window');
    });

    ctxClose.addEventListener('click', async () => {
        hideContextMenu();
        await invoke('save_window_geometry');
        await invoke('close_window');
        try { window.close(); } catch {}
    });

    btnMinimize.addEventListener('click', async () => {
        await invoke('minimize_window');
    });

    btnClose.addEventListener('click', async () => {
        await invoke('save_window_geometry');
        await invoke('close_window');
        try { window.close(); } catch {}
    });

    document.addEventListener('keydown', async (e) => {
        if (e.ctrlKey && e.key === 'l') {
            e.preventDefault();
            showStrip();
            urlInput.focus();
            urlInput.select();
        }
        if (e.key === 'Escape') {
            if (cropOverlayEl) {
                exitCropSelection();
            } else if (cropActive) {
                removeCrop();
            } else if (volumePopup.classList.contains('visible')) {
                hideVolumePopup();
            } else if (bookmarksDropdown.classList.contains('visible')) {
                bookmarksDropdown.classList.remove('visible');
            } else if (recentDropdown.classList.contains('visible')) {
                recentDropdown.classList.remove('visible');
            } else if (tutorialActive) {
                dismissTutorial();
            } else if (!settingsModal.classList.contains('hidden')) {
                closeSettings();
            } else if (stripVisible) {
                hideStrip();
                urlInput.blur();
            }
        }
    });

    let tutorialActive = false;

    async function dismissTutorial() {
        if (!tutorialActive) return;
        tutorialActive = false;
        tutorialModal.classList.remove('visible');
        tutorialModal.classList.add('hidden');
        modalOverlay.classList.remove('visible');
        if (config) {
            config.first_run = false;
            await invoke('update_config', { config });
        }
    }

    let _tutorialCurrentStep = 0;
    const _tutorialSteps = tutorialModal.querySelectorAll('.tutorial-step');

    function _tutorialGoToStep(n) {
        _tutorialSteps.forEach(s => s.classList.remove('active'));
        _tutorialSteps[n].classList.add('active');
        _tutorialCurrentStep = n;
    }

    tutorialModal.addEventListener('click', (e) => {
        const target = e.target;
        if (target.id === 'tutorial-next') {
            if (_tutorialCurrentStep < _tutorialSteps.length - 1) _tutorialGoToStep(_tutorialCurrentStep + 1);
        } else if (target.id === 'tutorial-back') {
            if (_tutorialCurrentStep > 0) _tutorialGoToStep(_tutorialCurrentStep - 1);
        } else if (target.id === 'tutorial-skip' || target.id === 'tutorial-finish') {
            dismissTutorial();
        }
    });

    function showTutorial() {
        tutorialActive = true;
        tutorialModal.classList.remove('hidden');
        tutorialModal.classList.add('visible');
        modalOverlay.classList.add('visible');
        _tutorialGoToStep(0);
    }

    // --------------------------------------------------------------------
    // [16] Error-page detection + auto-recovery
    // --------------------------------------------------------------------

    function isErrorPage() {
        try {
            const text = (document.body?.innerText || '').substring(0, 2000);
            const title = document.title || '';
            const patterns = [
                /ERR_(?:SSL_|CONNECTION_|NAME_NOT_RESOLVED|CERT_|TIMED_OUT|EMPTY_RESPONSE|FAILED|BLOCKED|TUNNEL_|NETWORK_|INTERNET_|ABORTED|ADDRESS_|INVALID)/,
                /can[\u2019']t reach this page/i,
                /this site can[\u2019']t be reached/i,
                /no internet/i,
                /refused to connect/i,
                /dns_probe_finished/i
            ];
            let matches = 0;
            for (const p of patterns) {
                if (p.test(text) || p.test(title)) matches++;
            }
            // Require 2+ matches, or a Chrome/Edge error title + 1 match.
            // Title patterns must be specific enough to avoid false-positives on
            // articles about errors (e.g. "Error Handling in Rust" on a tech blog).
            return matches >= 2 || (/^(This site can.t be reached|Can.t reach this page|No internet|DNS_PROBE_)/i.test(title) && matches >= 1);
        } catch { return false; }
    }

    // --------------------------------------------------------------------
    // [17] Config init + Rust->JS callback
    // --------------------------------------------------------------------

    async function initConfig() {
        try {
            config = await invoke('get_config');
            if (config) {
                updatePinIcon(config.window.always_on_top);
                btnPin.classList.toggle('active', config.window.always_on_top);
                updateLockIcon(config.window.locked);
                btnLock.classList.toggle('active', config.window.locked);
                opacitySlider.value = opacityToSlider(config.window.opacity);
                applyContentOpacity(config.window.opacity);
                updateRecentDropdown();
                updateBookmarkIcon();
                updateBookmarksDropdown();
                if (config.window.locked) {
                    hideStrip();
                    container.style.display = 'none';
                } else {
                    container.style.display = '';
                }

                if (config.first_run) {
                    showTutorial();
                }
                startAutoRefresh(config.auto_refresh_minutes || 0);
            }
        } catch (e) {
            console.warn('Failed to load config:', e);
        }

        // Detect error pages (SSL errors, connection failures, etc.)
        if (isErrorPage()) {
            console.warn('FloatView: error page detected');
            // Auto-redirect to home URL unless it's the one that failed
            const failedUrl = window.location.href;
            const homeUrl = config?.home_url;
            if (homeUrl && failedUrl !== homeUrl) {
                window.location.href = homeUrl;
                return;
            }
        }

        // Pre-fill URL bar with current page URL (prefer actual URL over config)
        const currentUrl = window.location.href;
        if (currentUrl && /^https?:\/\//i.test(currentUrl) && currentUrl !== 'about:blank') {
            urlInput.value = currentUrl;
            await invoke('set_url', { url: currentUrl });
        } else if (config && config.last_url) {
            urlInput.value = config.last_url;
        }

        updateBookmarkIcon();
        observeTitle();
        updateWindowTitle();

        if (config && config.crop) {
            applyCrop(config.crop.x, config.crop.y, config.crop.width, config.crop.height);
        }
    }

    // Global callback for Rust to update UI reliably via eval()
    window.__floatViewUpdate = function(key, value) {
        switch(key) {
            case 'always_on_top':
                updatePinIcon(value);
                btnPin.classList.toggle('active', value);
                if (config) config.window.always_on_top = value;
                break;
            case 'locked':
                updateLockIcon(value);
                btnLock.classList.toggle('active', value);
                if (value) {
                    hideStrip();
                    container.style.display = 'none';
                } else {
                    container.style.display = '';
                }
                if (config) config.window.locked = value;
                break;
            case 'opacity':
                opacitySlider.value = opacityToSlider(value);
                applyContentOpacity(value);
                if (config) config.window.opacity = value;
                break;
            case 'open_settings':
                container.style.display = '';
                showStrip();
                openSettings();
                break;
            case 'bookmarks':
                if (config) config.bookmarks = value;
                updateBookmarkIcon();
                updateBookmarksDropdown();
                break;
        }
    };

    // --------------------------------------------------------------------
    // [18] Tauri event listener setup
    // --------------------------------------------------------------------

    // Setup Tauri event listeners with retry for __TAURI__ availability on external pages
    let _tauriListenersReady = false;

    function setupTauriListeners() {
        if (_tauriListenersReady) return true;
        if (!window.__TAURI__?.event?.listen) return false;

        const listen = window.__TAURI__.event.listen;

        listen('opacity-changed', (event) => {
            opacitySlider.value = opacityToSlider(event.payload);
            applyContentOpacity(event.payload);
            if (config) {
                config.window.opacity = event.payload;
            }
        });

        listen('always-on-top-changed', (event) => {
            updatePinIcon(event.payload);
            btnPin.classList.toggle('active', event.payload);
            if (config) config.window.always_on_top = event.payload;
        });

        listen('locked-changed', (event) => {
            updateLockIcon(event.payload);
            btnLock.classList.toggle('active', event.payload);
            if (!event.payload) {
                container.style.display = '';
            } else {
                hideStrip();
                container.style.display = 'none';
            }
            if (config) config.window.locked = event.payload;
        });

        listen('config-changed', (event) => {
            config = event.payload;
            updateRecentDropdown();
            updateBookmarkIcon();
            updateBookmarksDropdown();
            // Keep the rebinding UI in sync if the modal is open and the
            // change came from somewhere other than the click-to-capture
            // flow (e.g. external config edit, reset button).
            if (!settingsModal.classList.contains('hidden')) {
                renderHotkeyRows();
            }
        });

        listen('open-settings', () => {
            container.style.display = '';
            showStrip();
            openSettings();
        });

        listen('update-install-status', (event) => {
            const message = String(event.payload || '');
            updateStatus.className = message.toLowerCase().includes('failed')
                ? 'update-status error'
                : 'update-status';
            updateStatus.textContent = message;
        });

        // Background 24h checker fires this when it finds an update.
        // Flip the settings button into Install mode so the user can
        // kick off install without re-running a check first.
        listen('update-available', (event) => {
            const payload = event.payload || {};
            if (payload.version) {
                setUpdateMode('install', { version: String(payload.version) });
            }
        });

        // Progress updates during install. Only meaningful when the
        // settings modal is open and we're in 'busy' mode.
        listen('update-progress', (event) => {
            if (_updateMode !== 'busy') return;
            const p = event.payload || {};
            const total = Number(p.total) || 0;
            const done = Number(p.downloaded) || 0;
            if (total > 0) {
                const pct = Math.floor((done / total) * 100);
                setInner(updateStatus,
                    '<span class="update-spinner"></span>Downloading ' + pct + '%');
            }
        });

        _tauriListenersReady = true;
        return true;
    }

    // Try immediately, then poll for __TAURI__ availability
    if (!setupTauriListeners()) {
        let _attempts = 0;
        const _poll = setInterval(() => {
            if (setupTauriListeners() || ++_attempts >= 100) {
                clearInterval(_poll);
            }
        }, 50);
    }

    // --------------------------------------------------------------------
    // [19] Container placement: re-prepend + fullscreen reparenting
    //
    // Two separate concerns share a home here:
    //
    // (a) SPA DOM wipes can remove `#floatview-root`. A MutationObserver
    //     on body watches for this and re-prepends.
    //
    // (b) When a page enters the Fullscreen API (YouTube's F key,
    //     Plex's theater fullscreen, etc.), ONLY the fullscreen element
    //     and its descendants are visible — z-index tricks cannot
    //     escape this. If our container stays on body, the strip +
    //     hotzone are invisible and the user is stuck. To avoid that,
    //     reparent into the fullscreen element on entry and restore on
    //     exit. Works because our container is `position: fixed` and
    //     sizes to the viewport regardless of parent.
    // --------------------------------------------------------------------

    // Who the container "belongs to" right now. Tracked so the observer
    // below and the fullscreen listener agree on what counts as
    // "displaced" vs. "intentional placement."
    function containerHome() {
        return document.fullscreenElement || document.body;
    }

    function reparentContainer() {
        const home = containerHome();
        if (!home) return;
        if (container.parentNode === home) return;
        // Crop is in the middle of transforming body; don't yank the
        // container mid-animation. The MutationObserver will retry
        // after the transition settles.
        if (cropActive && home === document.body) return;
        home.prepend(container);
    }

    document.addEventListener('fullscreenchange', reparentContainer);

    let _observerPending = false;
    const observer = new MutationObserver(() => {
        if (_observerPending || cropActive) return;
        const home = containerHome();
        if (!home || home.contains(container)) return;
        _observerPending = true;
        Promise.resolve().then(() => {
            _observerPending = false;
            const h = containerHome();
            if (h && !h.contains(container)) {
                h.prepend(container);
            }
        });
    });

    // --------------------------------------------------------------------
    // [20] DOM-ready init polling
    // --------------------------------------------------------------------

    // Aggressive init: poll with setInterval instead of waiting for DOMContentLoaded.
    // setInterval fires even when the page is stuck loading (unlike rAF which needs paint
    // and DOMContentLoaded which needs all scripts/stylesheets parsed).
    let _initialized = false;
    function tryInit() {
        if (_initialized) return true;
        if (!document.body) return false;
        document.body.prepend(container);
        observer.observe(document.body, { childList: true, subtree: true });
        initConfig();
        _initialized = true;
        return true;
    }

    if (!tryInit()) {
        const pollTimer = setInterval(() => {
            if (tryInit()) clearInterval(pollTimer);
        }, 50);
        document.addEventListener('DOMContentLoaded', () => {
            clearInterval(pollTimer);
            tryInit();
        });
        setTimeout(() => clearInterval(pollTimer), 30000);
    }

    window.addEventListener('pageshow', () => {
        if (document.body && !document.body.contains(container)) {
            document.body.prepend(container);
        }
    });

    console.log('FloatView: Control strip initialized');
})();
