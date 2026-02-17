use tauri::{Runtime, WebviewWindow};

#[cfg(target_os = "windows")]
pub fn set_window_opacity<R: Runtime>(window: &WebviewWindow<R>, opacity: f64) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE,
        LAYERED_WINDOW_ATTRIBUTES_FLAGS, WS_EX_LAYERED,
    };

    if let Ok(hwnd_value) = window.hwnd() {
        unsafe {
            let hwnd = HWND(hwnd_value.0);
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if ex_style & WS_EX_LAYERED.0 as isize == 0 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED.0 as isize);
            }
            let _ = SetLayeredWindowAttributes(
                hwnd,
                windows::Win32::Foundation::COLORREF(0),
                (opacity * 255.0) as u8,
                LAYERED_WINDOW_ATTRIBUTES_FLAGS(2),
            );
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
pub fn set_window_opacity<R: Runtime>(window: &WebviewWindow<R>, opacity: f64) {
    use objc::{msg_send, sel, sel_impl};
    let _ = window.with_webview(move |wv| unsafe {
        let webview: cocoa::base::id = wv.inner() as cocoa::base::id;
        let ns_window: cocoa::base::id = msg_send![webview, window];
        if ns_window != cocoa::base::nil {
            let _: () = msg_send![ns_window, setAlphaValue: opacity];
        }
    });
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn set_window_opacity<R: Runtime>(_window: &WebviewWindow<R>, _opacity: f64) {}
