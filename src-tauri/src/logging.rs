//! Structured logging setup (file + console) via the `tracing` ecosystem.

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tracing::info;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// RAII guard for the background logging worker. Keeping the guard alive
/// ensures log records are flushed before the process exits; the guard is
/// stored in Tauri's managed state so its lifetime spans the full app.
pub struct LoggingState {
    pub _guard: WorkerGuard,
}

/// Initialize file + console logging for the app.
///
/// Log file lives under the platform `app_log_dir` (falling back to
/// `app_config_dir/logs`, then the CWD). Daily rotation. Returns the
/// `WorkerGuard` the caller must keep alive for the life of the app;
/// returns `None` if the subscriber failed to initialize or the log
/// directory couldn't be created.
pub fn init_logging(app: &AppHandle) -> Option<WorkerGuard> {
    let log_dir = app
        .path()
        .app_log_dir()
        .or_else(|_| app.path().app_config_dir().map(|p| p.join("logs")))
        .unwrap_or_else(|_| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("logs")
        });

    if let Err(e) = fs::create_dir_all(&log_dir) {
        eprintln!("Failed to create log directory: {}", e);
        return None;
    }

    let file_appender = tracing_appender::rolling::daily(&log_dir, "floatview.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,floatview=debug"));

    let console_layer = tracing_subscriber::fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_ansi(true);
    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true);

    if tracing_subscriber::registry()
        .with(filter)
        .with(console_layer)
        .with(file_layer)
        .try_init()
        .is_err()
    {
        eprintln!("Tracing subscriber was already initialized");
        return None;
    }

    info!(path = %log_dir.display(), "Logging initialized");
    Some(guard)
}
