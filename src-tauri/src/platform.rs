use std::path::Path;

pub fn open_in_file_manager(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }
}

/// True on Linux running under a Wayland session.
///
/// Checked at every call site rather than cached, because the session can
/// differ between app launch (e.g. a service daemon) and the actual user
/// session, and because `WAYLAND_DISPLAY` can be set by XWayland-hosted
/// apps even when `XDG_SESSION_TYPE=x11`.
///
/// Used by: `dictation_auto_paste` (skip the `enigo` key injection — it is
/// not reliable on Wayland; clipboard write still succeeds so the user can
/// paste manually) and by the renderer's Settings UI (surface the
/// limitation to the user instead of silently swallowing it).
#[cfg(target_os = "linux")]
pub fn is_wayland() -> bool {
    if std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
    {
        return true;
    }
    std::env::var("WAYLAND_DISPLAY").is_ok()
}

#[cfg(not(target_os = "linux"))]
pub fn is_wayland() -> bool {
    false
}

/// A Wayland-native keystroke-injection helper, if one is installed.
///
/// `enigo`'s X11 (XTEST) path does not work under Wayland — the compositor
/// isolates clients from synthesising input. Two common userspace tools fill the
/// gap: `wtype` (uses the `virtual-keyboard` protocol, works on wlroots-based
/// compositors and is daemonless) and `ydotool` (uses the kernel `uinput`
/// device, works anywhere but needs `ydotoold` running). We prefer `wtype`.
#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaylandPasteTool {
    Wtype,
    Ydotool,
}

/// Returns true if `name` is an executable file on any `$PATH` directory.
///
/// A pure-`$PATH` scan rather than spawning `which`/`command -v`, so the
/// availability check on the auto-paste hot path costs no subprocess.
#[cfg(target_os = "linux")]
fn binary_on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

/// The preferred Wayland paste tool available on this system, if any.
#[cfg(target_os = "linux")]
pub fn wayland_paste_tool() -> Option<WaylandPasteTool> {
    if binary_on_path("wtype") {
        return Some(WaylandPasteTool::Wtype);
    }
    if binary_on_path("ydotool") {
        return Some(WaylandPasteTool::Ydotool);
    }
    None
}

/// Sends Ctrl+V to the focused window via the given Wayland tool.
///
/// Runs synchronously and returns the tool's failure if it exits non-zero (e.g.
/// `ydotool` with no daemon), so the caller can log it.
#[cfg(target_os = "linux")]
pub fn wayland_send_paste(tool: WaylandPasteTool) -> std::io::Result<()> {
    use std::process::Command;
    let status = match tool {
        // `-M ctrl` presses Ctrl, `v` types the key while held, `-m ctrl` releases.
        WaylandPasteTool::Wtype => Command::new("wtype")
            .args(["-M", "ctrl", "v", "-m", "ctrl"])
            .status()?,
        // Linux evdev key codes: 29 = LeftCtrl, 47 = V; `:1` press, `:0` release.
        WaylandPasteTool::Ydotool => Command::new("ydotool")
            .args(["key", "29:1", "47:1", "47:0", "29:0"])
            .status()?,
    };
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("{tool:?} exited with {status}"),
        ))
    }
}

/// Whether `dictation_auto_paste` can actually inject a keystroke on this system.
///
/// True on Windows, macOS, and Linux/X11 (where `enigo` works). On Linux/Wayland
/// it is true only when a Wayland paste tool (`wtype`/`ydotool`) is installed.
/// The renderer reads this via `platform_info` to enable or disable the
/// "Auto-paste on stop" toggle in Settings.
pub fn auto_paste_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        if is_wayland() {
            return wayland_paste_tool().is_some();
        }
        true
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}
