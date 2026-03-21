mod tray;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Build system tray
            tray::create_tray(app.handle())?;

            // Listen for deep link events and forward to the webview
            let handle = app.handle().clone();
            app.listen("deep-link://new-url", move |event| {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.emit("deep-link", event.payload());
                }
            });

            // Check for updates on launch (non-blocking)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                check_for_updates(handle).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide window instead of closing on macOS (keep in tray)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    window.hide().unwrap_or_default();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Paperclip");
}

async fn check_for_updates(app: tauri::AppHandle) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(_) => return, // updater not configured (e.g. no pubkey yet)
    };

    match updater.check().await {
        Ok(Some(update)) => {
            // Emit update-available event to the webview
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit(
                    "update-available",
                    serde_json::json!({
                        "version": update.version,
                        "date": update.date.map(|d| d.to_string()),
                    }),
                );
            }
        }
        Ok(None) => {} // already up to date
        Err(_) => {}    // network error, skip silently
    }
}
