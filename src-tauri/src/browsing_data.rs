use tauri::{Runtime, WebviewWindow};

pub fn clear_all<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    window.clear_all_browsing_data().map_err(|e| e.to_string())
}
