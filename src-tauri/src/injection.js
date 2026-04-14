(function() {
    'use strict';

    if (window.__floatViewInitialized) return;
    window.__floatViewInitialized = true;

    const DRAG_BAR_HEIGHT = 10;
    const HOTZONE_HEIGHT = 32;
    const STRIP_HEIGHT = 48;
    const DWELL_DELAY = 100;
    const HIDE_DELAY = 300;
    const IS_MAC = navigator.platform.includes('Mac');
    const COMMAND_TOKEN = '__FLOATVIEW_COMMAND_TOKEN__';
    const EMBEDDED_HOME_URL = '__FLOATVIEW_HOME_URL__';

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

    // Track most recently interacted media element for global hotkeys
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
        document.querySelectorAll('video, audio').forEach(attach);
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
        if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    })();

    const container = document.createElement('div');
    container.id = 'floatview-root';
    container.style.cssText = 'position:fixed;top:0;left:0;right:0;height:0;z-index:2147483647;pointer-events:none;';

    const shadow = container.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
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
            transition: all 0.1s;
        }

        .btn svg {
            width: 16px;
            height: 16px;
            stroke: currentColor;
            fill: none;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
        }

        .btn:hover {
            background: rgba(255,255,255,0.1);
            color: #fff;
        }

        .btn.active {
            background: rgba(200, 140, 80, 0.4);
            color: #e8b87a;
        }

        .btn:active {
            background: rgba(255,255,255,0.2);
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
        }

        .url-display:focus {
            background: rgba(255,255,255,0.12);
            border-color: rgba(200, 140, 80, 0.5);
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
            transition: background 0.1s;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }

        .recent-item:last-child {
            border-bottom: none;
        }

        .recent-item:hover {
            background: rgba(255,255,255,0.08);
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
            transform: translate(-50%, -50%) scale(0.96);
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
            transition: opacity 0.2s ease-out, transform 0.2s ease-out;
        }

        .settings-modal.visible {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
            pointer-events: auto;
        }

        .settings-modal.hidden {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.96);
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

        .toggle-switch {
            position: relative;
            width: 50px;
            height: 28px;
            background: rgba(255,255,255,0.15);
            border-radius: 14px;
            cursor: pointer;
            transition: background 0.2s;
        }

        .toggle-switch.active {
            background: rgba(52, 199, 89, 0.9);
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
            transition: transform 0.2s;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }

        .toggle-switch.active::after {
            transform: translateX(22px);
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
            transition: all 0.15s ease;
            min-height: 44px;
        }

        .settings-btn:hover {
            background: rgba(255,255,255,0.12);
            border-color: rgba(255,255,255,0.2);
        }

        .settings-btn.danger {
            background: rgba(244, 67, 54, 0.2);
            border-color: rgba(244, 67, 54, 0.4);
        }

        .settings-btn.danger:hover {
            background: rgba(244, 67, 54, 0.35);
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
            transition: background 0.1s;
            display: flex;
            align-items: center;
            gap: 10px;
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
        }

        .context-menu-item:hover {
            background: rgba(255,255,255,0.08);
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
            backdrop-filter: blur(2px);
            -webkit-backdrop-filter: blur(2px);
            z-index: 2147483646;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s ease-out;
        }

        .modal-overlay.visible {
            opacity: 1;
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
            transform: translate(-50%, -50%) scale(0.96);
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
            transition: opacity 0.2s ease-out, transform 0.2s ease-out;
        }

        .tutorial-modal.visible {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
            pointer-events: auto;
        }

        .tutorial-modal.hidden {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.96);
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
            transition: background 0.2s;
        }

        .tutorial-dot.active {
            background: rgba(200, 140, 80, 0.7);
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
            display: grid;
            grid-template-columns: repeat(3, 36px);
            grid-template-rows: repeat(2, 28px);
            gap: 4px;
        }

        .snap-popup.visible {
            opacity: 1;
            transform: translateY(0) scale(1);
            pointer-events: auto;
        }

        .snap-cell {
            background: rgba(255,255,255,0.06);
            border: none;
            border-radius: 6px;
            cursor: pointer;
            color: rgba(255,255,255,0.5);
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.1s;
            padding: 0;
        }

        .snap-cell:hover {
            background: rgba(200, 140, 80, 0.3);
            color: #fff;
        }

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
    `;
    shadow.appendChild(style);

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
    };

    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.innerHTML = `
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
        <div class="divider"></div>
        <input type="range" class="opacity-slider" id="opacity-slider" min="10" max="100" value="100" title="Opacity">
        <button class="btn" id="btn-settings" title="Settings">${icons.settings}</button>
        <button class="btn" id="btn-minimize" title="Minimize">${icons.minimize}</button>
        <button class="btn" id="btn-close" title="Close">${icons.close}</button>
    `;
    shadow.appendChild(strip);

    const recentDropdown = document.createElement('div');
    recentDropdown.className = 'recent-dropdown';
    recentDropdown.id = 'recent-dropdown';
    shadow.appendChild(recentDropdown);

    const bookmarksDropdown = document.createElement('div');
    bookmarksDropdown.className = 'recent-dropdown';
    bookmarksDropdown.id = 'bookmarks-dropdown';
    shadow.appendChild(bookmarksDropdown);

    const snapPopup = document.createElement('div');
    snapPopup.className = 'snap-popup';
    snapPopup.innerHTML = `
        <button class="snap-cell" data-pos="top-left" title="Top Left">&#8598;</button>
        <button class="snap-cell" data-pos="center" title="Center">&#9678;</button>
        <button class="snap-cell" data-pos="top-right" title="Top Right">&#8599;</button>
        <button class="snap-cell" data-pos="bottom-left" title="Bottom Left">&#8601;</button>
        <button class="snap-cell" data-pos="bottom-right" title="Bottom Right" style="grid-column:3;">&#8600;</button>
    `;
    shadow.appendChild(snapPopup);

    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'modal-overlay';
    shadow.appendChild(modalOverlay);

    const settingsModal = document.createElement('div');
    settingsModal.className = 'settings-modal hidden';
    settingsModal.innerHTML = `
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
            <div class="settings-row">
                <span class="settings-label">Toggle Always on Top</span>
                <span class="settings-value" id="hotkey-ontop">${formatKey('Alt+Shift+T')}</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Toggle Click-Through</span>
                <span class="settings-value" id="hotkey-locked">${formatKey('Alt+Shift+D')}</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Opacity Up/Down</span>
                <span class="settings-value" id="hotkey-opacity">${formatKey('Alt+Shift+Up/Down')}</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Show/Hide Window</span>
                <span class="settings-value" id="hotkey-visibility">${formatKey('Alt+Shift+H')}</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Play/Pause Media</span>
                <span class="settings-value" id="hotkey-playpause">${formatKey('Alt+Shift+P')}</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Skip Forward</span>
                <span class="settings-value" id="hotkey-next">${formatKey('Alt+Shift+Right')}</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Skip Back</span>
                <span class="settings-value" id="hotkey-previous">${formatKey('Alt+Shift+Left')}</span>
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
    `;
    shadow.appendChild(settingsModal);

    const tutorialModal = document.createElement('div');
    tutorialModal.className = 'tutorial-modal hidden';
    tutorialModal.innerHTML = `
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
    `;
    shadow.appendChild(tutorialModal);

    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.innerHTML = `
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
    `;
    shadow.appendChild(contextMenu);

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

    // Auto-refresh timer
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

    // Crop/zoom state
    let cropActive = false;
    let cropOverlayEl = null;

    function enterCropSelection() {
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

    function applyCrop(x, y, w, h, animate) {
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
        if (animate) {
            invoke('set_crop', { x, y, width: w, height: h });
        }
    }

    function removeCrop() {
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
        invoke('clear_crop');
    }

    window.addEventListener('resize', () => {
        if (cropActive && config && config.crop) {
            applyCrop(config.crop.x, config.crop.y, config.crop.width, config.crop.height);
        }
    });

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
                bookmarksDropdown.classList.contains('visible')) {
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
        btnPin.innerHTML = isActive ? icons.pinActive : icons.pin;
    }

    function updateLockIcon(isLocked) {
        btnLock.innerHTML = isLocked ? icons.lockActive : icons.lock;
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
            bookmarksDropdown.classList.contains('visible')) {
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
    });

    recentDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });

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
        invoke('set_opacity_live', { opacity });
    });

    opacitySlider.addEventListener('change', async (e) => {
        const opacity = sliderToOpacity(parseInt(e.target.value, 10));
        await invoke('set_opacity', { opacity });
    });

    btnSettings.addEventListener('click', async () => {
        openSettings();
    });

    // Snap popup
    function positionSnapPopup() {
        const rect = btnSnap.getBoundingClientRect();
        snapPopup.style.top = (rect.bottom + 8) + 'px';
        snapPopup.style.left = rect.left + 'px';
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
        const pos = e.target.dataset.pos;
        if (pos) {
            snapPopup.classList.remove('visible');
            await invoke('snap_window', { position: pos });
            snapFlash();
        }
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

    // Crop button
    btnCrop.addEventListener('click', () => {
        if (cropActive) {
            removeCrop();
        } else {
            enterCropSelection();
        }
    });

    // Navigation buttons
    btnBack.addEventListener('click', () => { window.history.back(); });
    btnForward.addEventListener('click', () => { window.history.forward(); });
    btnRefresh.addEventListener('click', () => { window.location.reload(); });

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
        btnBookmark.innerHTML = active ? icons.bookmarkActive : icons.bookmark;
        btnBookmark.classList.toggle('active', active);
    }

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

    btnBookmark.addEventListener('click', async (e) => {
        e.stopPropagation();
        const currentUrl = window.location.href;
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

    // Window title observer
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
    const hotkeyOntop = settingsModal.querySelector('#hotkey-ontop');
    const hotkeyLocked = settingsModal.querySelector('#hotkey-locked');
    const hotkeyOpacity = settingsModal.querySelector('#hotkey-opacity');
    const hotkeyVisibility = settingsModal.querySelector('#hotkey-visibility');
    const hotkeyPlayPause = settingsModal.querySelector('#hotkey-playpause');
    const hotkeyNext = settingsModal.querySelector('#hotkey-next');
    const hotkeyPrevious = settingsModal.querySelector('#hotkey-previous');
    const btnCheckUpdates = settingsModal.querySelector('#btn-check-updates');
    const updateStatus = settingsModal.querySelector('#update-status');
    const settingsVersion = settingsModal.querySelector('#settings-version');

    // Load version into settings footer
    (async () => {
        const version = await invoke('get_version');
        if (version) settingsVersion.textContent = 'FloatView v' + version;
    })();

    btnCheckUpdates.addEventListener('click', async () => {
        btnCheckUpdates.disabled = true;
        updateStatus.className = 'update-status';
        updateStatus.innerHTML = '<span class="update-spinner"></span>Checking...';
        try {
            const result = await invoke('check_for_updates');
            if (result) {
                updateStatus.className = 'update-status available';
                updateStatus.textContent = 'v' + result.version + ' available. Install from tray menu.';
            } else {
                updateStatus.className = 'update-status';
                updateStatus.textContent = 'You\'re up to date!';
            }
        } catch (e) {
            updateStatus.className = 'update-status error';
            updateStatus.textContent = 'Check failed: ' + e;
        } finally {
            btnCheckUpdates.disabled = false;
        }
    });

    function openSettings() {
        if (config) {
            settingOntop.classList.toggle('active', config.window.always_on_top);
            settingLocked.classList.toggle('active', config.window.locked);
            settingOpacity.value = opacityToSlider(config.window.opacity);
            settingOpacityValue.textContent = Math.round(config.window.opacity * 100);
            if (config.hotkeys) {
                hotkeyOntop.textContent = formatKey(config.hotkeys.toggle_on_top || 'Alt+Shift+T');
                hotkeyLocked.textContent = formatKey(config.hotkeys.toggle_locked || 'Alt+Shift+D');
                hotkeyOpacity.textContent = formatKey(
                    (config.hotkeys.opacity_up || 'Alt+Shift+Up') +
                    '/' +
                    (config.hotkeys.opacity_down || 'Alt+Shift+Down')
                );
                hotkeyVisibility.textContent = formatKey(config.hotkeys.toggle_visibility || 'Alt+Shift+H');
                hotkeyPlayPause.textContent = formatKey(config.hotkeys.media_play_pause || 'Alt+Shift+P');
                hotkeyNext.textContent = formatKey(config.hotkeys.media_next || 'Alt+Shift+Right');
                hotkeyPrevious.textContent = formatKey(config.hotkeys.media_previous || 'Alt+Shift+Left');
            }
            settingHomeUrl.value = config.home_url || 'https://www.google.com';
            settingAutoRefresh.value = String(config.auto_refresh_minutes || 0);
        }
        settingsModal.classList.remove('hidden');
        settingsModal.classList.add('visible');
        modalOverlay.classList.add('visible');
    }

    function closeSettings() {
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
        if (_settingOpacityThrottle) return;
        _settingOpacityThrottle = setTimeout(() => { _settingOpacityThrottle = null; }, 32);
        invoke('set_opacity_live', { opacity });
    });

    settingOpacity.addEventListener('change', async (e) => {
        const opacity = sliderToOpacity(parseInt(e.target.value, 10));
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
            // Require at least 2 matches, or a definitive error title plus 1 match
            return matches >= 2 || (/^(This site can.t be reached|Can.t reach this page|Error|Http Error)/i.test(title) && matches >= 1);
        } catch { return false; }
    }

    async function initConfig() {
        try {
            config = await invoke('get_config');
            if (config) {
                updatePinIcon(config.window.always_on_top);
                btnPin.classList.toggle('active', config.window.always_on_top);
                updateLockIcon(config.window.locked);
                btnLock.classList.toggle('active', config.window.locked);
                opacitySlider.value = opacityToSlider(config.window.opacity);
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

    // Setup Tauri event listeners with retry for __TAURI__ availability on external pages
    let _tauriListenersReady = false;

    function setupTauriListeners() {
        if (_tauriListenersReady) return true;
        if (!window.__TAURI__?.event?.listen) return false;

        const listen = window.__TAURI__.event.listen;

        listen('opacity-changed', (event) => {
            opacitySlider.value = opacityToSlider(event.payload);
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

    let _observerPending = false;
    const observer = new MutationObserver(() => {
        if (_observerPending || cropActive) return;
        if (!document.body || document.body.contains(container)) return;
        _observerPending = true;
        Promise.resolve().then(() => {
            _observerPending = false;
            if (document.body && !document.body.contains(container)) {
                document.body.prepend(container);
            }
        });
    });

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
