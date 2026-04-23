use tauri::{Runtime, WebviewWindow};

/// Map the user's "raw" opacity (0.1–1.0) to the actual window alpha we
/// push to the OS. The curve floors at `WINDOW_ALPHA_FLOOR` so the
/// toolbar stays readable even when the page is nearly see-through; the
/// injected stylesheet applies a complementary CSS opacity to page
/// content so the *combined* visibility still matches the raw value.
pub const WINDOW_ALPHA_FLOOR: f64 = 0.85;

pub fn window_alpha_from_raw(raw: f64) -> f64 {
    let r = raw.clamp(0.0, 1.0);
    WINDOW_ALPHA_FLOOR + (1.0 - WINDOW_ALPHA_FLOOR) * r
}

#[cfg(target_os = "windows")]
pub fn set_window_opacity<R: Runtime>(window: &WebviewWindow<R>, opacity: f64) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE,
        LAYERED_WINDOW_ATTRIBUTES_FLAGS, WS_EX_LAYERED,
    };

    let alpha = window_alpha_from_raw(opacity);

    if let Ok(hwnd_value) = window.hwnd() {
        unsafe {
            let hwnd = HWND(hwnd_value.0);
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if alpha >= 1.0 {
                // Fully opaque: remove layered flag for clean rendering
                if ex_style & WS_EX_LAYERED.0 as isize != 0 {
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style & !(WS_EX_LAYERED.0 as isize));
                }
            } else {
                if ex_style & WS_EX_LAYERED.0 as isize == 0 {
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED.0 as isize);
                }
                let _ = SetLayeredWindowAttributes(
                    hwnd,
                    windows::Win32::Foundation::COLORREF(0),
                    (alpha * 255.0) as u8,
                    LAYERED_WINDOW_ATTRIBUTES_FLAGS(2),
                );
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
pub fn set_window_opacity<R: Runtime>(window: &WebviewWindow<R>, opacity: f64) {
    use objc::{msg_send, sel, sel_impl};
    let alpha = window_alpha_from_raw(opacity);
    let _ = window.with_webview(move |wv| unsafe {
        let webview: cocoa::base::id = wv.inner() as cocoa::base::id;
        let ns_window: cocoa::base::id = msg_send![webview, window];
        if ns_window != cocoa::base::nil {
            let _: () = msg_send![ns_window, setAlphaValue: alpha];
        }
    });
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn set_window_opacity<R: Runtime>(_window: &WebviewWindow<R>, _opacity: f64) {}
