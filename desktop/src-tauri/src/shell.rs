//! Native desktop shell: tray icon, close-to-tray, Quick Entry window, deep links.
//! The window is frameless; its app menu lives in the React title bar.

use crate::state::AppState;
use std::sync::Arc;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

pub const QUICK: &str = "quick";

fn item(app: &AppHandle, id: &str, label: &str, hint: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    let text = match hint {
        Some(h) => format!("{label}\t{h}"),
        None => label.to_string(),
    };
    MenuItem::with_id(app, id, text, true, None::<&str>)
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn toggle_quick(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(QUICK) {
        if w.is_visible()? {
            w.hide()?;
        } else {
            w.center()?;
            w.show()?;
            w.set_focus()?;
            let _ = w.emit_to(QUICK, "quick-shown", ());
        }
        return Ok(());
    }
    // The frontend picks its Quick Entry UI from the window label.
    let w = WebviewWindowBuilder::new(app, QUICK, WebviewUrl::App("index.html".into()))
        .title("OpenClaude Quick Entry")
        .inner_size(680.0, 150.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .build()?;
    w.set_focus()?;
    Ok(())
}

pub fn on_menu(app: &AppHandle, event: &MenuEvent) {
    match event.id().as_ref() {
        "quit" => app.exit(0),
        "quick_entry" => {
            let _ = toggle_quick(app);
        }
        "zoom_in" | "zoom_out" | "zoom_reset" => {
            let st = app.state::<Arc<AppState>>();
            let mut z = st.zoom.lock().unwrap();
            *z = match event.id().as_ref() {
                "zoom_in" => (*z + 0.1).min(2.0),
                "zoom_out" => (*z - 0.1).max(0.5),
                _ => 1.0,
            };
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_zoom(*z);
            }
        }
        other => {
            show_main(app);
            let _ = app.emit_to("main", "menu", other.to_string());
        }
    }
}

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(app, &[
        &item(app, "tray_show", "Show OpenClaude", None)?,
        &item(app, "new_chat", "New chat", None)?,
        &item(app, "quick_entry", "Quick entry", None)?,
        &PredefinedMenuItem::separator(app)?,
        &item(app, "quit", "Quit", None)?,
    ])?;
    let mut b = TrayIconBuilder::with_id("main-tray")
        .tooltip("OpenClaude")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| {
            if e.id().as_ref() == "tray_show" {
                show_main(app)
            } else {
                on_menu(app, &e)
            }
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

/// Close-to-tray (default on, like the reference app). Returns true when the close was intercepted.
pub fn intercept_close(window: &tauri::Window) -> bool {
    if window.label() != "main" {
        return false;
    }
    let app = window.app_handle();
    let Some(st) = app.try_state::<Arc<AppState>>() else { return false };
    let (enabled, notified) = {
        let db = st.db.lock().unwrap();
        (db.get_setting("close_to_tray").as_deref() != Some("false"), db.get_setting("tray_notice_shown").is_some())
    };
    if !enabled {
        return false;
    }
    let _ = window.hide();
    if !notified {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title("OpenClaude is still running")
            .body("It keeps running in the system tray so connectors stay up. Quit from the tray menu, or turn this off in Settings.")
            .show();
        let _ = st.db.lock().unwrap().set_setting("tray_notice_shown", "1");
    }
    true
}

/// `openclaude://new?prompt=...` opens a new chat with the prompt prefilled. It never
/// auto-sends: a link on a web page must not be able to start a request by itself.
pub fn handle_deep_link(app: &AppHandle, raw: &str) {
    let Some(prompt) = parse_deep_link(raw) else { return };
    show_main(app);
    let _ = app.emit_to("main", "deep-link-new", prompt);
}

pub fn parse_deep_link(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "openclaude" || url.host_str() != Some("new") {
        return None;
    }
    let prompt = url.query_pairs().find(|(k, _)| k == "prompt").map(|(_, v)| v.to_string()).unwrap_or_default();
    Some(prompt.chars().take(4000).collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn deep_links() {
        assert_eq!(super::parse_deep_link("openclaude://new?prompt=hello%20world").as_deref(), Some("hello world"));
        assert_eq!(super::parse_deep_link("openclaude://new").as_deref(), Some(""));
        assert_eq!(super::parse_deep_link("openclaude://settings/delete"), None);
        assert_eq!(super::parse_deep_link("https://new?prompt=x"), None);
        assert_eq!(super::parse_deep_link(&format!("openclaude://new?prompt={}", "a".repeat(9000))).unwrap().len(), 4000);
    }
}
