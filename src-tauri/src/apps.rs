//! Windows-specific application discovery: enumerating running/installed
//! desktop apps and extracting a friendly display name + icon from an
//! executable, so the user can add a specific application as a Sources
//! entry. Kept separate from `audio::capture` since none of this is
//! audio-related - it only identifies *which* application a source
//! represents, for display and persistence purposes.

use std::collections::HashSet;
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
    HKEY_LOCAL_MACHINE, KEY_READ, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, EnumWindows, GetIconInfo, GetWindowLongPtrW, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

/// One discovered application - either a currently running top-level window
/// (from [`get_active_applications`]) or an installed program (from
/// [`get_installed_applications`]). `window_title`/`icon_base64` are only
/// populated where cheap to do eagerly; the frontend fills in a missing
/// icon lazily via [`get_exe_metadata`] rather than extracting icons for
/// every installed application up front.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub exe_path: String,
    pub window_title: Option<String>,
    pub icon_base64: Option<String>,
}

/// A resolved executable's friendly name and icon - shared result type for
/// [`get_exe_metadata`] and the eager lookups inside [`get_active_applications`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMetadata {
    pub name: String,
    pub icon_base64: Option<String>,
}

/// A user-added application source, persisted across restarts (see
/// `settings_store::PersistedSettings`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSource {
    /// The lowercased executable path - stable across sessions and
    /// naturally de-duplicates re-adding the same application.
    pub id: String,
    pub name: String,
    pub exe_path: String,
    pub icon_base64: Option<String>,
}

/// Every currently running application with at least one visible, titled
/// top-level window - deduplicated by executable path (a multi-window app
/// like a browser only produces one entry).
#[tauri::command]
pub fn get_active_applications() -> Vec<AppInfo> {
    let current_pid = std::process::id();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut results = Vec::new();

    for hwnd in enumerate_top_level_windows() {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                continue;
            }
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
                continue;
            }
        }

        let title = window_title(hwnd);
        if title.trim().is_empty() {
            continue;
        }

        let pid = window_pid(hwnd);
        if pid == 0 || pid == current_pid {
            continue;
        }

        let Some(exe_path) = exe_path_for_pid(pid) else {
            continue;
        };
        if !seen_paths.insert(exe_path.to_lowercase()) {
            continue;
        }

        let metadata = resolve_app_metadata(&exe_path);
        results.push(AppInfo {
            name: metadata.name,
            exe_path,
            window_title: Some(title),
            icon_base64: metadata.icon_base64,
        });
    }

    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    results
}

/// Every desktop application registered under the standard Windows
/// Uninstall registry paths (machine-wide 64-bit, machine-wide 32-bit via
/// WOW6432Node, and per-user). Icons are intentionally left unpopulated
/// here - this list can run into the hundreds of entries, so the frontend
/// fetches icons lazily per row via [`get_exe_metadata`] instead of paying
/// for icon extraction on every entry up front.
#[tauri::command]
pub fn get_installed_applications() -> Vec<AppInfo> {
    const UNINSTALL_SUBPATH: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    const UNINSTALL_SUBPATH_WOW64: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut results = Vec::new();

    for (root, subpath) in [
        (HKEY_LOCAL_MACHINE, UNINSTALL_SUBPATH),
        (HKEY_LOCAL_MACHINE, UNINSTALL_SUBPATH_WOW64),
        (HKEY_CURRENT_USER, UNINSTALL_SUBPATH),
    ] {
        for info in scan_uninstall_key(root, subpath) {
            if seen_paths.insert(info.exe_path.to_lowercase()) {
                results.push(info);
            }
        }
    }

    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    results
}

/// Resolves a friendly name (the exe's `FileDescription` version resource,
/// falling back to a title-cased filename) and an icon for an arbitrary
/// executable path - used both for the "Browse for a different app" flow
/// and lazily by the frontend for rows that don't already have an icon.
#[tauri::command]
pub fn get_exe_metadata(path: String) -> Result<AppMetadata, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("file not found: '{path}'"));
    }
    Ok(resolve_app_metadata(&path))
}

/// Resolves and appends `path` to the persisted application sources list
/// (replacing any existing entry for the same executable), saving
/// immediately so it survives a restart.
#[tauri::command]
pub fn add_application_source(
    app: tauri::AppHandle,
    state: tauri::State<crate::state::AppState>,
    path: String,
) -> Result<ApplicationSource, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("file not found: '{path}'"));
    }

    let metadata = resolve_app_metadata(&path);
    let source = ApplicationSource {
        id: path.to_lowercase(),
        name: metadata.name,
        exe_path: path,
        icon_base64: metadata.icon_base64,
    };

    let mut sources = crate::commands::lock_or_recover(&state.application_sources);
    sources.retain(|existing| existing.id != source.id);
    sources.push(source.clone());
    drop(sources);

    crate::settings_store::save(&app, &state);
    Ok(source)
}

