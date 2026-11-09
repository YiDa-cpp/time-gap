// 时隙 TimeGap · Rust 侧保持极薄：只负责创建窗口，业务逻辑全部在前端
#![cfg_attr(mobile, tauri::mobile_entry_point)]

pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
