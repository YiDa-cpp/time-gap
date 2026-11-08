import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * M0：仅负责关闭按钮。
 * 拖拽由 index.html 中的 data-tauri-drag-region 交给 Tauri 处理，
 * 事件监听留在后续里程碑（M1）实现。
 */
function bindCloseButton(): void {
  const closeButton = document.querySelector<HTMLButtonElement>("#close-btn");
  if (!closeButton) return;

  closeButton.addEventListener("click", async (event) => {
    event.stopPropagation();
    await getCurrentWindow().close();
  });
}

window.addEventListener("DOMContentLoaded", bindCloseButton);
