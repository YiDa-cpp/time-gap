// 时隙 TimeGap · Rust 侧保持极薄：
// 窗口与托盘、会话落盘、开机自启，业务逻辑全部在前端。
#![cfg_attr(mobile, tauri::mobile_entry_point)]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WindowEvent};

const TRAY_ID: &str = "timegap-tray";
const MENU_ID_SHOW: &str = "tray-show";
const MENU_ID_QUIT: &str = "tray-quit";
const AUTOSTART_KEY: &str = "TimeGap";

/* ============================================================
   会话记录
   ============================================================ */

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub start: String,
    pub end: String,
    pub duration_sec: u64,
    pub subject: String,
    pub completed: bool,
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;

    fs::create_dir_all(&dir).map_err(|error| format!("无法创建数据目录: {error}"))?;

    Ok(dir)
}

fn sessions_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("sessions.json"))
}

fn read_sessions(path: &PathBuf) -> Vec<Session> {
    // 文件不存在或内容损坏时一律降级为空列表，绝不让启动失败
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
fn load_sessions(app: tauri::AppHandle) -> Result<Vec<Session>, String> {
    let path = sessions_path(&app)?;
    Ok(read_sessions(&path))
}

#[tauri::command]
fn save_session(app: tauri::AppHandle, session: Session) -> Result<(), String> {
    let path = sessions_path(&app)?;

    let mut sessions = read_sessions(&path);
    sessions.push(session);

    let json =
        serde_json::to_string_pretty(&sessions).map_err(|error| format!("序列化失败: {error}"))?;

    // 原子写：先写临时文件，再 rename 覆盖（Windows 下 rename 会替换已存在文件）
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|error| format!("写入临时文件失败: {error}"))?;
    fs::rename(&tmp, &path).map_err(|error| format!("替换数据文件失败: {error}"))?;

    Ok(())
}

#[tauri::command]
fn clear_sessions(app: tauri::AppHandle) -> Result<(), String> {
    let path = sessions_path(&app)?;

    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // 文件本来就不存在，视为已清空
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清空数据失败: {error}")),
    }
}

/* ============================================================
   窗口位置与尺寸记忆
   ============================================================ */

#[derive(Serialize, Deserialize, Clone, Debug)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn window_state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("window.json"))
}

/// 前端只在「普通布局」下调用，胶囊态与全屏态不会覆盖这份数据
#[tauri::command]
fn save_window_state(window: tauri::WebviewWindow) -> Result<(), String> {
    let position = window
        .outer_position()
        .map_err(|error| format!("读取窗口位置失败: {error}"))?;
    let size = window
        .outer_size()
        .map_err(|error| format!("读取窗口尺寸失败: {error}"))?;

    let state = WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };

    let path = window_state_path(&window.app_handle().clone())?;
    let json =
        serde_json::to_string_pretty(&state).map_err(|error| format!("序列化失败: {error}"))?;

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|error| format!("写入临时文件失败: {error}"))?;
    fs::rename(&tmp, &path).map_err(|error| format!("替换窗口状态失败: {error}"))?;

    Ok(())
}

/// 启动时恢复；若保存的位置已不在任何显示器内，退回居中
fn restore_window_state(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Ok(path) = window_state_path(app) else {
        return;
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(state) = serde_json::from_str::<WindowState>(&raw) else {
        return;
    };

    let center_x = state.x + state.width as i32 / 2;
    let center_y = state.y + state.height as i32 / 2;

    let still_visible = window
        .available_monitors()
        .map(|monitors| {
            monitors.iter().any(|monitor| {
                let origin = monitor.position();
                let size = monitor.size();
                center_x >= origin.x
                    && center_x <= origin.x + size.width as i32
                    && center_y >= origin.y
                    && center_y <= origin.y + size.height as i32
            })
        })
        .unwrap_or(false);

    if still_visible {
        let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
        let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    } else {
        let _ = window.center();
    }
}

/* ============================================================
   托盘与「关闭即隐藏」
   ============================================================ */

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, MENU_ID_SHOW, "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_ID_QUIT, "彻底退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("时隙 TimeGap")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_ID_QUIT => app.exit(0),
            MENU_ID_SHOW => show_main_window(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/* ============================================================
   开机自启（Windows 注册表 Run 键，无额外依赖）
   ============================================================ */

#[cfg(windows)]
fn reg_command() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = std::process::Command::new("reg");
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[tauri::command]
fn is_autostart_enabled() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let status = reg_command()
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                AUTOSTART_KEY,
            ])
            .status()
            .map_err(|error| format!("查询开机自启失败: {error}"))?;
        Ok(status.success())
    }

    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let run_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

        if enabled {
            let exe = std::env::current_exe().map_err(|error| format!("定位程序失败: {error}"))?;
            let value = format!("\"{}\" --autostart", exe.display());
            let status = reg_command()
                .args([
                    "add", run_key, "/v", AUTOSTART_KEY, "/t", "REG_SZ", "/d", &value, "/f",
                ])
                .status()
                .map_err(|error| format!("写入开机自启失败: {error}"))?;

            if status.success() {
                Ok(())
            } else {
                Err("写入注册表失败".into())
            }
        } else {
            // 值不存在时 reg delete 会返回非零，这里视为「已经是关闭状态」
            let _ = reg_command()
                .args(["delete", run_key, "/v", AUTOSTART_KEY, "/f"])
                .status();
            Ok(())
        }
    }

    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("开机自启目前仅支持 Windows".into())
    }
}

/* ============================================================
   壁纸文件夹
   ============================================================ */

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);

    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }

    out
}

fn is_wallpaper_file(path: &std::path::Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png"))
            .unwrap_or(false)
}

#[tauri::command]
fn list_wallpapers(dir: String) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(&dir).map_err(|error| format!("无法读取文件夹: {error}"))?;

    let mut files: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| is_wallpaper_file(path))
        .map(|path| path.to_string_lossy().to_string())
        .collect();

    files.sort();
    Ok(files)
}

#[tauri::command]
fn read_wallpaper(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|error| format!("读取图片失败: {error}"))?;

    if bytes.len() > 16 * 1024 * 1024 {
        return Err("图片超过 16MB".into());
    }

    let is_png = path.to_ascii_lowercase().ends_with(".png");
    let mime = if is_png { "image/png" } else { "image/jpeg" };

    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[tauri::command]
fn pick_wallpaper_folder() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let script = "Add-Type -AssemblyName System.Windows.Forms; \
                      $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; \
                      $dialog.Description = '选择壁纸文件夹'; \
                      if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { \
                        Write-Output $dialog.SelectedPath }";

        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-STA", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("打开文件夹选择器失败: {error}"))?;

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    }

    #[cfg(not(windows))]
    {
        Err("暂仅支持 Windows".into())
    }
}

/* ============================================================
   启动
   ============================================================ */

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_sessions,
            save_session,
            clear_sessions,
            save_window_state,
            is_autostart_enabled,
            set_autostart,
            list_wallpapers,
            read_wallpaper,
            pick_wallpaper_folder
        ])
        .setup(|app| {
            // 开机自启时以 --autostart 启动：直接静默进托盘，不弹窗、不抢焦点
            let launched_by_autostart = std::env::args().any(|arg| arg == "--autostart");

            if let Some(window) = app.get_webview_window("main") {
                // 右上角 X 不退出进程，改为隐藏到托盘
                let handle = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = handle.hide();
                    }
                });

                restore_window_state(app.handle(), &window);

                if !launched_by_autostart {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }

            setup_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