fn resolve_app_metadata(exe_path: &str) -> AppMetadata {
    let name = file_description(exe_path).unwrap_or_else(|| title_case_from_filename(exe_path));
    let icon_base64 = extract_icon_base64(exe_path);
    AppMetadata { name, icon_base64 }
}

// ---------------------------------------------------------------------
// Window enumeration
// ---------------------------------------------------------------------

unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let windows_vec = &mut *(lparam.0 as *mut Vec<HWND>);
    windows_vec.push(hwnd);
    windows::core::BOOL(1)
}

fn enumerate_top_level_windows() -> Vec<HWND> {
    let mut windows_vec: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_callback),
            LPARAM(&mut windows_vec as *mut _ as isize),
        );
    }
    windows_vec
}

fn window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..copied.max(0) as usize])
    }
}

fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid
}

pub(crate) fn exe_path_for_pid(pid: u32) -> Option<String> {
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// Finds the PID of a currently running process whose full executable path
/// matches `exe_path` (case-insensitively) - used to resolve an application
/// Source's saved exe path to a live process ID immediately before starting
/// a process-loopback capture, since audio capture targets a PID, not a
/// path. Enumerates every process on the system (via a toolhelp snapshot,
/// same mechanism Task Manager uses) rather than just top-level windows,
/// since the target application may not have any visible window.
pub(crate) fn find_running_pid_for_exe(exe_path: &str) -> Option<u32> {
    let target = exe_path.to_lowercase();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        let mut found_pid = None;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                if let Some(path) = exe_path_for_pid(pid) {
                    if path.to_lowercase() == target {
                        found_pid = Some(pid);
                        break;
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
        found_pid
    }
}

// ---------------------------------------------------------------------
// Version resource (FileDescription) lookup
// ---------------------------------------------------------------------

fn file_description(path: &str) -> Option<String> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
        if size == 0 {
            return None;
        }

        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(wide.as_ptr()), Some(0), size, data.as_mut_ptr() as *mut _).ok()?;

        let translation_query: Vec<u16> = "\\VarFileInfo\\Translation\0".encode_utf16().collect();
        let mut translation_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut translation_len: u32 = 0;
        let found_translation = VerQueryValueW(
            data.as_ptr() as *const _,
            PCWSTR(translation_query.as_ptr()),
            &mut translation_ptr,
            &mut translation_len,
        )
        .as_bool();
        if !found_translation || translation_ptr.is_null() || translation_len < 4 {
            return None;
        }
        let langs =
            std::slice::from_raw_parts(translation_ptr as *const u16, (translation_len / 2) as usize);
        let (lang_id, charset) = (langs[0], langs[1]);

        let sub_block = format!("\\StringFileInfo\\{lang_id:04x}{charset:04x}\\FileDescription\0");
        let sub_block_wide: Vec<u16> = sub_block.encode_utf16().collect();
        let mut value_ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut value_len: u32 = 0;
        let found_value = VerQueryValueW(
            data.as_ptr() as *const _,
            PCWSTR(sub_block_wide.as_ptr()),
            &mut value_ptr,
            &mut value_len,
        )
        .as_bool();
        if !found_value || value_ptr.is_null() || value_len == 0 {
            return None;
        }

        let chars = std::slice::from_raw_parts(value_ptr as *const u16, value_len as usize);
        let description = String::from_utf16_lossy(chars)
            .trim_end_matches('\0')
            .trim()
            .to_string();
        if description.is_empty() {
            None
        } else {
            Some(description)
        }
    }
}

