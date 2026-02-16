# FloatView

A lightweight, always-on-top floating browser window built for streaming media. Native HDR rendering, adjustable transparency, click-through mode, and a tiny ~3MB footprint.

![Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Tauri](https://img.shields.io/badge/built%20with-Tauri%20v2-orange)

## What is FloatView?

FloatView gives you a borderless, always-on-top browser window that floats over your desktop. Point it at your Emby, Jellyfin, Plex, or any web-based media server and it becomes a picture-in-picture viewer that stays on top of everything else. Unlike Electron-based alternatives, FloatView uses the system WebView2 runtime for correct HDR tone mapping and a minimal resource footprint.

## Download

Grab the latest `.msi` installer or portable `.exe` from the [Releases](https://github.com/davidtorcivia/floatview/releases) page.

**Requirements:** Windows 10 or 11. [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) is installed automatically if missing.

## First Launch Guide

### 1. Start the app

Launch FloatView. You'll see the landing page with a URL input field and a list of keyboard shortcuts.

### 2. Enter a URL

Type the address of your media server (e.g., `http://192.168.1.XXX:8096` for Emby/Jellyfin) and press **Enter** or click **Go**. FloatView navigates to it like a regular browser.

### 3. Discover the control strip

Move your mouse to the **top edge** of the window. A dark control strip slides down with all your controls:

```
 [Pin] [Recent] [________URL bar________] [Lock] | [Opacity] [Settings] [-] [x]
```

- **Pin** -- Toggle always-on-top
- **Recent** -- Dropdown of your recent URLs
- **URL bar** -- Shows current URL, type a new one and press Enter to navigate
- **Lock** -- Toggle click-through mode (clicks pass through the window)
- **Opacity slider** -- Drag to adjust window transparency (10%-100%)
- **Settings** -- Open the settings panel
- **Minimize (-)** -- Minimize to the system tray
- **Close (x)** -- Close the application

The strip hides automatically when your mouse leaves it.

### 4. Drag and resize

- **Drag** the window by grabbing the thin bar at the very top edge (above the control strip)
- **Resize** by dragging any edge or corner of the window
- **Double-click** the drag bar to maximize/restore

### 5. Use keyboard shortcuts

These work globally, even when FloatView isn't focused:

| Shortcut | Action |
|---|---|
| `Alt+Shift+T` | Toggle always-on-top |
| `Alt+Shift+D` | Toggle click-through mode |
| `Alt+Shift+Up` | Increase opacity |
| `Alt+Shift+Down` | Decrease opacity |
| `Alt+Shift+H` | Show/hide window |

These only work when the window is focused:

| Shortcut | Action |
|---|---|
| `Ctrl+L` | Show control strip and focus URL bar |
| `Escape` | Hide control strip |

### 6. System tray

FloatView lives in your system tray. **Left-click** the tray icon to show/hide the window. **Right-click** for quick access to settings, toggles, and quit.

### 7. Click-through mode

Press `Alt+Shift+D` to make the window completely transparent to mouse clicks -- everything passes through to the window behind it. The control strip hides automatically. To exit click-through mode:
- Press `Alt+Shift+D` again, or
- Right-click the tray icon and select **Exit Click-Through Mode**

## Features

- **Always on Top** -- Stays above all other windows (toggle with hotkey or tray menu)
- **Adjustable Opacity** -- 10% to 100% transparency via slider or hotkeys
- **Click-Through Mode** -- Window becomes invisible to mouse input
- **Borderless & Resizable** -- Clean look with native resize handles
- **HDR Support** -- Uses system WebView2 for correct HDR rendering (unlike Electron)
- **Shadow DOM Control Strip** -- Injected UI that never breaks the page you're viewing
- **Persistent State** -- Remembers window position, size, opacity, and last URL across restarts
- **System Tray** -- Minimize to tray, quick controls via right-click menu
- **Global Hotkeys** -- Control everything without switching focus
- **Single Instance** -- Opening FloatView again brings the existing window to front
- **Tiny Footprint** -- ~3MB binary, uses system WebView2

## Configuration

Settings are stored in `%APPDATA%\com.floatview.app\config.json` and are managed automatically. You can edit the file directly to customize hotkeys:

```json
{
  "window": {
    "x": 1920,
    "y": 100,
    "width": 800,
    "height": 450,
    "always_on_top": true,
    "opacity": 1.0,
    "locked": false
  },
  "last_url": "http://192.168.1.XXX:8096",
  "recent_urls": ["http://192.168.1.XXX:8096"],
  "hotkeys": {
    "toggle_on_top": "Alt+Shift+T",
    "toggle_locked": "Alt+Shift+D",
    "opacity_up": "Alt+Shift+Up",
    "opacity_down": "Alt+Shift+Down",
    "toggle_visibility": "Alt+Shift+H"
  }
}
```

## Building from Source

### Prerequisites

- [Rust](https://rustup.rs/) (stable toolchain)
- [Node.js](https://nodejs.org/) 18+
- Windows 10/11 with [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

### Build

```bash
git clone https://github.com/davidtorcivia/floatview.git
cd floatview
npm install
npm run dev      # development mode with hot reload
npm run build    # production build (installer output in src-tauri/target/release/bundle/)
```

## Architecture

FloatView uses **Tauri v2** with a single WebviewWindow. The control strip is not a separate overlay -- it's a JavaScript UI injected into every page via WebView2's `AddScriptToExecuteOnDocumentCreated`, wrapped in a **closed Shadow DOM** so it never interferes with page styles or scripts.

```
src/index.html          -- Landing page (URL input)
src-tauri/src/main.rs   -- Rust backend (commands, hotkeys, tray, Win32 interop)
src-tauri/src/config.rs -- Config types with serde
src-tauri/src/click_through.rs -- WS_EX_TRANSPARENT Win32 toggle
src-tauri/src/injection.js     -- Shadow DOM control strip (~1100 lines)
```

### Why not Electron?

Electron bundles its own Chromium, which breaks HDR tone mapping on Windows. FloatView uses the system WebView2 (shared with Edge), giving you native HDR support, automatic updates via Windows Update, and a binary that's 50x smaller.

## Known Limitations

- **Windows only** -- Relies on Win32 APIs (WS_EX_TRANSPARENT, SetLayeredWindowAttributes)
- **Click-through mode is invisible** -- The control strip hides; use hotkey or tray to exit
- **Always-on-top vs fullscreen** -- Cannot overlay exclusive fullscreen games/apps
- **No audio device routing** -- WebView2's `setSinkId()` requires HTTPS origins

## License

[MIT](LICENSE)
