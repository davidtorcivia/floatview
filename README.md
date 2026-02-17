# FloatView

A lightweight, always-on-top floating browser window built for streaming media. Native HDR rendering, adjustable transparency, click-through mode, and a tiny ~3MB footprint.

![Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)
![Tauri](https://img.shields.io/badge/built%20with-Tauri%20v2-orange)

## What is FloatView?

FloatView gives you a borderless, always-on-top browser window that floats over your desktop. Point it at your Emby, Jellyfin, Plex, or any web-based media server and it becomes a picture-in-picture viewer that stays on top of everything else. Uses the system webview for correct HDR tone mapping and a minimal resource footprint.

## Download

Grab the latest release from the [Releases](https://github.com/davidtorcivia/floatview/releases) page.

- **Windows:** `.msi` installer or portable `.exe`. Requires Windows 10 or 11. [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) is installed automatically if missing.
- **macOS:** `.dmg` universal binary (Apple Silicon + Intel).

Nightly builds from the latest commit on `main` are available as pre-releases.

## First Launch Guide

### 1. Tutorial

On first launch, FloatView shows an interactive tutorial that walks you through the control strip, keyboard shortcuts, system tray, and basic navigation. You can skip it at any time.

### 2. Set your home page

Open **Settings** (gear icon in the control strip, or right-click the tray icon) and set your **Home URL** to your media server or favorite site. The home button in the control strip navigates back to this URL.

### 3. Discover the control strip

Move your mouse to the **top edge** of the window. A dark control strip slides down with all your controls:

```
 [Pin] [Recent] [Home] [________URL bar________] [Lock] | [Opacity] [Settings] [-] [x]
```

- **Pin** -- Toggle always-on-top
- **Recent** -- Dropdown of your recent URLs
- **Home** -- Navigate to your configured home URL
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
- **Configurable Home URL** -- Set your default page; navigate back with the Home button
- **First-Run Tutorial** -- Interactive onboarding for new users
- **Borderless & Resizable** -- Clean look with native resize handles
- **HDR Support** -- Uses system webview for correct HDR rendering (unlike Electron)
- **Shadow DOM Control Strip** -- Injected UI that never breaks the page you're viewing
- **Persistent State** -- Remembers window position, size, opacity, and last URL across restarts
- **System Tray** -- Minimize to tray, quick controls via right-click menu
- **Global Hotkeys** -- Control everything without switching focus
- **Single Instance** -- Opening FloatView again brings the existing window to front
- **In-App Updates** -- Check for updates and install from Settings
- **Cross-Platform** -- Windows and macOS
- **Tiny Footprint** -- ~3MB binary, uses system webview

## Configuration

Settings are stored in a platform-specific config directory and are managed automatically:

- **Windows:** `%APPDATA%\com.floatview.app\config.json`
- **macOS:** `~/Library/Application Support/com.floatview.app/config.json`

You can edit the file directly to customize hotkeys or other settings:

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
  "home_url": "https://www.google.com",
  "first_run": false,
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

**Windows:** Windows 10/11 with [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

**macOS:** Xcode Command Line Tools (`xcode-select --install`)

### Build

```bash
git clone https://github.com/davidtorcivia/floatview.git
cd floatview
npm install
npm run dev      # development mode with hot reload
npm run build    # production build (installer output in src-tauri/target/release/bundle/)
```

**macOS universal binary:**

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build -- -- --target universal-apple-darwin
```

## Architecture

FloatView uses **Tauri v2** with a single WebviewWindow. The control strip is not a separate overlay -- it's a JavaScript UI injected into every page via the webview's script injection API, wrapped in a **closed Shadow DOM** so it never interferes with page styles or scripts.

```
src/index.html              -- Landing page (URL input)
src-tauri/src/main.rs       -- Rust backend (commands, hotkeys, tray, platform interop)
src-tauri/src/config.rs     -- Config types with serde
src-tauri/src/opacity.rs    -- Cross-platform opacity management
src-tauri/src/injection.js  -- Shadow DOM control strip + tutorial (~1550 lines)
```

### Why not Electron?

Electron bundles its own Chromium, which breaks HDR tone mapping on Windows. FloatView uses the system webview (WebView2 on Windows, WebKit on macOS), giving you native HDR support, automatic updates via the OS, and a binary that's 50x smaller.

## Uninstallation

- **Windows MSI:** Uninstall from **Settings > Apps > Installed apps** or **Control Panel > Programs and Features**
- **Windows EXE (NSIS):** Uninstall from **Settings > Apps > Installed apps**, or run the uninstaller from the Start Menu
- **macOS:** Drag FloatView.app from `/Applications` to the Trash

Configuration files are stored separately and not removed by default:
- **Windows:** `%APPDATA%\com.floatview.app\`
- **macOS:** `~/Library/Application Support/com.floatview.app/`

## Known Limitations

- **Click-through mode is invisible** -- The control strip hides; use hotkey or tray to exit
- **Always-on-top vs fullscreen** -- Cannot overlay exclusive fullscreen games/apps
- **No audio device routing** -- WebView's `setSinkId()` requires HTTPS origins
- **macOS** -- Some global hotkey combinations may conflict with system shortcuts

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user. The only automated network request is the optional **Check for Updates** feature in Settings, which queries the [GitHub Releases API](https://github.com/davidtorcivia/floatview/releases) to check for new versions. No personal data, telemetry, or usage statistics are collected or transmitted.

## License

[MIT](LICENSE)

## Maintainers

- [David Torcivia](https://github.com/davidtorcivia) -- Author and maintainer