/// Strips the `.exe` extension, replaces anything that isn't alphanumeric
/// with a space, and title-cases the remaining words - e.g. `my_app.exe`
/// becomes `My App`. Used whenever an executable has no `FileDescription`
/// version resource to read a friendly name from.
fn title_case_from_filename(exe_path: &str) -> String {
    let stem = Path::new(exe_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown");

    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();

    cleaned
        .split_whitespace()
        .map(|word| {
            // Only capitalizes a lowercase leading letter - the rest of the
            // word is left exactly as-is, rather than forced to lowercase,
            // so an already-PascalCase/camelCase filename with no
            // underscores to split on (e.g. `GitHubDesktop.exe`,
            // `TextInputHost.exe`) keeps its internal capitalization
            // instead of being flattened into `Githubdesktop`.
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------
// Icon extraction
// ---------------------------------------------------------------------

/// `SHGetFileInfoW`/`GetIconInfo`/`GetDIBits` intermittently fail when
/// called concurrently from multiple threads (observed directly: running
/// several icon extractions in parallel - e.g. Tauri dispatching one
/// `get_exe_metadata` call per "All apps" dialog row at once - caused
/// sporadic extraction failures that don't reproduce when called one at a
/// time). Serializing every extraction through this lock trades a little
/// latency for reliability rather than chasing COM/GDI thread-affinity
/// details that Windows' Shell API doesn't clearly document.
static ICON_EXTRACTION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn extract_icon_base64(exe_path: &str) -> Option<String> {
    let _guard = ICON_EXTRACTION_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut shfi = SHFILEINFOW::default();
    let icon_flags = SHGFI_ICON | SHGFI_LARGEICON;
    unsafe {
        let rc = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            icon_flags,
        );
        if rc == 0 || shfi.hIcon.is_invalid() {
            return None;
        }
    }

    let png_base64 = icon_handle_to_png_base64(shfi.hIcon);
    unsafe {
        let _ = DestroyIcon(shfi.hIcon);
    }
    png_base64
}

fn icon_handle_to_png_base64(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<String> {
    unsafe {
        let mut icon_info = Default::default();
        GetIconInfo(hicon, &mut icon_info).ok()?;

        let mut bmp = BITMAP::default();
        let written = GetObjectW(
            icon_info.hbmColor.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        );

        let cleanup = || {
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());
        };

        if written == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
            cleanup();
            return None;
        }

        let width = bmp.bmWidth;
        let height = bmp.bmHeight;
        let mut buffer = vec![0u8; (width * height * 4) as usize];

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative height requests a top-down DIB, matching the
                // row order `image::RgbaImage::from_raw` expects.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let dc = CreateCompatibleDC(None);
        let scanlines = GetDIBits(
            dc,
            icon_info.hbmColor,
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
        cleanup();

        if scanlines == 0 {
            return None;
        }

        // GetDIBits returns BGRA; RgbaImage expects RGBA.
        for pixel in buffer.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }

        let img = image::RgbaImage::from_raw(width as u32, height as u32, buffer)?;
        let mut png_bytes = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .ok()?;

        Some(format!("data:image/png;base64,{}", BASE64.encode(&png_bytes)))
    }
}

// ---------------------------------------------------------------------
// Registry (installed applications) scan
// ---------------------------------------------------------------------

fn scan_uninstall_key(root: HKEY, subpath: &str) -> Vec<AppInfo> {
    let mut results = Vec::new();

    let Some(hkey) = open_registry_key(root, subpath) else {
        return results;
    };

    let mut index = 0u32;
    loop {
        let mut name_buf = [0u16; 256];
        let mut name_len = name_buf.len() as u32;
        let rc = unsafe {
            RegEnumKeyExW(
                hkey,
                index,
                Some(windows::core::PWSTR(name_buf.as_mut_ptr())),
                &mut name_len,
                None,
                Some(windows::core::PWSTR::null()),
                None,
                None,
            )
        };
        if rc.is_err() {
            break;
        }

        let subkey_name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        if let Some(info) = read_uninstall_entry(hkey, &subkey_name) {
            results.push(info);
        }

        index += 1;
    }

    unsafe {
        let _ = RegCloseKey(hkey);
    }
    results
}

fn open_registry_key(root: HKEY, subpath: &str) -> Option<HKEY> {
    let subpath_wide: Vec<u16> = subpath.encode_utf16().chain(std::iter::once(0)).collect();
    let mut hkey = HKEY::default();
    let result = unsafe {
        RegOpenKeyExW(root, PCWSTR(subpath_wide.as_ptr()), Some(0), KEY_READ, &mut hkey)
    };
    if result.is_ok() {
        Some(hkey)
    } else {
        None
    }
}

fn read_uninstall_entry(parent: HKEY, subkey_name: &str) -> Option<AppInfo> {
    let hkey = open_registry_key(parent, subkey_name)?;

    let display_name = read_registry_string(hkey, "DisplayName");
    let is_system_component = read_registry_dword(hkey, "SystemComponent").unwrap_or(0) != 0;
    let display_icon = read_registry_string(hkey, "DisplayIcon");
    let uninstall_string = read_registry_string(hkey, "UninstallString");

    unsafe {
        let _ = RegCloseKey(hkey);
    }

    let display_name = display_name?;
    if is_system_component {
        return None;
    }

    let exe_path = display_icon
        .as_deref()
        .and_then(resolve_exe_from_display_icon)
        .or_else(|| uninstall_string.as_deref().and_then(extract_quoted_exe))?;

    Some(AppInfo {
        name: display_name,
        exe_path,
        window_title: None,
        icon_base64: None,
    })
}

fn read_registry_string(hkey: HKEY, value_name: &str) -> Option<String> {
    let name_wide: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut value_type = REG_VALUE_TYPE::default();
    let mut size: u32 = 0;
    let query_size = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(name_wide.as_ptr()),
            None,
            Some(&mut value_type),
            None,
            Some(&mut size),
        )
    };
    if query_size.is_err() {
        return None;
    }
    if size == 0 || (value_type != REG_SZ && value_type != REG_EXPAND_SZ) {
        return None;
    }

    let mut buf = vec![0u8; size as usize];
    let query_value = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(name_wide.as_ptr()),
            None,
            Some(&mut value_type),
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        )
    };
    if query_value.is_err() {
        return None;
    }

    let wide: Vec<u16> = buf
        .chunks_exact(2)
        .map(|pair| u16::from_ne_bytes([pair[0], pair[1]]))
        .collect();
    let s = String::from_utf16_lossy(&wide).trim_end_matches('\0').to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn read_registry_dword(hkey: HKEY, value_name: &str) -> Option<u32> {
    let name_wide: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut value_type = REG_VALUE_TYPE::default();
    let mut buf = [0u8; 4];
    let mut size: u32 = buf.len() as u32;
    let query = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(name_wide.as_ptr()),
            None,
            Some(&mut value_type),
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        )
    };
    if query.is_err() {
        return None;
    }
    Some(u32::from_ne_bytes(buf))
}

