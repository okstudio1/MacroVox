mod audio;
mod commands;
mod deepgram_ws;
mod platform;
mod state;
mod voice_buffer;

use commands::*;
use log::debug;
use state::AppState;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Activate RUST_LOG-based logging (e.g. RUST_LOG=debug python run.py debug)
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            // Global hotkey — show/toggle the dictation window.
            // The handler fires for ANY registered shortcut; since we only ever
            // register one at a time, we just act on every press.
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.emit("quick-dictation-toggle", ());
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("quick-dictation-toggle", ());
                        }
                    }
                })
                .build(),
        )
        .manage(AppState::default())
        .setup(|app| {
            // Register global hotkey (default: Ctrl+Space)
            let default_hotkey = app
                .state::<AppState>()
                .global_hotkey
                .lock()
                .unwrap()
                .clone();
            if let Ok(shortcut) = commands::parse_shortcut(&default_hotkey) {
                app.global_shortcut().register(shortcut)?;
            }

            // Initialize voice buffer directory
            if let Ok(app_data) = app.path().app_local_data_dir() {
                let voice_dir = app_data.join("voice-buffer");
                debug!("[setup] Voice buffer directory: {:?}", voice_dir);
                let state = app.state::<AppState>();
                *state.voice_buffer_dir.lock().unwrap() = voice_dir.clone();

                // One-shot migration: re-encode any recordings stretched by the
                // pre-fix encoder. Idempotent — files within 50ms of their
                // expected duration are skipped.
                std::thread::spawn(move || {
                    voice_buffer::repair_stretched_recordings(&voice_dir);
                });
            }

            // Minimize-to-tray close handler: intercept the close event on the
            // main window and hide instead of destroying if the setting is on.
            let main_window = app.get_webview_window("main").ok_or_else(|| {
                Box::<dyn std::error::Error>::from(
                    "main window failed to initialize — check tauri.conf.json windows[] config",
                )
            })?;
            let _ = main_window.show();
            let _ = main_window.set_focus();

            // Open DevTools automatically when RUST_LOG is set (debug mode)
            #[cfg(debug_assertions)]
            if std::env::var("RUST_LOG").is_ok() {
                main_window.open_devtools();
            }

            let app_handle = app.handle().clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let state = app_handle.state::<AppState>();
                    let minimize = *state.minimize_to_tray.lock().unwrap();
                    if minimize {
                        api.prevent_close();
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    } else {
                        // Signal all windows that we're shutting down so their
                        // prevent_close handlers step aside.
                        state
                            .is_quitting
                            .store(true, std::sync::atomic::Ordering::SeqCst);

                        // Destroy the settings window first so its WebView2 can
                        // unregister its window class cleanly before the process
                        // exits.
                        if let Some(settings_win) = app_handle.get_webview_window("settings") {
                            let _ = settings_win.destroy();
                        }

                        // Now quit
                        app_handle.exit(0);
                    }
                }
            });

            // Settings window: hide on close instead of destroying, so it can
            // be re-shown without recreating — unless the app is quitting.
            let settings_handle = app.handle().clone();
            if let Some(settings_window) = app.get_webview_window("settings") {
                settings_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let state = settings_handle.state::<AppState>();
                        let quitting = state.is_quitting.load(std::sync::atomic::Ordering::SeqCst);
                        if !quitting {
                            api.prevent_close();
                            if let Some(win) = settings_handle.get_webview_window("settings") {
                                let _ = win.hide();
                            }
                        }
                        // If quitting, let the close proceed so WebView2 cleans up
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Audio
            audio_list_devices,
            audio_set_device,
            audio_start,
            audio_stop,
            audio_get_level,
            // Deepgram streaming
            deepgram_start,
            deepgram_stop,
            // Buffered recording
            recording_start,
            recording_stop,
            recording_cancel,
            // Local STT (whisper-rs)
            whisper_transcribe,
            // Clipboard & auto-paste
            clipboard_write,
            dictation_auto_paste,
            // Window settings
            dictation_set_always_on_top,
            settings_open_window,
            app_set_minimize_to_tray,
            platform_info,
            // Theme, settings, hotkey
            theme_broadcast,
            settings_broadcast,
            update_global_hotkey,
            // Voice buffer
            voice_buffer_list,
            voice_buffer_info,
            voice_buffer_get_audio,
            voice_buffer_delete,
            voice_buffer_clear,
            voice_buffer_save,
            voice_buffer_update_transcript,
            voice_buffer_reprocess,
            voice_buffer_open_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MacroVox");
}
