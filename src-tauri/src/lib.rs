// 时隙 TimeGap · Rust 侧保持极薄：
// 只负责窗口创建与会话记录的原子落盘，业务逻辑全部在前端。
#![cfg_attr(mobile, tauri::mobile_entry_point)]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// 一次完成的专注会话
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub start: String,
    pub end: String,
    pub duration_sec: u64,
    pub subject: String,
    pub completed: bool,
}

fn sessions_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;

    fs::create_dir_all(&dir).map_err(|error| format!("无法创建数据目录: {error}"))?;

    Ok(dir.join("sessions.json"))
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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_sessions,
            save_session,
            clear_sessions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