/// `DisplayIcon` is typically `"C:\Path\App.exe,0"` (a resource index
/// suffix) or occasionally a bare `.ico` path - only the `.exe` form is
/// useful as a capture-target/metadata source.
fn resolve_exe_from_display_icon(raw: &str) -> Option<String> {
    let path = raw
        .rsplit_once(',')
        .map_or(raw, |(path, _index)| path)
        .trim()
        .trim_matches('"');
    if path.to_lowercase().ends_with(".exe") && Path::new(path).is_file() {
        Some(path.to_string())
    } else {
        None
    }
}

fn extract_quoted_exe(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let candidate = if let Some(stripped) = raw.strip_prefix('"') {
        stripped.split('"').next().unwrap_or("")
    } else {
        raw.split_whitespace().next().unwrap_or("")
    };
    if candidate.to_lowercase().ends_with(".exe") && Path::new(candidate).is_file() {
        Some(candidate.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A binary guaranteed to exist on every Windows install, with a real
    /// `FileDescription` version resource and icon - used to sanity-check
    /// the metadata/icon extraction pipeline end to end.
    const NOTEPAD_PATH: &str = r"C:\Windows\System32\notepad.exe";

    #[test]
    fn resolves_metadata_for_a_known_system_binary() {
        let metadata = resolve_app_metadata(NOTEPAD_PATH);
        println!("notepad.exe -> name: {:?}", metadata.name);
        assert!(!metadata.name.trim().is_empty(), "expected a non-empty resolved name");

        match &metadata.icon_base64 {
            Some(icon) => {
                println!("notepad.exe -> icon length: {} bytes", icon.len());
                assert!(icon.starts_with("data:image/png;base64,"), "icon should be a PNG data URL");
            }
            None => panic!("expected an icon to be extracted for notepad.exe"),
        }
    }

    #[test]
    fn get_exe_metadata_rejects_a_missing_file() {
        let result = get_exe_metadata(r"C:\this\path\does\not\exist.exe".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn title_case_fallback_matches_the_documented_example() {
        assert_eq!(title_case_from_filename(r"C:\Games\my_app.exe"), "My App");
    }

    #[test]
    fn title_case_fallback_preserves_existing_pascal_case() {
        assert_eq!(title_case_from_filename(r"C:\Apps\GitHubDesktop.exe"), "GitHubDesktop");
        assert_eq!(title_case_from_filename(r"C:\Windows\TextInputHost.exe"), "TextInputHost");
    }

    #[test]
    fn active_applications_are_deduplicated_and_exclude_self() {
        let current_pid = std::process::id();
        let apps = get_active_applications();
        println!("found {} active application(s):", apps.len());
        for app in &apps {
            println!(
                "  - {} ({}) [icon: {}]",
                app.name,
                app.exe_path,
                app.icon_base64.is_some()
            );
        }

        let mut seen = HashSet::new();
        for app in &apps {
            assert!(
                seen.insert(app.exe_path.to_lowercase()),
                "duplicate exe path in get_active_applications: {}",
                app.exe_path
            );
            assert_ne!(
                app.exe_path.to_lowercase(),
                std::env::current_exe().unwrap().display().to_string().to_lowercase(),
                "own process should never appear in get_active_applications"
            );
        }
        let _ = current_pid;
    }

    #[test]
    fn installed_applications_scan_finds_real_entries_with_valid_paths() {
        let apps = get_installed_applications();
        println!("found {} installed application(s) via the registry scan", apps.len());
        assert!(!apps.is_empty(), "expected at least one installed application on a real Windows machine");

        for app in apps.iter().take(10) {
            println!("  - {} -> {}", app.name, app.exe_path);
            assert!(Path::new(&app.exe_path).is_file(), "resolved exe path should exist: {}", app.exe_path);
            assert!(!app.name.trim().is_empty());
        }
    }
}
