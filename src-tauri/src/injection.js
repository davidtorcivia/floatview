(function() {
    'use strict';

    if (window.__floatViewInitialized) return;
    window.__floatViewInitialized = true;

    const DRAG_BAR_HEIGHT = 10;
    const HOTZONE_HEIGHT = 32;
    const STRIP_HEIGHT = 48;
    const DWELL_DELAY = 100;
    const HIDE_DELAY = 300;

    let stripVisible = false;
    let dwellTimer = null;
    let hideTimer = null;
    let config = null;

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
            background: linear-gradient(to bottom, rgba(120, 120, 120, 0.6), transparent);
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
        }

        .strip {
            position: fixed;
            top: ${DRAG_BAR_HEIGHT}px;
            left: 0;
            right: 0;
            height: ${STRIP_HEIGHT}px;
            background: rgba(24, 24, 24, 0.95);
            display: flex;
            align-items: center;
            padding: 0 12px;
            gap: 6px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            color: #fff;
            transform: translateY(-${STRIP_HEIGHT + DRAG_BAR_HEIGHT}px);
            transition: transform 0.12s ease-out;
            pointer-events: auto;
            user-select: none;
            -webkit-app-region: no-drag;
            border-bottom: 1px solid rgba(255,255,255,0.08);
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            z-index: 2147483647;
        }

        .strip.visible {
            transform: translateY(0);
        }

        .btn {
            -webkit-app-region: no-drag;
            background: transparent;
            border: none;
            color: #ccc;
            min-width: 44px;
            height: 44px;
            padding: 0;
            border-radius: 6px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.1s;
        }

        .btn svg {
            width: 22px;
            height: 22px;
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
            background: rgba(66, 133, 244, 0.5);
            color: #fff;
        }

        .btn:active {
            background: rgba(255,255,255,0.2);
        }

        .url-display {
            -webkit-app-region: no-drag;
            flex: 1;
            min-width: 0;
            min-height: 44px;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.1);
            color: #fff;
            padding: 0 14px;
            border-radius: 6px;
            font-size: 13px;
            font-family: inherit;
            outline: none;
        }

        .url-display:focus {
            background: rgba(255,255,255,0.12);
            border-color: rgba(66, 133, 244, 0.5);
        }

        .url-display::placeholder {
            color: rgba(255,255,255,0.4);
        }

        .opacity-slider {
            -webkit-app-region: no-drag;
            width: 80px;
            height: 44px;
            padding: 0 4px;
            -webkit-appearance: none;
            background: transparent;
            outline: none;
        }

        .opacity-slider::-webkit-slider-runnable-track {
            height: 4px;
            background: rgba(255,255,255,0.2);
            border-radius: 2px;
        }

        .opacity-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 18px;
            height: 18px;
            background: #fff;
            border-radius: 50%;
            cursor: pointer;
            margin-top: -7px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }

        .divider {
            width: 1px;
            height: 28px;
            background: rgba(255,255,255,0.15);
            margin: 0 4px;
        }

        .recent-container {
            position: relative;
            -webkit-app-region: no-drag;
        }

        .recent-dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            margin-top: 8px;
            background: rgba(30, 30, 30, 0.98);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            min-width: 240px;
            max-width: 360px;
            max-height: 280px;
            overflow-y: auto;
            display: none;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        }

        .recent-dropdown.visible {
            display: block;
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
            transform: translate(-50%, -50%);
            background: rgba(28, 28, 28, 0.98);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 12px;
            padding: 24px;
            min-width: 360px;
            max-width: 440px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 12px 48px rgba(0,0,0,0.6);
            z-index: 2147483647;
            pointer-events: auto;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #fff;
        }

        .settings-modal.hidden {
            display: none;
        }

        .settings-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 20px;
            padding-bottom: 16px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
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
            background: rgba(66, 133, 244, 0.8);
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
            height: 6px;
            -webkit-appearance: none;
            background: rgba(255,255,255,0.2);
            border-radius: 3px;
            outline: none;
        }

        .settings-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 20px;
            height: 20px;
            background: #fff;
            border-radius: 50%;
            cursor: pointer;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }

        .settings-btn {
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.15);
            color: #fff;
            padding: 10px 20px;
            border-radius: 6px;
            font-size: 14px;
            font-family: inherit;
            cursor: pointer;
            transition: background 0.1s;
            min-height: 44px;
        }

        .settings-btn:hover {
            background: rgba(255,255,255,0.15);
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
            justify-content: flex-end;
            gap: 10px;
        }

        .context-menu {
            position: fixed;
            background: rgba(30, 30, 30, 0.98);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 8px;
            min-width: 180px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            z-index: 2147483647;
            pointer-events: auto;
            display: none;
            padding: 6px 0;
        }

        .context-menu.visible {
            display: block;
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
            background: rgba(0,0,0,0.6);
            z-index: 2147483646;
            pointer-events: auto;
            display: none;
        }

        .modal-overlay.visible {
            display: block;
        }

        .hotkey-info {
            font-size: 12px;
            color: rgba(255,255,255,0.4);
            margin-top: 12px;
            line-height: 1.6;
        }

        .hotkey-info kbd {
            background: rgba(255,255,255,0.1);
            padding: 3px 8px;
            border-radius: 4px;
            font-family: 'SF Mono', Monaco, monospace;
            font-size: 11px;
            margin: 0 2px;
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
        pin: `<svg viewBox="0 0 24 24"><path d="M12 2L12 8M12 8L8 12M12 8L16 12M8 12L4 16L8 20L12 16L16 20L20 16L16 12L12 16L8 12" stroke-linejoin="round"/></svg>`,
        pinActive: `<svg viewBox="0 0 24 24"><path d="M12 2L12 8M12 8L8 12M12 8L16 12M8 12L4 16L8 20L12 16L16 20L20 16L16 12L12 16L8 12" fill="currentColor" stroke-linejoin="round"/></svg>`,
        recent: `<svg viewBox="0 0 24 24"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg>`,
        lock: `<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
        lockActive: `<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" fill="currentColor"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
        settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
        minimize: `<svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
        close: `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        home: `<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    };

    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.innerHTML = `
        <button class="btn" id="btn-pin" title="Always on Top (Alt+Shift+T)">${icons.pin}</button>
        <div class="recent-container">
            <button class="btn" id="btn-recent" title="Recent URLs">${icons.recent}</button>
            <div class="recent-dropdown" id="recent-dropdown"></div>
        </div>
        <button class="btn" id="btn-home" title="Go Home">${icons.home}</button>
        <input type="text" class="url-display" id="url-input" placeholder="Enter URL to load...">
        <button class="btn" id="btn-lock" title="Click-through mode (Alt+Shift+D)">${icons.lock}</button>
        <div class="divider"></div>
        <input type="range" class="opacity-slider" id="opacity-slider" min="10" max="100" value="100" title="Opacity">
        <button class="btn" id="btn-settings" title="Settings">${icons.settings}</button>
        <button class="btn" id="btn-minimize" title="Minimize">${icons.minimize}</button>
        <button class="btn" id="btn-close" title="Close">${icons.close}</button>
    `;
    shadow.appendChild(strip);

    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'modal-overlay';
    shadow.appendChild(modalOverlay);

    const settingsModal = document.createElement('div');
    settingsModal.className = 'settings-modal hidden';
    settingsModal.innerHTML = `
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
        </div>

        <div class="settings-section">
            <div class="settings-section-title">Keyboard Shortcuts</div>
            <div class="settings-row">
                <span class="settings-label">Toggle Always on Top</span>
                <span class="settings-value" id="hotkey-ontop">Alt+Shift+T</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Toggle Click-Through</span>
                <span class="settings-value" id="hotkey-locked">Alt+Shift+D</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Opacity Up/Down</span>
                <span class="settings-value">Alt+Shift+Up/Down</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">Show/Hide Window</span>
                <span class="settings-value" id="hotkey-visibility">Alt+Shift+H</span>
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
        </div>

        <div class="hotkey-info">
            Tip: Use <kbd>Ctrl+L</kbd> to show the control bar and focus the URL input.
        </div>

        <div class="settings-footer">
            <button class="settings-btn" id="btn-close-settings">Close</button>
        </div>
    `;
    shadow.appendChild(settingsModal);

    const contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.innerHTML = `
        <div class="context-menu-item" id="ctx-settings">${icons.settings}Settings</div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" id="ctx-ontop">${icons.pin}Toggle Always on Top</div>
        <div class="context-menu-item" id="ctx-locked">${icons.lock}Toggle Click-Through</div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" id="ctx-minimize">${icons.minimize}Minimize</div>
        <div class="context-menu-item" id="ctx-close">${icons.close}Close</div>
    `;
    shadow.appendChild(contextMenu);

    const btnPin = strip.querySelector('#btn-pin');
    const btnRecent = strip.querySelector('#btn-recent');
    const recentDropdown = strip.querySelector('#recent-dropdown');
    const urlInput = strip.querySelector('#url-input');
    const btnLock = strip.querySelector('#btn-lock');
    const opacitySlider = strip.querySelector('#opacity-slider');
    const btnSettings = strip.querySelector('#btn-settings');
    const btnHome = strip.querySelector('#btn-home');
    const btnMinimize = strip.querySelector('#btn-minimize');
    const btnClose = strip.querySelector('#btn-close');

    function updateRecentDropdown() {
        if (!config || !config.recent_urls || config.recent_urls.length === 0) {
            recentDropdown.innerHTML = '<div class="recent-empty">No recent URLs</div>';
            return;
        }

        const currentUrl = window.location.href;
        recentDropdown.innerHTML = config.recent_urls.map(url => {
            const isCurrent = url === currentUrl;
            return `<div class="recent-item${isCurrent ? ' current' : ''}" data-url="${url}">${url}</div>`;
        }).join('');

        recentDropdown.querySelectorAll('.recent-item').forEach(item => {
            item.addEventListener('click', async () => {
                const url = item.dataset.url;
                if (url && !item.classList.contains('current')) {
                    await invoke('set_url', { url });
                    window.location.href = url;
                }
            });
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
        strip.classList.remove('visible');
    }

    function scheduleHide() {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            hideTimer = null;
            if (!settingsModal.classList.contains('hidden') ||
                recentDropdown.classList.contains('visible')) {
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

    // Drag bar events
    dragBar.addEventListener('mousedown', (e) => {
        if (window.__TAURI__?.window) {
            const win = window.__TAURI__.window.getCurrentWindow();
            win.startDragging();
        }
    });

    dragBar.addEventListener('dblclick', () => {
        invoke('maximize_toggle');
    });

    dragBar.addEventListener('mouseenter', () => {
        cancelHide();
    });

    // Allow dragging from the hotzone (much larger target than the drag bar)
    hotzone.addEventListener('mousedown', (e) => {
        if (window.__TAURI__?.window) {
            window.__TAURI__.window.getCurrentWindow().startDragging();
        }
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
            recentDropdown.classList.contains('visible')) {
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

    // Allow dragging from non-interactive areas of the control strip
    strip.addEventListener('mousedown', (e) => {
        if (e.target.closest('.btn, .url-display, .opacity-slider, .recent-container, input, button')) return;
        if (window.__TAURI__?.window) {
            window.__TAURI__.window.getCurrentWindow().startDragging();
        }
    });

    btnRecent.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = recentDropdown.classList.contains('visible');
        recentDropdown.classList.toggle('visible', !isVisible);
        if (!isVisible) {
            updateRecentDropdown();
        }
    });

    document.addEventListener('click', (e) => {
        if (!strip.contains(e.target)) {
            recentDropdown.classList.remove('visible');
        }
    });

    recentDropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    async function invoke(cmd, args = {}) {
        if (!window.__TAURI__?.core) {
            // Wait for __TAURI__ to become available (race condition on external pages)
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 50));
                if (window.__TAURI__?.core) break;
            }
        }
        if (window.__TAURI__?.core) {
            return window.__TAURI__.core.invoke(cmd, args);
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

    urlInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            let url = urlInput.value.trim();
            if (url && !url.match(/^https?:\/\//)) {
                url = 'https://' + url;
            }
            if (url) {
                await invoke('set_url', { url });
                window.location.href = url;
            }
        }
    });

    btnHome.addEventListener('click', async () => {
        await invoke('navigate_home');
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

    opacitySlider.addEventListener('input', async (e) => {
        const opacity = parseInt(e.target.value, 10) / 100;
        await invoke('set_opacity', { opacity });
    });

    btnSettings.addEventListener('click', async () => {
        openSettings();
    });

    const settingOntop = settingsModal.querySelector('#setting-ontop');
    const settingLocked = settingsModal.querySelector('#setting-locked');
    const settingOpacity = settingsModal.querySelector('#setting-opacity');
    const settingOpacityValue = settingsModal.querySelector('#setting-opacity-value');
    const settingHomeUrl = settingsModal.querySelector('#setting-home-url');
    const btnClearRecent = settingsModal.querySelector('#btn-clear-recent');
    const btnCloseSettings = settingsModal.querySelector('#btn-close-settings');
    const hotkeyOntop = settingsModal.querySelector('#hotkey-ontop');
    const hotkeyLocked = settingsModal.querySelector('#hotkey-locked');
    const hotkeyVisibility = settingsModal.querySelector('#hotkey-visibility');

    function openSettings() {
        if (config) {
            settingOntop.classList.toggle('active', config.window.always_on_top);
            settingLocked.classList.toggle('active', config.window.locked);
            settingOpacity.value = Math.round(config.window.opacity * 100);
            settingOpacityValue.textContent = Math.round(config.window.opacity * 100);
            if (config.hotkeys) {
                hotkeyOntop.textContent = config.hotkeys.toggle_on_top || 'Alt+Shift+T';
                hotkeyLocked.textContent = config.hotkeys.toggle_locked || 'Alt+Shift+D';
                hotkeyVisibility.textContent = config.hotkeys.toggle_visibility || 'Alt+Shift+H';
            }
            settingHomeUrl.value = config.home_url || 'https://www.google.com';
        }
        settingsModal.classList.remove('hidden');
        modalOverlay.classList.add('visible');
    }

    function closeSettings() {
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

    settingOpacity.addEventListener('input', async (e) => {
        const opacity = parseInt(e.target.value, 10) / 100;
        settingOpacityValue.textContent = e.target.value;
        await invoke('set_opacity', { opacity });
    });

    btnClearRecent.addEventListener('click', async () => {
        if (config) {
            config.recent_urls = [];
            await invoke('update_config', { config });
            updateRecentDropdown();
        }
    });

    btnCloseSettings.addEventListener('click', closeSettings);
    modalOverlay.addEventListener('click', closeSettings);

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
        if (e.target.closest('.btn, .url-display, .opacity-slider, .recent-dropdown')) return;
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
    });

    btnMinimize.addEventListener('click', async () => {
        await invoke('minimize_window');
    });

    btnClose.addEventListener('click', async () => {
        await invoke('save_window_geometry');
        await invoke('close_window');
    });

    document.addEventListener('keydown', async (e) => {
        if (e.ctrlKey && e.key === 'l') {
            e.preventDefault();
            showStrip();
            urlInput.focus();
            urlInput.select();
        }
        if (e.key === 'Escape') {
            if (stripVisible) {
                hideStrip();
                urlInput.blur();
            }
            closeSettings();
        }
    });

    async function initConfig() {
        try {
            config = await invoke('get_config');
            if (config) {
                updatePinIcon(config.window.always_on_top);
                btnPin.classList.toggle('active', config.window.always_on_top);
                updateLockIcon(config.window.locked);
                btnLock.classList.toggle('active', config.window.locked);
                opacitySlider.value = Math.round(config.window.opacity * 100);
                updateRecentDropdown();
            }
        } catch (e) {
            console.warn('Failed to load config:', e);
        }

        // Pre-fill URL bar with current page URL (prefer actual URL over config)
        const currentUrl = window.location.href;
        if (currentUrl && !currentUrl.startsWith('tauri://') && currentUrl !== 'about:blank') {
            urlInput.value = currentUrl;
        } else if (config && config.last_url) {
            urlInput.value = config.last_url;
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
                opacitySlider.value = Math.round(value * 100);
                if (config) config.window.opacity = value;
                break;
            case 'open_settings':
                container.style.display = '';
                showStrip();
                openSettings();
                break;
        }
    };

    // Setup Tauri event listeners with retry for __TAURI__ availability on external pages
    let _tauriListenersReady = false;

    function setupTauriListeners() {
        if (_tauriListenersReady) return true;
        if (!window.__TAURI__?.event?.listen) return false;

        const listen = window.__TAURI__.event.listen;

        listen('save-state', async () => {
            await invoke('save_window_geometry');
        });

        listen('opacity-changed', (event) => {
            opacitySlider.value = Math.round(event.payload * 100);
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
        });

        listen('open-settings', () => {
            container.style.display = '';
            showStrip();
            openSettings();
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

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.removedNodes) {
                if (node === container || container.contains(node)) {
                    if (document.body) document.body.prepend(container);
                    return;
                }
            }
        }
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
