use tauri::{
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::TrayIconBuilder,
  AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

// Fired to the frontend when the global shortcut is pressed; js/main.js
// listens for this and clocks in/out of whatever task was most recently
// active, exactly like clicking the floating widget's button would.
const CLOCK_TOGGLE_EVENT: &str = "doos://clock-toggle";
const CLOCK_TOGGLE_SHORTCUT: &str = "CommandOrControl+Shift+K";

fn toggle_window_visibility(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let visible = window.is_visible().unwrap_or(false);
    if visible {
      let _ = window.hide();
    } else {
      let _ = window.show();
      let _ = window.set_focus();
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_store::Builder::default().build())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    // A request made through this plugin runs in the Rust process, not
    // the webview, so it isn't subject to the webview's CORS enforcement
    // at all -- this is what lets js/canvas.js actually reach Canvas's
    // API (which never sends CORS headers, confirmed, no opt-in) from
    // inside the desktop app. See js/db.js's isTauriEnv() for how the
    // frontend detects this build vs the plain browser one, where this
    // bypass doesn't exist and Canvas calls still fail with a clear,
    // explained error instead.
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_autostart::init(
      MacosLauncher::LaunchAgent,
      None,
    ))
    .plugin(
      tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
          if event.state == ShortcutState::Pressed
            && shortcut.matches(
              tauri_plugin_global_shortcut::Modifiers::SUPER
                | tauri_plugin_global_shortcut::Modifiers::SHIFT,
              tauri_plugin_global_shortcut::Code::KeyK,
            )
          {
            let _ = app.emit(CLOCK_TOGGLE_EVENT, ());
          }
        })
        .build(),
    )
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Global shortcut: Cmd/Ctrl+Shift+K toggles clock in/out. Registered
      // once here in Rust (not re-registered from JS), so it works even
      // when the window is unfocused or hidden to the tray.
      app
        .global_shortcut()
        .register(CLOCK_TOGGLE_SHORTCUT)
        .expect("failed to register global clock-toggle shortcut");

      // Menu-bar tray icon: left-click toggles the window, with a small
      // menu for the same action plus Quit, since a personal daily-use
      // tool like this is meant to live in the tray more than the Dock.
      let show_hide = MenuItem::with_id(app, "toggle_window", "Show/Hide doOS", true, None::<&str>)?;
      let quit = PredefinedMenuItem::quit(app, Some("Quit doOS"))?;
      let tray_menu = Menu::with_items(app, &[&show_hide, &quit])?;

      TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
          if event.id() == "toggle_window" {
            toggle_window_visibility(app);
          }
        })
        .on_tray_icon_event(|tray, event| {
          if let tauri::tray::TrayIconEvent::Click {
            button: tauri::tray::MouseButton::Left,
            button_state: tauri::tray::MouseButtonState::Up,
            ..
          } = event
          {
            toggle_window_visibility(tray.app_handle());
          }
        })
        .build(app)?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
