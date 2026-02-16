#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

#[cfg(target_os = "windows")]
pub fn set_click_through_by_hwnd(hwnd: HWND, enabled: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW, WS_EX_TRANSPARENT,
    };

    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);

        if enabled {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_TRANSPARENT.0 as isize);
        } else {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style & !(WS_EX_TRANSPARENT.0 as isize));
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_click_through_by_hwnd(_hwnd: (), _enabled: bool) {
    // Not implemented on non-Windows platforms
}
